import { StringEnum } from '@earendil-works/pi-ai'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
  type ThemeColor,
  type ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent'
import { Text, isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth } from '@earendil-works/pi-tui'
import { Data, Effect, Function } from 'effect'
import { type Static, Type } from 'typebox'
import { Check } from 'typebox/value'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { runningAgents } from '@/shared/state/agent_activity.js'
import { isEmptyString, isNotEmptyString, isNotNullOrUndefined, isNullOrUndefined, isTrue } from '@/shared/utils/predicates.js'
import { truncateOutput, truncationNotice } from '@/shared/utils/tool_output.js'

import {
  AgentCompletionEventSchema,
  AgentManager,
  type AgentCompletionEvent,
  type AgentInactivityEvent,
  type AgentInfo,
  type AgentListEntry,
  type AgentManagerOptions,
  writeFullToolOutput,
} from './core.js'
import { SubagentPeekOverlay } from './peek.js'
import { AGENT_PROFILE_NAMES, configuredProfileColor, getAgentProfilesDescription, persistedProfileColor } from './profiles.js'

const WaitAgentDetailsSchema = Type.Object({
  event: Type.Optional(AgentCompletionEventSchema),
  message: Type.Optional(Type.String()),
})

const textResult = <TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> => ({
  content: [{ text, type: 'text' as const }],
  details,
})

interface BoundedText {
  text: string
  fullOutputPath?: string
  truncated?: true
}

class SubagentFeatureError extends Data.TaggedError('SubagentFeatureError')<{
  readonly cause: unknown
  readonly message: string
}> {}

const featureError = (message: string, cause: unknown): SubagentFeatureError => new SubagentFeatureError({ cause, message })

const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

class SubagentWaitError extends Data.TaggedError('SubagentWaitError')<{
  readonly aborted: boolean
  readonly cause: unknown
  readonly message: string
}> {}

const waitError = (operation: string, aborted: boolean, cause: unknown): SubagentWaitError =>
  new SubagentWaitError({ aborted, cause, message: aborted ? causeMessage(cause) : `${operation} failed: ${causeMessage(cause)}` })

const preserveWaitCancellation = <Result>(promise: Promise<Result>): Promise<Result> =>
  promise.catch((error: unknown) => Promise.reject(error instanceof SubagentWaitError && error.aborted ? error.cause : error))

const boundedText = (text: string, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES): BoundedText => {
  const initial = truncateOutput(text, { maxBytes, maxLines })
  if (!initial.truncated) {
    return { text }
  }
  const fullOutputPath = writeFullToolOutput(text)
  const truncation = truncateOutput(text, {
    maxBytes: maxBytes - 2048,
    maxLines: maxLines - 4,
  })
  return {
    fullOutputPath,
    text: truncation.content + truncationNotice(truncation, { fullOutputPath }),
    truncated: true,
  }
}

const boundedTextResult = <TDetails extends Record<string, unknown>>(
  text: string,
  details: TDetails
): AgentToolResult<TDetails & { fullOutputPath?: string; truncated?: true }> => {
  const bounded = boundedText(text)
  if (!isTrue(bounded.truncated)) {
    return textResult(bounded.text, details)
  }
  return textResult(bounded.text, {
    ...details,
    fullOutputPath: bounded.fullOutputPath,
    truncated: true,
  })
}

const cleanTarget = (target: string): string => target.trim().replace(/^\/+/, '')

const parseTargets = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.map((target) => cleanTarget(String(target))).filter(Boolean) : undefined

const parentSessionId = (ctx: ExtensionContext): string => {
  const id = ctx.sessionManager.getSessionId()
  if (isNullOrUndefined(id) || isEmptyString(id)) {
    throw new Error('The parent Pi session has no session id.')
  }
  return id
}

const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}

const runtimeLabel = (info: AgentInfo): string => {
  const start = info.startedAt === undefined || info.startedAt === 0 ? info.createdAt : info.startedAt
  const final = ['completed', 'failed', 'interrupted'].includes(info.status)
  let end = Date.now()
  if (final) {
    if (info.completedAt !== undefined && info.completedAt !== 0) {
      end = info.completedAt
    } else if (info.updatedAt !== undefined && info.updatedAt !== 0) {
      end = info.updatedAt
    }
  }
  return formatDuration(end - start)
}

/** Tool results are rendered from the same shape `execute()` returns; some hosts add `isError`. */
type RenderableToolResult<TDetails> = AgentToolResult<TDetails> & { isError?: boolean }

interface CompletionMessageDetails {
  agent_name: string
  status: string
  profile?: string
  color: ThemeColor
  is_readonly?: boolean
  fullOutputPath?: string
}

const DELEGATION_GUIDANCE = `

## Subagent delegation

Subagents are available through \`spawn_agent\`. Prefer delegation over pulling context-heavy work into the parent:

- Delegate read-heavy exploration, research, log triage, and review. Give each child one narrow, self-contained task with the relevant paths and expected answer shape.
- Foreground is the default: use it when the delegated result is needed before your next step or when you would otherwise inspect the same files or question. Set \`run_in_background: true\` only for clearly independent work.
- Never repeat a pending child's files, symbols, or question in the parent. After a background spawn, continue only with clearly non-overlapping work; call \`wait_agent\`/\`wait_all_agents\` if the next action would overlap.
- Parallelize independent questions, but keep Claude-backed children to at most three live agents. Prefer Claude for short research and review tasks.
- Prefer spawning a fresh child over repeatedly steering an existing one. Each logical agent accepts at most one \`send_message\` follow-up; Claude continuations are refused at 112k context input tokens.
- Use \`reviewer\` for a fresh-context check of a plan or finished change.

Keep work in your own context when it depends on conversation history that is expensive to restate or when the user is waiting on one quick answer. Available profiles: ${AGENT_PROFILE_NAMES.join(', ')}.`

type PiExtensionContext = ExtensionContext | ExtensionCommandContext

const registerImpl = (pi: ExtensionAPI, runtime: AppRuntime, managerOptions: AgentManagerOptions = {}): void => {
  const completionMessageType = 'pi-codex-subagent-completion'
  let activeContext: PiExtensionContext | undefined
  const activeAgents = new Map<string, { profile?: string; color: ThemeColor }>()
  let terminalUnsubscribe: (() => void) | undefined

  const unsubscribeTerminal = (): void => {
    terminalUnsubscribe?.()
    terminalUnsubscribe = undefined
  }
  const isCurrentSession = (parentId: string) => {
    try {
      return activeContext !== undefined && parentSessionId(activeContext) === parentId
    } catch {
      return false
    }
  }

  const publishAgentActivity = () => {
    runningAgents.publish([...activeAgents.entries()].map(([name, metadata]) => ({ name, ...metadata })))
  }

  const deliverCompletion = (event: AgentCompletionEvent) => {
    if (!isCurrentSession(event.parentSessionId)) {
      return
    }
    const payload = JSON.stringify(
      {
        agent_name: event.agentName,
        status: event.status,
        ...(event.finalResponse === undefined ? {} : { final_response: event.finalResponse }),
        ...(isNullOrUndefined(event.error) || isEmptyString(event.error) ? {} : { error: event.error }),
        ...(isNullOrUndefined(event.profile) || isEmptyString(event.profile) ? {} : { profile: event.profile }),
        color: event.color,
        ...(event.isReadonly === undefined ? {} : { is_readonly: event.isReadonly }),
      },
      undefined,
      2
    )
    const bounded = boundedText(payload, DEFAULT_MAX_BYTES - 1024, DEFAULT_MAX_LINES - 4)
    pi.sendMessage(
      {
        content: `<subagent_notification>\n${bounded.text}\n</subagent_notification>`,
        customType: completionMessageType,
        details: {
          agent_name: event.agentName,
          status: event.status,
          ...(isNullOrUndefined(event.profile) || isEmptyString(event.profile) ? {} : { profile: event.profile }),
          color: event.color,
          ...(event.isReadonly === undefined ? {} : { is_readonly: event.isReadonly }),
          ...(isNullOrUndefined(bounded.fullOutputPath) || isEmptyString(bounded.fullOutputPath) ? {} : { fullOutputPath: bounded.fullOutputPath }),
        },
        display: true,
      },
      { deliverAs: 'steer', triggerTurn: true }
    )
  }

  const deliverInactivity = (event: AgentInactivityEvent) => {
    if (!isCurrentSession(event.parentSessionId)) {
      return
    }
    const payload = JSON.stringify(
      {
        agent_name: event.agentName,
        inactive_for_ms: event.inactiveForMs,
        last_activity: new Date(event.lastActivity).toISOString(),
        message: `${event.agentName} has produced no activity for ${formatDuration(event.inactiveForMs)}. Check its progress and steer or interrupt it if needed.`,
        status: 'inactive',
      },
      undefined,
      2
    )
    pi.sendMessage(
      {
        content: `<subagent_notification>\n${payload}\n</subagent_notification>`,
        customType: completionMessageType,
        details: {
          agent_name: event.agentName,
          status: 'inactive',
          ...(isNullOrUndefined(event.profile) || isEmptyString(event.profile) ? {} : { profile: event.profile }),
          color: event.color,
          ...(event.isReadonly === undefined ? {} : { is_readonly: event.isReadonly }),
        },
        display: true,
      },
      { deliverAs: 'steer', triggerTurn: true }
    )
  }

  const manager = new AgentManager({
    ...managerOptions,
    onActivityChange: (event) => {
      if (!isCurrentSession(event.parentSessionId)) {
        return
      }
      if (event.active) {
        activeAgents.set(event.agentName, { color: event.color, profile: event.profile })
      } else {
        activeAgents.delete(event.agentName)
      }
      publishAgentActivity()
    },
    onInactivity: deliverInactivity,
    onUnclaimedCompletion: deliverCompletion,
  })

  const registerEscapeInterrupt = (ctx: PiExtensionContext): void => {
    unsubscribeTerminal()
    if (ctx.mode !== 'tui') {
      return
    }
    terminalUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (isKeyRelease(data) || isKeyRepeat(data) || !matchesKey(data, 'escape') || !ctx.isIdle() || activeAgents.size === 0) {
        return undefined
      }
      let currentParentId: string
      try {
        currentParentId = parentSessionId(ctx)
      } catch {
        return undefined
      }
      const targets = [...activeAgents.keys()]
      void Promise.all(targets.map((target) => manager.interruptAgent(currentParentId, target))).catch((error: unknown) => {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      })
      return { consume: true }
    })
  }

  const colorForTarget = (target: string): ThemeColor => {
    if (activeContext === undefined) {
      return 'muted'
    }
    try {
      const info = manager.getAgentInfo(cleanTarget(target), parentSessionId(activeContext))
      return persistedProfileColor(info.profile, info.color)
    } catch {
      return 'muted'
    }
  }

  const coloredTargets = (targets: string[], theme: Theme): string => targets.map((target) => theme.fg(colorForTarget(target), target)).join(',')

  pi.registerMessageRenderer<CompletionMessageDetails>(completionMessageType, (message, { expanded }, theme) => {
    const status = message.details?.status
    let statusColor: ThemeColor
    if (status === 'completed') {
      statusColor = 'success'
    } else if (status === 'failed') {
      statusColor = 'error'
    } else {
      statusColor = 'warning'
    }
    const identityColor = persistedProfileColor(message.details?.profile, message.details?.color)
    let icon = '✗'
    if (status === 'completed') {
      icon = '✓'
    } else if (status === 'inactive') {
      icon = '!'
    }
    let text =
      theme.fg(statusColor, `${icon} `) +
      theme.fg(identityColor, message.details?.agent_name || 'subagent') +
      theme.fg(statusColor, ` ${status || 'finished'}`)
    if (expanded && typeof message.content === 'string') {
      text += `\n${theme.fg('dim', message.content)}`
    }
    return new Text(text, 0, 0)
  })

  const spawnAgentParameters = Type.Object({
    agent_type: StringEnum(AGENT_PROFILE_NAMES, {
      description: 'Required source-defined agent profile.',
    }),
    message: Type.String({ description: 'Initial task for the new agent.' }),
    run_in_background: Type.Optional(
      Type.Boolean({
        description:
          'Run concurrently only when the parent has clearly independent work. Defaults to false, which waits and returns the final response.',
      })
    ),
    task_name: Type.String({
      description: 'Task name for the new agent. Use letters, digits, underscores, dashes, and optional slash path separators.',
    }),
  })
  type SpawnAgentParams = Static<typeof spawnAgentParameters>
  type SpawnAgentResultDetails = Awaited<ReturnType<AgentManager['spawnAgent']>>

  const spawnAgentTool = {
    get description() {
      return `Spawn a fresh-context Pi subagent using a required source-defined profile. Give it one narrow, self-contained task. Children rediscover configured global and project extensions normally while skills, prompt templates, and context files remain isolated. Each profile fixes its model, thinking level, prompt, read-only metadata, and model-callable tool boundary.

Foreground is the default: use it when the delegated result is needed before your next step. Set \`run_in_background\` only for clearly independent work. Never repeat a pending child's files, symbols, or question in the parent; wait if work would overlap. Claude-backed children are limited to three live agents and cannot be continued at 112k context input tokens. Prefer a fresh child to steering; each logical agent accepts one \`send_message\` follow-up.

Available agent profiles:
${getAgentProfilesDescription()}`
    },
    execute(
      _toolCallId: string,
      params: SpawnAgentParams,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<SpawnAgentResultDetails> | undefined,
      ctx: ExtensionContext
    ) {
      const operation = runtime.runPromise(
        Effect.gen(function* () {
          const currentModel = ctx.model
          if (
            isNullOrUndefined(currentModel?.provider) ||
            isEmptyString(currentModel.provider) ||
            isNullOrUndefined(currentModel.id) ||
            isEmptyString(currentModel.id)
          ) {
            return yield* featureError('spawn_agent failed: the parent has no active provider/model pair.', undefined)
          }
          const availableModels = ctx.modelRegistry.getAvailable()
          if (!Array.isArray(availableModels)) {
            return yield* featureError('spawn_agent failed: authenticated model availability is unavailable.', undefined)
          }
          const runInBackground = params.run_in_background === true
          const result = yield* Effect.tryPromise({
            catch: (cause) => featureError(`spawn_agent failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
            try: () =>
              manager.spawnAgent(
                {
                  agent_type: params.agent_type,
                  availableModels: availableModels.map((model) => ({
                    id: model.id,
                    provider: model.provider,
                  })),
                  cwd: ctx.cwd,
                  message: params.message,
                  parentModel: { id: currentModel.id, provider: currentModel.provider },
                  parentSessionFile: ctx.sessionManager.getSessionFile(),
                  parentSessionId: parentSessionId(ctx),
                  task_name: params.task_name,
                },
                { signal, waitForCompletion: !runInBackground }
              ),
          })
          if (runInBackground) {
            return textResult(
              `Spawned ${result.task_name} in background. Do not duplicate its task; continue only with clearly independent work.`,
              result
            )
          }
          if (result.completion === undefined) {
            return yield* featureError('spawn_agent failed: foreground completion was not returned.', undefined)
          }
          return boundedTextResult(JSON.stringify(result.completion, undefined, 2), { ...result })
        })
      )
      return operation.catch((error: unknown) => {
        if (isTrue(signal?.aborted) && error instanceof SubagentFeatureError && error.cause === signal.reason) {
          return Promise.reject(error.cause)
        }
        return Promise.reject(error)
      })
    },
    label: 'Spawn Agent',
    name: 'spawn_agent',
    parameters: spawnAgentParameters,
    renderCall(args: SpawnAgentParams, theme: Theme) {
      const execution = args.run_in_background === true ? 'background' : 'foreground'
      return new Text(
        theme.fg('toolTitle', theme.bold('spawn_agent ')) +
          theme.fg('text', isEmptyString(args.task_name) ? '?' : args.task_name) +
          theme.fg(configuredProfileColor(args.agent_type), ` [${args.agent_type}]`) +
          theme.fg('muted', ` [${execution}]`),
        0,
        0
      )
    },
    renderResult(result: RenderableToolResult<SpawnAgentResultDetails>, _options: ToolRenderResultOptions, theme: Theme) {
      if (isTrue(result.isError)) {
        const [firstContent] = result.content
        const failureText = firstContent?.type === 'text' ? firstContent.text : 'failed'
        return new Text(theme.fg('error', `✗ ${failureText}`), 0, 0)
      }
      const completion = result.details?.completion
      if (result.details?.execution === 'foreground' && completion !== undefined) {
        let statusColor: ThemeColor = 'warning'
        if (completion.status === 'completed') {
          statusColor = 'success'
        } else if (completion.status === 'failed') {
          statusColor = 'error'
        }
        return new Text(
          theme.fg(statusColor, completion.status === 'completed' ? '✓ ' : '✗ ') +
            theme.fg(persistedProfileColor(completion.profile, completion.color), completion.agentName) +
            theme.fg(statusColor, ` ${completion.status}`),
          0,
          0
        )
      }
      return new Text(
        theme.fg('success', '✓ ') +
          theme.fg(persistedProfileColor(result.details?.profile, result.details?.color), result.details?.task_name || 'spawned') +
          theme.fg('muted', ' background'),
        0,
        0
      )
    },
  }

  pi.on('session_start', (_event, ctx) =>
    runtime.runPromise(
      Effect.gen(function* () {
        unsubscribeTerminal()
        activeContext = ctx
        activeAgents.clear()
        yield* Effect.tryPromise({
          catch: (cause) => featureError(cause instanceof Error ? cause.message : String(cause), cause),
          try: () => manager.ready(),
        })
        if (activeContext !== ctx) {
          return
        }
        for (const entry of manager.listAgents(undefined, parentSessionId(ctx))) {
          if (entry.agent_status === 'starting' || entry.agent_status === 'running') {
            activeAgents.set(entry.agent_name, { color: entry.color, profile: entry.profile })
          }
        }
        publishAgentActivity()
        registerEscapeInterrupt(ctx)
      })
    )
  )

  pi.on('before_agent_start', (event) =>
    process.env.PI_SUBAGENT_OWNER_TOKEN === undefined ? { systemPrompt: event.systemPrompt + DELEGATION_GUIDANCE } : undefined
  )

  pi.on('session_shutdown', () =>
    runtime.runPromise(
      Effect.gen(function* () {
        activeContext = undefined
        activeAgents.clear()
        publishAgentActivity()
        unsubscribeTerminal()
        yield* Effect.tryPromise({
          catch: (cause) => featureError(cause instanceof Error ? cause.message : String(cause), cause),
          try: () => manager.shutdown(),
        })
      })
    )
  )

  pi.registerTool(spawnAgentTool)

  pi.registerTool({
    description:
      'Wait for one explicitly background agent completion, or for the next background completion if targets is omitted. Use when pending work is needed before the next step or would otherwise overlap. Returns one final response. Use wait_all_agents when every target must finish.',
    execute(_id: string, params, signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
      return preserveWaitCancellation(
        runtime.runPromise(
          Effect.tryPromise({
            catch: (cause) => waitError('wait_agent', isTrue(signal?.aborted), cause),
            try: async () => {
              const result = await manager.waitAgent(parentSessionId(ctx), parseTargets(params.targets), signal)
              return boundedTextResult(JSON.stringify(result, undefined, 2), {
                event: result.event,
                message: result.message,
              })
            },
          })
        )
      )
    },
    label: 'Wait Agent',
    name: 'wait_agent',
    parameters: Type.Object({
      targets: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Agent task names to wait on. Omit to wait for the next completion in this parent session.',
        })
      ),
    }),
    renderCall(args, theme: Theme) {
      const targets = Array.isArray(args.targets) && args.targets.length > 0 ? args.targets : []
      return new Text(
        theme.fg('toolTitle', theme.bold('wait_agent ')) + (targets.length > 0 ? coloredTargets(targets, theme) : theme.fg('muted', 'any')),
        0,
        0
      )
    },
    renderResult(result: RenderableToolResult<unknown>, _options: ToolRenderResultOptions, theme: Theme) {
      if (isTrue(result.isError)) {
        return new Text(theme.fg('error', '✗ wait failed'), 0, 0)
      }
      const details = Check(WaitAgentDetailsSchema, result.details) ? result.details : undefined
      const event = details?.event
      if (event === undefined) {
        return new Text(theme.fg('success', details?.message || 'done'), 0, 0)
      }
      let statusColor: ThemeColor
      if (event.status === 'completed') {
        statusColor = 'success'
      } else if (event.status === 'failed') {
        statusColor = 'error'
      } else {
        statusColor = 'warning'
      }
      return new Text(
        theme.fg(statusColor, event.status === 'completed' ? '✓ ' : '✗ ') +
          theme.fg(persistedProfileColor(event.profile, event.color), event.agentName) +
          theme.fg(statusColor, ` ${event.status}`),
        0,
        0
      )
    },
  })

  pi.registerTool({
    description:
      'Wait until all targeted explicitly background agents reach a final status. Use to synchronize background work before a dependent or overlapping next step. Returns their final text responses.',
    execute(_id: string, params, signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
      return preserveWaitCancellation(
        runtime.runPromise(
          Effect.tryPromise({
            catch: (cause) => waitError('wait_all_agents', isTrue(signal?.aborted), cause),
            try: async () => {
              const result = await manager.waitAllAgents(parentSessionId(ctx), parseTargets(params.targets), signal)
              return boundedTextResult(JSON.stringify(result, undefined, 2), {
                message: result.message,
                responses: result.responses,
              })
            },
          })
        )
      )
    },
    label: 'Wait All Agents',
    name: 'wait_all_agents',
    parameters: Type.Object({
      targets: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Agent task names to wait for. Omit to wait for agents spawned by this extension instance.',
        })
      ),
    }),
    renderCall(args, theme: Theme) {
      const targets = Array.isArray(args.targets) && args.targets.length > 0 ? args.targets : []
      return new Text(
        theme.fg('toolTitle', theme.bold('wait_all_agents ')) + (targets.length > 0 ? coloredTargets(targets, theme) : theme.fg('muted', 'all')),
        0,
        0
      )
    },
    renderResult(result: RenderableToolResult<{ message?: string }>, _options: ToolRenderResultOptions, theme: Theme) {
      if (isTrue(result.isError)) {
        return new Text(theme.fg('error', '✗ wait failed'), 0, 0)
      }
      return new Text(theme.fg('success', result.details?.message || 'done'), 0, 0)
    },
  })

  pi.registerTool({
    description:
      'List agents owned by the current parent session. Set include_all only for an explicit read-only historical listing across parent sessions.',
    execute(_id: string, params, _signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
      return runtime.runPromise(
        Effect.sync(() => {
          const agents = manager.listAgents(params.path_prefix, parentSessionId(ctx), isTrue(params.include_all))
          return boundedTextResult(JSON.stringify({ agents }, undefined, 2), { agents })
        })
      )
    },
    label: 'List Agents',
    name: 'list_agents',
    parameters: Type.Object({
      include_all: Type.Optional(
        Type.Boolean({
          description: 'Include agents from all parent sessions and show parent_session_id. Default false.',
        })
      ),
      path_prefix: Type.Optional(Type.String({ description: 'Task-path prefix filter without a trailing slash.' })),
    }),
    renderCall(_args, theme: Theme) {
      return new Text(theme.fg('toolTitle', theme.bold('list_agents')), 0, 0)
    },
    renderResult(result: RenderableToolResult<{ agents?: unknown[] }>, options: ToolRenderResultOptions, theme: Theme) {
      const agents = result.details?.agents || []
      if (!options.expanded) {
        return new Text(theme.fg('success', `✓ ${agents.length} agent${agents.length === 1 ? '' : 's'}`), 0, 0)
      }
      const [firstContent] = result.content
      const text = firstContent?.type === 'text' ? firstContent.text : undefined
      return new Text(text || JSON.stringify({ agents }, undefined, 2), 0, 0)
    },
  })

  pi.registerTool({
    description: "Read one current-session agent's latest final raw text response. Tool calls and intermediate assistant text are excluded.",
    execute(_id: string, params, _signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
      return runtime.runPromise(
        Effect.try({
          catch: (cause) => featureError(`read_agent_response failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
          try: () => {
            const result = manager.readAgentResponse(cleanTarget(params.target), parentSessionId(ctx))
            return boundedTextResult(JSON.stringify(result, undefined, 2), {
              agent_name: result.agent_name,
              color: result.color,
              is_readonly: result.is_readonly,
              profile: result.profile,
              status: result.status,
            })
          },
        })
      )
    },
    label: 'Read Agent Response',
    name: 'read_agent_response',
    parameters: Type.Object({
      target: Type.String({ description: 'Session-owned agent task name.' }),
    }),
    renderCall(args, theme: Theme) {
      return new Text(
        theme.fg('toolTitle', theme.bold('read_agent_response ')) + theme.fg(colorForTarget(args.target || ''), args.target || '?'),
        0,
        0
      )
    },
    renderResult(
      result: RenderableToolResult<{ profile?: string; color?: ThemeColor; agent_name?: string }>,
      _options: ToolRenderResultOptions,
      theme: Theme
    ) {
      if (isTrue(result.isError)) {
        return new Text(theme.fg('error', '✗ read failed'), 0, 0)
      }
      return new Text(
        theme.fg('success', '✓ ') +
          theme.fg(persistedProfileColor(result.details?.profile, result.details?.color), result.details?.agent_name || 'response'),
        0,
        0
      )
    },
  })

  pi.registerTool({
    description:
      'Send the single allowed follow-up to a session-owned agent. Steers the current run when active; otherwise starts one final turn. Prefer spawning a fresh agent for a distinct task.',
    execute(_id: string, params, _signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
      return runtime.runPromise(
        Effect.tryPromise({
          catch: (cause) => featureError(`send_message failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
          try: async () => {
            const result = await manager.sendMessage(parentSessionId(ctx), cleanTarget(params.target), params.message)
            const info = manager.getAgentInfo(cleanTarget(params.target), parentSessionId(ctx))
            return textResult(result.delivery === 'steer' ? 'Message steered into the running agent.' : 'Message started a new agent turn.', {
              ...result,
              color: persistedProfileColor(info.profile, info.color),
              is_readonly: info.isReadonly,
              profile: info.profile,
              target: params.target,
            })
          },
        })
      )
    },
    label: 'Send Message',
    name: 'send_message',
    parameters: Type.Object({
      message: Type.String({ description: 'Message text to send.' }),
      target: Type.String({ description: 'Session-owned agent task name.' }),
    }),
    renderCall(args, theme: Theme) {
      return new Text(theme.fg('toolTitle', theme.bold('send_message ')) + theme.fg(colorForTarget(args.target || ''), args.target || '?'), 0, 0)
    },
    renderResult(
      result: RenderableToolResult<{
        delivery?: 'steer' | 'prompt'
        profile?: string
        color?: ThemeColor
        target?: string
      }>,
      _options: ToolRenderResultOptions,
      theme: Theme
    ) {
      if (isTrue(result.isError)) {
        return new Text(theme.fg('error', '✗ send failed'), 0, 0)
      }
      return new Text(
        theme.fg('success', result.details?.delivery === 'steer' ? '✓ steered ' : '✓ started ') +
          theme.fg(persistedProfileColor(result.details?.profile, result.details?.color), result.details?.target || 'agent'),
        0,
        0
      )
    },
  })

  pi.registerTool({
    description: "Abort a session-owned agent's current turn while keeping its session available for its single send_message follow-up.",
    execute(_id: string, params, _signal: AbortSignal | undefined, _onUpdate, ctx: ExtensionContext) {
      return runtime.runPromise(
        Effect.tryPromise({
          catch: (cause) => featureError(`interrupt_agent failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
          try: async () => {
            const sessionId = parentSessionId(ctx)
            const target = cleanTarget(params.target)
            const result = await manager.interruptAgent(sessionId, target)
            const info = manager.getAgentInfo(target, sessionId)
            return textResult('Interrupt request handled.', {
              ...result,
              color: persistedProfileColor(info.profile, info.color),
              is_readonly: info.isReadonly,
              profile: info.profile,
              target: params.target,
            })
          },
        })
      )
    },
    label: 'Interrupt Agent',
    name: 'interrupt_agent',
    parameters: Type.Object({
      target: Type.String({ description: 'Session-owned agent task name.' }),
    }),
    renderCall(args, theme: Theme) {
      return new Text(theme.fg('toolTitle', theme.bold('interrupt_agent ')) + theme.fg(colorForTarget(args.target || ''), args.target || '?'), 0, 0)
    },
    renderResult(
      result: RenderableToolResult<{
        profile?: string
        color?: ThemeColor
        target?: string
        previous_status?: string
      }>,
      _options: ToolRenderResultOptions,
      theme: Theme
    ) {
      if (isTrue(result.isError)) {
        return new Text(theme.fg('error', '✗ interrupt failed'), 0, 0)
      }
      return new Text(
        theme.fg('warning', '↯ ') +
          theme.fg(persistedProfileColor(result.details?.profile, result.details?.color), result.details?.target || 'agent') +
          theme.fg('warning', ` previous: ${result.details?.previous_status || 'unknown'}`),
        0,
        0
      )
    },
  })

  interface OpenAgentOverlayOptions {
    ctx: PiExtensionContext
    task: string
    scopeId?: string
    includeAll?: boolean
  }

  const openAgentOverlay = async (options: OpenAgentOverlayOptions): Promise<void> => {
    const { ctx, task } = options
    const scopeId = options.scopeId ?? parentSessionId(ctx)
    const includeAll = options.includeAll ?? false
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Subagent views require interactive TUI mode.', 'warning')
      return
    }
    let info: AgentInfo
    try {
      info = manager.getAgentInfo(task, scopeId)
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      return
    }

    while (true) {
      const navigation = await ctx.ui.custom<'previous' | 'next' | undefined>(
        (tui, theme, _keybindings, done) =>
          new SubagentPeekOverlay({
            done,
            info,
            onEscape: () => {
              if (!ctx.isIdle()) {
                ctx.abort()
              }
            },
            theme,
            tui,
          }),
        {
          overlay: true,
          overlayOptions: {
            anchor: 'top-left',
            maxHeight: '100%',
            width: '100%',
          },
        }
      )
      if (navigation !== 'previous' && navigation !== 'next') {
        return
      }

      const currentSessionId = parentSessionId(ctx)
      const entries = manager.listAgents(undefined, currentSessionId, includeAll)
      if (entries.length < 2) {
        return
      }
      const currentIndex = entries.findIndex(
        (entry) => entry.agent_name === info.canonicalName && (entry.parent_session_id || currentSessionId) === info.parentSessionId
      )
      if (currentIndex === -1) {
        return
      }
      const offset = navigation === 'next' ? 1 : -1
      const next = entries[(currentIndex + offset + entries.length) % entries.length]
      info = manager.getAgentInfo(next.agent_name, next.parent_session_id || currentSessionId)
    }
  }

  interface PickedAgent {
    task: string
    parentSessionId: string
    includeAll: boolean
  }

  const pickAgent = async (ctx: PiExtensionContext): Promise<PickedAgent | undefined> => {
    const currentSessionId = parentSessionId(ctx)
    return await ctx.ui.custom<PickedAgent | undefined>((tui, theme, _keybindings, done) => {
      let selected = 0
      let showAll = false
      let cached: string[] | undefined
      const fg = theme.fg.bind(theme)
      const pageSize = 10
      const refresh = () => {
        cached = undefined
        tui.requestRender()
      }
      const agents = () => manager.listAgents(undefined, currentSessionId, showAll)
      const renderAgentRow = (entry: AgentListEntry, index: number, width: number): string[] => {
        const info = manager.getAgentInfo(entry.agent_name, entry.parent_session_id || currentSessionId)
        const pointer = index === selected ? fg('accent', '› ') : '  '
        const name = truncateToWidth(entry.agent_name, 28).padEnd(28)
        const sessionId = entry.parent_session_id || ''
        const parent = showAll ? ` ${sessionId.slice(-8)}` : ''
        let statusColor: ThemeColor
        if (entry.agent_status === 'failed') {
          statusColor = 'error'
        } else if (entry.agent_status === 'completed') {
          statusColor = 'success'
        } else {
          statusColor = 'warning'
        }
        const rowLines = [
          `${pointer}${fg(persistedProfileColor(info.profile, info.color), name)} ${fg(
            statusColor,
            entry.agent_status.padEnd(11)
          )} ${fg('dim', `${runtimeLabel(info)}${parent}`)}`,
        ]
        if (isNotNullOrUndefined(entry.last_task_message) && isNotEmptyString(entry.last_task_message)) {
          rowLines.push(`  ${fg('dim', truncateToWidth(entry.last_task_message.replaceAll(/\s+/g, ' '), Math.max(20, width - 4)))}`)
        }
        return rowLines
      }
      return {
        handleInput(data: string) {
          const entries = agents()
          if (matchesKey(data, 'escape') || data === 'q') {
            done(undefined)
            return
          }
          if (matchesKey(data, 'tab') || data === '\t') {
            showAll = !showAll
            selected = 0
            refresh()
            return
          }
          if (data === 'r') {
            refresh()
            return
          }
          if (matchesKey(data, 'down') || data === 'j') {
            selected = Math.min(entries.length - 1, selected + 1)
            refresh()
            return
          }
          if (matchesKey(data, 'up') || data === 'k') {
            selected = Math.max(0, selected - 1)
            refresh()
            return
          }
          if (matchesKey(data, 'return') && entries[selected] !== undefined) {
            done({
              includeAll: showAll,
              parentSessionId: entries[selected].parent_session_id || currentSessionId,
              task: entries[selected].agent_name,
            })
          }
        },
        invalidate() {
          cached = undefined
        },
        render(width: number): string[] {
          if (cached !== undefined) {
            return cached
          }
          const entries = agents()
          if (selected >= entries.length) {
            selected = Math.max(0, entries.length - 1)
          }
          const scopeLabel = showAll ? 'all sessions' : 'this session'
          const lines = [
            fg('accent', '─'.repeat(width)),
            fg('accent', theme.bold(' Subagents')) + fg('dim', ` (${entries.length}, ${scopeLabel})`),
            '',
          ]
          if (entries.length === 0) {
            lines.push(fg('dim', showAll ? 'No subagents found.' : 'No subagents for this session. Press tab to show all.'))
          }
          const viewStart = entries.length > pageSize ? Math.max(0, Math.min(selected - Math.floor(pageSize / 2), entries.length - pageSize)) : 0
          const viewEnd = Math.min(viewStart + pageSize, entries.length)
          if (viewStart > 0) {
            lines.push(fg('dim', `  ↑ ${viewStart} more`))
          }
          for (let index = viewStart; index < viewEnd; index++) {
            lines.push(...renderAgentRow(entries[index], index, width))
          }
          if (viewEnd < entries.length) {
            lines.push(fg('dim', `  ↓ ${entries.length - viewEnd} more`))
          }
          lines.push('', fg('dim', 'enter: open  tab: this/all sessions  r: refresh  q/esc: close'))
          cached = lines
          return lines
        },
      }
    })
  }

  pi.registerCommand('subagent', {
    description: 'Browse subagents, or open one directly. Usage: /subagent [task-name]',
    handler: async (args, ctx) => {
      const task = args?.trim().replace(/^\//, '')
      if (isNotNullOrUndefined(task) && isNotEmptyString(task)) {
        await openAgentOverlay({ ctx, task })
        return
      }
      const selected = await pickAgent(ctx)
      if (selected !== undefined) {
        await openAgentOverlay({
          ctx,
          includeAll: selected.includeAll,
          scopeId: selected.parentSessionId,
          task: selected.task,
        })
      }
    },
  })

  const browseAgents = async (ctx: PiExtensionContext): Promise<void> => {
    const selected = await pickAgent(ctx)
    if (selected !== undefined) {
      await openAgentOverlay({
        ctx,
        includeAll: selected.includeAll,
        scopeId: selected.parentSessionId,
        task: selected.task,
      })
    }
  }

  pi.registerCommand('agents', {
    description: 'Browse subagents',
    handler: async (_args, ctx) => browseAgents(ctx),
  })

  pi.registerCommand('subagents', {
    description: 'Browse subagents',
    handler: async (_args, ctx) => browseAgents(ctx),
  })
}

export const register: {
  (runtime: AppRuntime, managerOptions?: AgentManagerOptions): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime, managerOptions?: AgentManagerOptions): void
} = Function.dual((args) => typeof args[0].on === 'function', registerImpl)
