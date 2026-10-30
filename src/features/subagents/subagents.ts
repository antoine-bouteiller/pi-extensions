import { fileURLToPath } from 'node:url'

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Effect, Exit, Fiber, Schema, Scope, Semaphore } from 'effect'
import { SecureRandom } from 'effect/crypto/SecureRandom'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'

import {
  AgentCwdParam,
  AgentMessageParam,
  AgentModelParam,
  type AgentModelSettingsLoader,
  AgentNameParam,
  AgentThinkingParam,
  availableAgentModels,
  checkAgentMessage,
  loadAgentModelSettings,
  requireAllowedModel,
  resolveAgentDirectory,
  splitAgentModel,
} from '#shared/effect/agent_models'
import { type EnvApi } from '#shared/effect/env'
import { truncateOutput, truncationNotice } from '#shared/utils/tool_output'

import { type RpcChild, type RpcCommand, startRpc } from './rpc.js'

export const SpawnAgentParams = Type.Object({
  cwd: Type.Optional(
    AgentCwdParam(
      'Directory for the child, only when the user asks to work in another folder or project: absolute, ~/-relative, or relative to the current directory.'
    )
  ),
  message: AgentMessageParam,
  model: AgentModelParam,
  name: Type.Optional(AgentNameParam('Short label shown in result notifications and child dialogs, for example "Review auth".')),
  thinking: Type.Optional(AgentThinkingParam),
  tools: Type.Optional(
    Type.Array(Type.String({ maxLength: 64, pattern: '^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$' }), {
      description: 'Tool allowlist for the child, for example ["read","grep","find","ls"] for read-only work. Omit to keep all tools.',
      maxItems: 64,
      minItems: 1,
    })
  ),
})
export const SendMessageParams = Type.Object({ agent_id: Type.String({ minLength: 1 }), message: AgentMessageParam })
export const AgentParams = Type.Object({ agent_id: Type.String({ minLength: 1 }) })
export const ListAgentsParams = Type.Object({})

const AssistantEndSchema = Type.Object({
  message: Type.Object({
    content: Type.Union([Type.String(), Type.Array(Type.Object({ text: Type.Optional(Type.String()), type: Type.String() }))]),
    errorMessage: Type.Optional(Type.String()),
    role: Type.Literal('assistant'),
    stopReason: Type.Optional(Type.String()),
  }),
  type: Type.Literal('message_end'),
})
const EventSchema = Type.Object({ type: Type.Union([Type.Literal('agent_start'), Type.Literal('agent_settled')]) })
const DialogSchema = Type.Object({
  id: Type.String(),
  message: Type.Optional(Type.String()),
  method: Type.Union([Type.Literal('select'), Type.Literal('confirm'), Type.Literal('input'), Type.Literal('editor')]),
  options: Type.Optional(Type.Array(Type.String())),
  placeholder: Type.Optional(Type.String()),
  prefill: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Number()),
  title: Type.String(),
  type: Type.Literal('extension_ui_request'),
})
const StateSchema = Type.Object({ sessionFile: Type.Optional(Type.String()) })
type Dialog = Static<typeof DialogSchema>
type AssistantEnd = Static<typeof AssistantEndSchema>['message']

export class SubagentError extends Schema.TaggedError<SubagentError, { readonly brand: unique symbol }>()('SubagentError', {
  message: Schema.String,
}) {}

const fail = (message: string) => SubagentError.make({ message })

type AgentStatus = 'starting' | 'working' | 'idle' | 'blocked'

export interface AgentResult {
  readonly agent_id: string
  readonly status: 'started' | 'sent' | 'interrupted' | 'closed'
  readonly model?: string
}
interface AgentSummary {
  readonly agent_id: string
  readonly model: string
  readonly name?: string
  readonly status: AgentStatus
  readonly awaiting_result: boolean
}
export interface ListResult {
  readonly agents: readonly AgentSummary[]
}
export interface ResultDetails {
  readonly agent_id: string
  readonly model: string
  readonly name?: string
  readonly status: 'done' | 'error' | 'aborted' | 'exited'
}

interface Child {
  readonly id: string
  readonly owner: string
  readonly model: string
  readonly name?: string
  readonly scope: Scope.Closeable
  /** The session scope this child was forked from. */
  readonly session: Scope.Scope
  readonly dialogs: Set<Fiber.Fiber<void>>
  rpc?: RpcChild
  status: AgentStatus
  awaiting: boolean
  /** The latest assistant response since the previous settle. */
  latest?: AssistantEnd
  openDialogs: number
}

interface Session {
  readonly scope: Scope.Scope
  readonly ctx: ExtensionContext
}

/** @internal */
export const SUBAGENT_ENTRY = 'subagent'
/** @internal */
export const RESULT_MESSAGE = 'subagent-result'
const STARTUP_TIMEOUT = '30 seconds'
const RESULT_LIMITS = { maxBytes: 50 * 1024, maxLines: 2000 }

const CHILD_PROMPT =
  'You are a delegated agent. Complete only the initial task; you cannot delegate. Whenever you stop, your final response is delivered to the parent agent automatically, and the parent may send follow-up messages. End with a concise conclusion or failure, including evidence/checks and blockers. For detailed reviews or large results, write a temporary handoff file and include its absolute path in your final response; this file is allowed even for a read-only task, but other read-only restrictions still apply.'

const cancelled = (signal?: AbortSignal): boolean => signal?.aborted === true
const labelOf = (child: Child) => (child.name === undefined ? child.id : `"${child.name}" (${child.id})`)
const textOf = (message: AssistantEnd): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .flatMap((part) => (part.type === 'text' && part.text !== undefined ? [part.text] : []))
        .join('\n')
        .trim()

/** Herdr's own Pi integration in a child would report to the parent's pane, and Rex variables would put the child into discovery. */
const childEnvironment = (environment: EnvApi) => ({
  ...Object.fromEntries(Object.entries(environment.all).filter(([key]) => !key.startsWith('HERDR_') && !key.startsWith('REX_'))),
  PI_SUBAGENT: '1',
})

export interface SubagentOptions {
  readonly agentDir: string
  readonly loadSettings?: AgentModelSettingsLoader
}

export const makeSubagentHandlers = (pi: ExtensionAPI, environment: EnvApi, options: SubagentOptions) => {
  const loadSettings = options.loadSettings ?? loadAgentModelSettings
  const children = new Map<string, Child>()
  /** Child dialogs are shown one at a time, in arrival order. */
  const dialogLock = Semaphore.makeUnsafe(1)
  let session: Session | undefined

  const availableModels = (ctx: ExtensionContext) => availableAgentModels(ctx, loadSettings).pipe(Effect.mapError((error) => fail(error.message)))

  const owned = (ctx: ExtensionContext, id: string) => {
    const child = children.get(id)
    return child !== undefined && child.owner === (ctx.sessionManager.getSessionFile() ?? '') ? child : undefined
  }

  const notify = (child: Child, content: string, status: ResultDetails['status']) =>
    Effect.sync(() => {
      pi.sendMessage(
        {
          content,
          customType: RESULT_MESSAGE,
          details: { agent_id: child.id, model: child.model, status, ...(child.name !== undefined && { name: child.name }) } satisfies ResultDetails,
          display: true,
        },
        { deliverAs: 'steer', triggerTurn: true }
      )
    })

  const settle = (child: Child) =>
    Effect.suspend(() => {
      child.status = child.openDialogs > 0 ? 'blocked' : 'idle'
      const message = child.latest
      child.latest = undefined
      if (message === undefined) {
        return Effect.void
      }
      child.awaiting = false
      const status = message.stopReason === 'error' || message.stopReason === 'aborted' ? message.stopReason : 'done'
      const headline = { aborted: 'was interrupted', done: 'finished', error: 'failed' }[status]
      const failure = status === 'error' ? `\nError: ${message.errorMessage ?? 'The provider request failed.'}` : ''
      const bounded = truncateOutput(textOf(message) || '(no final text)', RESULT_LIMITS)
      return notify(
        child,
        `Agent ${labelOf(child)} ${headline} (${child.model}).${failure}\n\n${bounded.content}${bounded.truncated ? truncationNotice(bounded) : ''}`,
        status
      )
    })

  const answer = (ctx: ExtensionContext, child: Child, dialog: Dialog): Effect.Effect<RpcCommand> => {
    const title = `[${child.name ?? child.model}] ${dialog.title}`
    const dialogOptions = (signal: AbortSignal) => ({ signal, ...(dialog.timeout !== undefined && { timeout: dialog.timeout }) })
    const reply = (value: string | undefined): RpcCommand =>
      value === undefined
        ? { cancelled: true, id: dialog.id, type: 'extension_ui_response' }
        : { id: dialog.id, type: 'extension_ui_response', value }
    switch (dialog.method) {
      case 'confirm': {
        return Effect.promise((signal) => ctx.ui.confirm(title, dialog.message ?? '', dialogOptions(signal))).pipe(
          Effect.map((confirmed): RpcCommand => ({ confirmed, id: dialog.id, type: 'extension_ui_response' }))
        )
      }
      case 'select': {
        return Effect.promise((signal) => ctx.ui.select(title, dialog.options ?? [], dialogOptions(signal))).pipe(Effect.map(reply))
      }
      case 'input': {
        return Effect.promise((signal) => ctx.ui.input(title, dialog.placeholder, dialogOptions(signal))).pipe(Effect.map(reply))
      }
      default: {
        // Pi's editor dialog takes no abort signal, so it stays open after its child is gone and its answer is dropped.
        return Effect.promise(() => ctx.ui.editor(title, dialog.prefill)).pipe(Effect.map(reply))
      }
    }
  }

  /** Interrupting the returned effect dismisses the dialog and answers the child with `cancelled`. */
  const forward = (child: Child, rpc: RpcChild, dialog: Dialog) =>
    Effect.gen(function* () {
      const ctx = session?.ctx
      if (ctx?.hasUI !== true) {
        yield* rpc.send({ cancelled: true, id: dialog.id, type: 'extension_ui_response' })
        return
      }
      child.openDialogs++
      child.status = 'blocked'
      const response = yield* dialogLock
        .withPermits(1)(
          Effect.acquireUseRelease(
            Effect.sync(() => pi.events.emit('herdr:blocked', { active: true, label: dialog.title })),
            () => answer(ctx, child, dialog),
            () => Effect.sync(() => pi.events.emit('herdr:blocked', { active: false }))
          )
        )
        .pipe(
          Effect.onInterrupt(() => rpc.send({ cancelled: true, id: dialog.id, type: 'extension_ui_response' })),
          Effect.ensuring(
            Effect.sync(() => {
              child.openDialogs--
              if (child.status === 'blocked' && child.openDialogs === 0) {
                child.status = 'working'
              }
            })
          )
        )
      yield* rpc.send(response)
    })

  const onRecord = (child: Child) => (record: unknown) =>
    Effect.suspend(() => {
      if (Value.Check(AssistantEndSchema, record)) {
        child.latest = record.message
      } else if (Value.Check(EventSchema, record)) {
        if (record.type === 'agent_settled') {
          return settle(child)
        }
        if (child.status !== 'blocked') {
          child.status = 'working'
        }
      } else if (Value.Check(DialogSchema, record) && child.rpc !== undefined) {
        return forward(child, child.rpc, record).pipe(
          Effect.forkIn(child.scope),
          Effect.flatMap((fiber) =>
            Effect.sync(() => {
              if (fiber.pollUnsafe() === undefined) {
                child.dialogs.add(fiber)
              }
            })
          )
        )
      }
      return Effect.void
    })

  const abortDialogs = (child: Child) =>
    Effect.suspend(() => {
      const open = [...child.dialogs]
      child.dialogs.clear()
      return Fiber.interruptAll(open)
    })

  const forget = (child: Child) =>
    Effect.gen(function* () {
      children.delete(child.id)
      yield* abortDialogs(child)
      yield* Scope.close(child.scope, Exit.void)
    })

  const watchExit = (child: Child, rpc: RpcChild) =>
    rpc.exited.pipe(
      Effect.flatMap((code) =>
        Effect.gen(function* () {
          if (children.get(child.id) !== child) {
            return
          }
          children.delete(child.id)
          yield* abortDialogs(child)
          if (child.awaiting) {
            const how = code === undefined ? 'was killed by a signal' : `exited with code ${code}`
            const stderr = rpc.stderrTail().trim()
            yield* notify(
              child,
              `Agent ${labelOf(child)} ${how} before reporting a result (${child.model}).${stderr === '' ? '' : `\n\nstderr:\n${stderr}`}`,
              'exited'
            )
          }
        })
      )
    )

  const requireOwned = (ctx: ExtensionContext, id: string) => {
    const child = owned(ctx, id)
    return child?.rpc === undefined
      ? Effect.fail(fail('Only running agents spawned by this Pi session can be addressed.'))
      : Effect.succeed({ child, rpc: child.rpc })
  }

  return {
    activate: (ctx: ExtensionContext) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        session = { ctx, scope }
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            for (const [id, child] of children) {
              if (child.session === scope) {
                children.delete(id)
              }
            }
            if (session?.scope === scope) {
              session = undefined
            }
          })
        )
      }),
    availableModels,
    close: (params: Static<typeof AgentParams>, ctx: ExtensionContext) =>
      Effect.gen(function* () {
        const { child } = yield* requireOwned(ctx, params.agent_id)
        yield* forget(child)
        return { agent_id: child.id, status: 'closed' } satisfies AgentResult
      }),
    interrupt: (params: Static<typeof AgentParams>, ctx: ExtensionContext) =>
      Effect.gen(function* () {
        const { child, rpc } = yield* requireOwned(ctx, params.agent_id)
        yield* abortDialogs(child)
        // `abort` alone resumes queued steering, so the queue is cleared first.
        yield* rpc.request({ type: 'clear_queue' })
        const response = yield* rpc.request({ type: 'abort' })
        if (!response.success) {
          return yield* fail(response.error ?? 'The agent refused to abort.')
        }
        return { agent_id: child.id, status: 'interrupted' } satisfies AgentResult
      }).pipe(Effect.mapError((error) => fail(error.message))),
    list: (ctx: ExtensionContext) =>
      Effect.sync(
        () =>
          ({
            agents: [...children.values()]
              .filter((child) => child.owner === (ctx.sessionManager.getSessionFile() ?? ''))
              .map((child) => ({
                agent_id: child.id,
                awaiting_result: child.awaiting,
                model: child.model,
                status: child.status,
                ...(child.name !== undefined && { name: child.name }),
              })),
          }) satisfies ListResult
      ),
    send: (params: Static<typeof SendMessageParams>, ctx: ExtensionContext, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const message = yield* checkAgentMessage(params.message)
        const { child, rpc } = yield* requireOwned(ctx, params.agent_id)
        if (cancelled(signal)) {
          return yield* fail('Cancelled before sending the message.')
        }
        const response = yield* rpc.request({ message, streamingBehavior: 'steer', type: 'prompt' })
        if (!response.success) {
          return yield* fail(response.error ?? 'The agent rejected the message.')
        }
        child.awaiting = true
        if (child.status === 'idle') {
          child.status = 'working'
        }
        return { agent_id: child.id, status: 'sent' } satisfies AgentResult
      }).pipe(Effect.mapError((error) => fail(error.message))),
    spawn: (params: Static<typeof SpawnAgentParams>, ctx: ExtensionContext, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const message = yield* checkAgentMessage(params.message)
        const { model, provider } = yield* splitAgentModel(params.model)
        if (!Value.Check(SpawnAgentParams, params)) {
          return yield* fail('name must be a single-line label, thinking a supported level, tools a list of tool names, and cwd a path.')
        }
        const directory = params.cwd === undefined ? undefined : yield* resolveAgentDirectory(ctx.cwd, params.cwd)
        const { models } = yield* availableModels(ctx)
        yield* requireAllowedModel(params.model, models)
        const current = session
        if (current === undefined) {
          return yield* fail('spawn_agent is unavailable until the Pi session has started.')
        }
        if (cancelled(signal)) {
          return yield* fail('Cancelled before starting the agent.')
        }
        const random = yield* SecureRandom
        const id = (yield* random.uuidV4()).replaceAll('-', '').slice(0, 8)
        const child: Child = {
          awaiting: true,
          dialogs: new Set(),
          id,
          model: params.model,
          openDialogs: 0,
          owner: ctx.sessionManager.getSessionFile() ?? '',
          scope: yield* Scope.fork(current.scope),
          session: current.scope,
          status: 'starting',
          ...(params.name !== undefined && { name: params.name }),
        }
        const cwd = directory ?? ctx.cwd
        const args = [
          '--mode',
          'rpc',
          '--provider',
          provider,
          '--model',
          model,
          ...(params.thinking === undefined ? [] : ['--thinking', params.thinking]),
          ...(params.tools === undefined ? [] : ['--tools', params.tools.join(',')]),
          ...(params.name === undefined ? [] : ['--name', params.name]),
          '--session-dir',
          `${options.agentDir}/subagents/sessions/${ctx.sessionManager.getSessionId()}`,
          '--extension',
          fileURLToPath(new URL('../../index.ts', import.meta.url)),
          '--append-system-prompt',
          CHILD_PROMPT,
        ]
        const started = yield* Effect.gen(function* () {
          const rpc = yield* startRpc('pi', args, { cwd, env: childEnvironment(environment), onRecord: onRecord(child) })
          child.rpc = rpc
          children.set(id, child)
          const state = yield* rpc.request({ type: 'get_state' })
          const prompt = yield* rpc.request({ message, streamingBehavior: 'steer', type: 'prompt' })
          if (!state.success || !prompt.success) {
            return yield* fail(state.error ?? prompt.error ?? 'The agent rejected its task.')
          }
          return { rpc, sessionFile: Value.Check(StateSchema, state.data) ? state.data.sessionFile : undefined }
        }).pipe(
          Scope.provide(child.scope),
          Effect.timeoutOrElse({
            duration: STARTUP_TIMEOUT,
            orElse: () => Effect.fail(fail('No response within 30 seconds.')),
          }),
          Effect.catch((error) =>
            Effect.gen(function* () {
              const stderr = child.rpc?.stderrTail().trim() ?? ''
              children.delete(id)
              yield* Scope.close(child.scope, Exit.void)
              return yield* fail(`Could not start the agent: ${error.message}${stderr === '' ? '' : `\n${stderr}`}`)
            })
          )
        )
        if (child.status === 'starting') {
          child.status = 'working'
        }
        yield* watchExit(child, started.rpc).pipe(Effect.forkIn(child.scope))
        pi.appendEntry(SUBAGENT_ENTRY, {
          agent_id: id,
          cwd,
          model: params.model,
          session_file: started.sessionFile ?? '',
          ...(params.name !== undefined && { name: params.name }),
        })
        return { agent_id: id, model: params.model, status: 'started' } satisfies AgentResult
      }).pipe(Effect.mapError((error) => (error._tag === 'SubagentError' ? error : fail(error.message)))),
  }
}
