import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Effect, Layer, type ManagedRuntime } from 'effect'

import { ToolFailure } from '#shared/effect/errors'
import { PiCtx } from '#shared/effect/pi_services'
import { type HandlerServices, type ToolInvocation } from '#shared/effect/runtime'

import {
  type AdmissionSnapshot,
  type AgentResult,
  type ChildModelView,
  type InterruptAgentInput,
  InterruptAgentInputSchema,
  ListAgentsInputSchema,
  type ReadAgentResponseInput,
  ReadAgentResponseInputSchema,
  type RunningAcceptance,
  type SendMessageInput,
  SendMessageInputSchema,
  SpawnAgentInputSchema,
  type SpawnAgentInput,
  type SubagentSettings,
  type WaitAgentInput,
  WaitAgentInputSchema,
  WaitAllInputSchema,
  type WaitAllInput,
} from './model.js'
import { type OrchestrationError, type PublicRefusalError, profileColor, SubagentOrchestrator, type SubagentOrchestratorApi } from './orchestrator.js'
import { NotificationSink, type NotificationToken } from './store.js'

const json = <Value>(value: Value) => ({
  content: [{ text: JSON.stringify(value), type: 'text' as const }],
  details: value,
})
const refusal = (error: PublicRefusalError) => ({ error: { code: error.code, message: error.message } })
const failure = (error: unknown) => ToolFailure.make({ cause: error, message: error instanceof Error ? error.message : String(error) })
const environmentCopy = (environment: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(environment).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : [])))

export interface DelegationToolDependencies {
  readonly agentDir: string
  readonly childModelView: ChildModelView
  readonly childModelViewFor?: (
    ctx: ExtensionContext,
    environment: Readonly<Record<string, string | undefined>>
  ) => ChildModelView | Promise<ChildModelView>
  readonly environment: () => Readonly<Record<string, string | undefined>>
  readonly pi: ExtensionAPI
  readonly runtime: ManagedRuntime.ManagedRuntime<SubagentOrchestrator, never>
  readonly subagents?: SubagentSettings
}

const admission = (ctx: ExtensionContext, dependencies: DelegationToolDependencies): Promise<AdmissionSnapshot> => {
  const environment = dependencies.environment()
  return Promise.resolve(dependencies.childModelViewFor?.(ctx, environment)).then((childModelView) => ({
    agent_dir: dependencies.agentDir,
    child_model_view: childModelView ?? dependencies.childModelView,
    cwd: ctx.cwd,
    environment: environmentCopy(environment),
    project_trusted: ctx.isProjectTrusted(),
    registered_tools: dependencies.pi.getAllTools().map((tool) => tool.name),
    subagents: dependencies.subagents ?? {},
  }))
}
const withOrchestrator = <Value>(body: (orchestrator: SubagentOrchestratorApi) => Effect.Effect<Value, OrchestrationError>) =>
  Effect.gen(function* () {
    const orchestrator = yield* SubagentOrchestrator
    return yield* body(orchestrator)
  }).pipe(
    Effect.catch((error) =>
      error._tag === 'PublicRefusalError' ? Effect.succeed(refusal(error)) : Effect.logError(error).pipe(Effect.andThen(Effect.fail(failure(error))))
    )
  )

const session = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId()

type SpawnDetails = AgentResult | RunningAcceptance | { readonly error: { readonly code: string; readonly message: string } }
type SpawnToolDefinition = ToolDefinition<typeof SpawnAgentInputSchema, SpawnDetails>
type DelegationTools = readonly [
  SpawnToolDefinition,
  ToolDefinition<typeof WaitAgentInputSchema>,
  ToolDefinition<typeof WaitAllInputSchema>,
  ToolDefinition<typeof ListAgentsInputSchema>,
  ToolDefinition<typeof ReadAgentResponseInputSchema>,
  ToolDefinition<typeof SendMessageInputSchema>,
  ToolDefinition<typeof InterruptAgentInputSchema>,
]
type SpawnRenderContext = Parameters<NonNullable<SpawnToolDefinition['renderResult']>>[3]

const renderSpawnResult = (result: AgentToolResult<SpawnDetails>, _options: unknown, theme: Theme, context: SpawnRenderContext) => {
  if (context.isError) {
    const message = result.content.find((content) => content.type === 'text')?.text ?? 'failed'
    return new Text(theme.fg('error', `✗ ${message}`), 0, 0)
  }

  const { details } = result
  if ('status' in details) {
    const color = profileColor(context.args.agent_type)
    if (details.status === 'completed') {
      return new Text(theme.fg('success', '✓ ') + theme.fg(color, details.task_name) + theme.fg('muted', ' completed'), 0, 0)
    }
    if (details.status === 'running') {
      return new Text(theme.fg('success', '✓ ') + theme.fg(color, details.task_name) + theme.fg('muted', ' background'), 0, 0)
    }
    return new Text(theme.fg('error', '✗ ') + theme.fg(color, details.task_name) + theme.fg('muted', ` ${details.status}`), 0, 0)
  }

  return new Text(theme.fg('error', `✗ ${details.error.message}`), 0, 0)
}

type ToolExecutor = <Params, Result>(
  body: (invocation: ToolInvocation<Params>) => Effect.Effect<Result, ToolFailure, SubagentOrchestrator | HandlerServices>
) => (
  toolCallId: string,
  params: Params,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: ExtensionContext
) => Promise<Result>

export const makeDelegationTools: (dependencies: DelegationToolDependencies, execute: ToolExecutor) => DelegationTools = (dependencies, execute) => [
  {
    description: 'Delegate a self-contained task to a named sub-agent. Waits for its conclusion unless run_in_background is true.',
    execute: execute<SpawnAgentInput, AgentToolResult<SpawnDetails>>(({ params: input }) =>
      Effect.service(PiCtx).pipe(
        Effect.flatMap((ctx) =>
          Effect.promise(() => admission(ctx, dependencies)).pipe(
            Effect.flatMap((snapshot) => withOrchestrator((orchestrator) => orchestrator.spawn(session(ctx), snapshot, input))),
            Effect.map(json)
          )
        )
      )
    ),
    label: 'Spawn Agent',
    name: 'spawn_agent',
    parameters: SpawnAgentInputSchema,
    renderCall: (args: SpawnAgentInput, theme: Theme) =>
      new Text(
        theme.fg('toolTitle', theme.bold('spawn_agent ')) +
          theme.fg('text', args.task_name || '?') +
          theme.fg(profileColor(args.agent_type), ` [${args.agent_type}]`) +
          theme.fg('muted', args.run_in_background === true ? ' [background]' : ' [foreground]'),
        0,
        0
      ),
    renderResult: renderSpawnResult,
  },
  {
    description: 'Wait for the next eligible sub-agent conclusion, optionally restricted to named targets.',
    execute: execute<WaitAgentInput, ReturnType<typeof json>>(({ params: input }) =>
      Effect.service(PiCtx).pipe(
        Effect.flatMap((ctx) => withOrchestrator((orchestrator) => orchestrator.waitOne(session(ctx), input.targets)).pipe(Effect.map(json)))
      )
    ),
    label: 'Wait Agent',
    name: 'wait_agent',
    parameters: WaitAgentInputSchema,
  },
  {
    description: 'Wait for all eligible sub-agent conclusions, optionally restricted to named targets.',
    execute: execute<WaitAllInput, ReturnType<typeof json>>(({ params: input }) =>
      Effect.service(PiCtx).pipe(
        Effect.flatMap((ctx) =>
          withOrchestrator((orchestrator) => orchestrator.waitAll(session(ctx), input.targets).pipe(Effect.map((results) => ({ results })))).pipe(
            Effect.map(json)
          )
        )
      )
    ),
    label: 'Wait All Agents',
    name: 'wait_all_agents',
    parameters: WaitAllInputSchema,
  },
  {
    description: 'List sub-agents in the current session and their current status.',
    execute: execute<Record<string, never>, ReturnType<typeof json>>(() =>
      Effect.service(PiCtx).pipe(
        Effect.flatMap((ctx) =>
          withOrchestrator((orchestrator) => orchestrator.list(session(ctx)).pipe(Effect.map((agents) => ({ agents })))).pipe(Effect.map(json))
        )
      )
    ),
    label: 'List Agents',
    name: 'list_agents',
    parameters: ListAgentsInputSchema,
  },
  {
    description: 'Read durable conclusions for one sub-agent in the current session.',
    execute: execute<ReadAgentResponseInput, ReturnType<typeof json>>(({ params: input }) =>
      Effect.service(PiCtx).pipe(
        Effect.flatMap((ctx) => withOrchestrator((orchestrator) => orchestrator.read(session(ctx), input.target)).pipe(Effect.map(json)))
      )
    ),
    label: 'Read Agent Response',
    name: 'read_agent_response',
    parameters: ReadAgentResponseInputSchema,
  },
  {
    description: 'Send the one permitted follow-up message to a sub-agent in the current session.',
    execute: execute<SendMessageInput, ReturnType<typeof json>>(({ params: input }) =>
      Effect.service(PiCtx).pipe(
        Effect.flatMap((ctx) =>
          Effect.promise(() => admission(ctx, dependencies)).pipe(
            Effect.flatMap((snapshot) => withOrchestrator((orchestrator) => orchestrator.send(session(ctx), snapshot, input.target, input.message))),
            Effect.map(json)
          )
        )
      )
    ),
    label: 'Send Message',
    name: 'send_message',
    parameters: SendMessageInputSchema,
  },
  {
    description: 'Interrupt a running sub-agent in the current session and return its durable outcome.',
    execute: execute<InterruptAgentInput, ReturnType<typeof json>>(({ params: input }) =>
      Effect.service(PiCtx).pipe(
        Effect.flatMap((ctx) => withOrchestrator((orchestrator) => orchestrator.interrupt(session(ctx), input.target)).pipe(Effect.map(json)))
      )
    ),
    label: 'Interrupt Agent',
    name: 'interrupt_agent',
    parameters: InterruptAgentInputSchema,
  },
]

export const PARENT_GUIDANCE = `Delegate narrow, self-contained errands whose intermediate context need not remain
in the parent conversation. Foreground is the default. Use background execution
only for clearly independent work, and never duplicate work assigned to a pending
child. A session may have at most three live children and one live implementer.
Each child accepts at most one follow-up message and each turn ends after 30
minutes. Prefer a fresh child for distinct work. Only the child’s conclusion is
returned; use the inspection tools for durable results and conversations.`

export interface PiNotificationSink {
  readonly bind: (session: string, generation: number, ctx: ExtensionContext) => void
  readonly clear: (session: string, generation: number) => boolean
  readonly layer: Layer.Layer<NotificationSink>
}

type NotificationPi = Pick<ExtensionAPI, 'sendUserMessage'>

/** The mutable binding is deliberately only a delivery target; it contains no orchestration state. */
export const makePiNotificationSink = (pi: NotificationPi): PiNotificationSink => {
  let binding: { readonly ctx: ExtensionContext; readonly generation: number; readonly session: string } | undefined
  const publish = (messages: readonly string[], token: NotificationToken) =>
    Effect.sync(() => {
      const current = binding
      if (
        current === undefined ||
        current.generation !== token.generation ||
        current.session !== token.session ||
        current.session !== current.ctx.sessionManager.getSessionId()
      ) {
        return
      }
      const options = current.ctx.isIdle() ? undefined : { deliverAs: 'steer' as const }
      // This is the delivery commit point: a replaced session binding cannot send stale output.
      const active = binding
      if (active === undefined || active.generation !== token.generation || active.session !== token.session) {
        return
      }
      pi.sendUserMessage(messages.join('\n'), options)
    })
  return {
    bind: (sessionId, generation, ctx): void => {
      binding = { ctx, generation, session: sessionId }
    },
    clear: (sessionId, generation): boolean => {
      if (binding?.session !== sessionId || binding.generation !== generation) {
        return false
      }
      binding = undefined
      return true
    },
    layer: Layer.succeed(NotificationSink)({ publish }),
  }
}

let productionPi: NotificationPi | undefined
const productionNotificationSink = makePiNotificationSink({
  sendUserMessage(messages, options): void {
    productionPi?.sendUserMessage(messages, options)
  },
})

export const bindProductionNotificationSink = (pi: NotificationPi, sessionId: string, generation: number, ctx: ExtensionContext): void => {
  productionPi = pi
  productionNotificationSink.bind(sessionId, generation, ctx)
}

export const clearProductionNotificationSink = (sessionId: string, generation: number): void => {
  if (productionNotificationSink.clear(sessionId, generation)) {
    productionPi = undefined
  }
}

export const ProductionNotificationSinkLive = productionNotificationSink.layer
