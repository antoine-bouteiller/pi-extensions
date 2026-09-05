import { type AgentToolUpdateCallback, type Theme } from '@earendil-works/pi-coding-agent'
import { BunFileSystem, BunPath } from '@effect/platform-bun'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asResult, asTheme, asTool } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { Value } from 'typebox/value'

import { makeFeature } from '@/features/sub_agents/index.js'
import {
  type AdmissionSnapshot,
  type AgentResult,
  type ChildModelView,
  type CommandError,
  type RunningAcceptance,
  type SettledInterruptNoop,
  type SteeringAck,
  InterruptAgentInputSchema,
  ListAgentsInputSchema,
  PROFILE_ORDER,
  PROFILE_REGISTRY,
  ReadAgentResponseInputSchema,
  SendMessageInputSchema,
  SpawnAgentInputSchema,
  WaitAgentInputSchema,
  WaitAllInputSchema,
} from '@/features/sub_agents/model.js'
import { LifecycleError, PublicRefusalError, SubagentOrchestrator, type SubagentOrchestratorApi } from '@/features/sub_agents/orchestrator.js'
import { NotificationSink } from '@/features/sub_agents/store.js'
import {
  bindProductionNotificationSink,
  clearProductionNotificationSink,
  makeDelegationTools,
  makePiNotificationSink,
  PARENT_GUIDANCE,
  ProductionNotificationSinkLive,
} from '@/features/sub_agents/tools.js'
import { type AppRuntime } from '@/shared/effect/app_services.js'
import { type ToolFailure } from '@/shared/effect/errors.js'
import { PiCtx, Ui } from '@/shared/effect/pi_services.js'
import { type HandlerServices, type ToolInvocation } from '@/shared/effect/runtime.js'

interface ToolResult {
  readonly content: readonly { readonly text: string; readonly type: 'text' }[]
  readonly details: unknown
}
interface SpawnRenderTool {
  readonly renderCall: (
    args: { readonly agent_type: string; readonly message: string; readonly run_in_background?: boolean; readonly task_name: string },
    theme: Theme
  ) => {
    render: (width: number) => string[]
  }
  readonly renderResult: (result: ToolResult, options: unknown, theme: Theme, context: unknown) => { render: (width: number) => string[] }
}

interface DelegationTool {
  readonly execute: (
    id: string,
    input: unknown,
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: ReturnType<typeof context>
  ) => Promise<ToolResult>
}

const childModelView: ChildModelView = { authenticated_providers: [], models: [] }
const completed = (task_name = 'task'): AgentResult => ({ conclusion: 'done', status: 'completed', task_name, turn: 1 })
const failed = (task_name = 'task'): AgentResult => ({ error: { code: 'agent_failed', message: 'failed' }, status: 'failed', task_name, turn: 1 })
const interrupted = (task_name = 'task'): AgentResult => ({
  error: { code: 'interrupted', message: 'stopped' },
  status: 'interrupted',
  task_name,
  turn: 1,
})
const truncated: AgentResult = {
  conclusion: 'preview',
  full_result_path: '/private/result.json',
  status: 'completed',
  task_name: 'truncated',
  truncated: true,
  turn: 1,
}
const refusal = () => PublicRefusalError.make({ code: 'unknown_agent', message: 'unknown' })
const selectedResult = (target: string): AgentResult => {
  if (target === 'failed') {
    return failed(target)
  }
  if (target === 'interrupted') {
    return interrupted(target)
  }
  return target === 'truncated' ? truncated : completed(target)
}
const sendResult = (target: string): AgentResult | CommandError | SteeringAck => {
  if (target === 'ack') {
    return { accepted: true, status: 'running', task_name: target, turn: 1 }
  }
  if (target === 'queue') {
    return { accepted: false, error: { code: 'queue_rejected', message: 'full' }, status: 'running', task_name: target, turn: 1 }
  }
  if (target === 'settled') {
    return { accepted: false, error: { code: 'turn_settled', message: 'done' }, status: 'completed', task_name: target, turn: 1 }
  }
  return selectedResult(target)
}

const orchestrator = (snapshots: AdmissionSnapshot[]): SubagentOrchestratorApi => ({
  closeSession: () => Effect.void,
  hasLiveChildren: () => false,
  initialize: Effect.void,
  interrupt: (session, target) =>
    session === 'refusal'
      ? Effect.fail(refusal())
      : Effect.succeed<AgentResult | SettledInterruptNoop>(
          target === 'noop' ? { interrupted: false, status: 'completed', task_name: target, turn: 1 } : selectedResult(target)
        ),
  interruptAll: () => Effect.void,
  list: (session) =>
    session === 'refusal'
      ? Effect.fail(refusal())
      : Effect.succeed([{ current_turn: 1, follow_up_available: true, profile: 'removed-profile', status: 'running' as const, task_name: 'task' }]),
  openSession: () => Effect.succeed(1),
  read: (session, target) =>
    session === 'refusal'
      ? Effect.fail(refusal())
      : Effect.succeed({
          profile: 'removed-profile',
          status: 'completed' as const,
          task_name: target,
          turns: [completed(target), failed(target), interrupted(target)],
        }),
  send: (session, admission, target) => {
    snapshots.push(admission)
    if (session === 'refusal') {
      return Effect.fail(refusal())
    }
    return Effect.succeed(sendResult(target))
  },
  spawn: (session, admission, request) => {
    snapshots.push(admission)
    const value: AgentResult | RunningAcceptance =
      request.task_name === 'running' ? { profile: 'scout', status: 'running', task_name: 'running', turn: 1 } : selectedResult(request.task_name)
    return session === 'refusal' ? Effect.fail(refusal()) : Effect.succeed(value)
  },
  waitAll: (session) => (session === 'refusal' ? Effect.fail(refusal()) : Effect.succeed([completed(), failed(), interrupted(), truncated])),
  waitOne: (session, targets) => (session === 'refusal' ? Effect.fail(refusal()) : Effect.succeed(selectedResult(targets?.[0] ?? 'task'))),
})

interface ContextOverrides {
  readonly cwd?: string
  readonly isIdle?: () => boolean
  readonly isProjectTrusted?: () => boolean
  readonly model?: { readonly id: string; readonly provider: string } | undefined
}
const context = (session = 'session', overrides: ContextOverrides = {}) =>
  asExtensionContext({
    cwd: '/work/one',
    isIdle: () => true,
    isProjectTrusted: () => true,
    model: { id: 'parent-model', provider: 'parent-provider' },
    sessionManager: { getSessionId: () => session },
    ...overrides,
  })
const dependencies = (pi: ReturnType<typeof createFakePi>['pi'], snapshots: AdmissionSnapshot[]) => ({
  agentDir: '/agents',
  childModelView,
  environment: () => ({ NUMBER: undefined, STRING: 'yes' }),
  pi,
  runtime: ManagedRuntime.make(Layer.succeed(SubagentOrchestrator)(orchestrator(snapshots))),
  subagents: { scout: 'configured-provider/configured-model' },
})
const ui = {
  confirm: () => Effect.succeed(true),
  hasUI: Effect.succeed(true),
  notify: () => Effect.void,
  setStatus: () => Effect.void,
}
const executeWith =
  (layer: Layer.Layer<SubagentOrchestrator>) =>
  <Params, Result>(body: (invocation: ToolInvocation<Params>) => Effect.Effect<Result, ToolFailure, SubagentOrchestrator | HandlerServices>) =>
  (
    toolCallId: string,
    input: Params,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: ReturnType<typeof context>
  ) =>
    Effect.runPromise(
      body({ ctx, onUpdate, params: input, signal, toolCallId }).pipe(
        Effect.provideService(PiCtx, ctx),
        Effect.provideService(Ui, ui),
        Effect.provide(layer)
      )
    )
const adapterTools = (pi: ReturnType<typeof createFakePi>['pi'], snapshots: AdmissionSnapshot[]) => {
  const layer = Layer.succeed(SubagentOrchestrator)(orchestrator(snapshots))
  return makeDelegationTools({ ...dependencies(pi, snapshots), runtime: ManagedRuntime.make(layer) }, executeWith(layer))
}
const call = (tools: ReturnType<typeof makeDelegationTools>, index: number, input: unknown, ctx = context()): Promise<ToolResult> =>
  asResult<DelegationTool>(tools[index]).execute('call', input, undefined, undefined, ctx)

describe('delegation tool boundary', () => {
  it('registers exactly the parent surface, profile descriptions, and guidance', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = createFakePi()
        const snapshots: AdmissionSnapshot[] = []
        makeFeature({ ...dependencies(fixture.pi, snapshots), isSubagent: () => false }).implementation.register(fixture.pi)

        expect([...fixture.state.tools.keys()]).toEqual([
          'spawn_agent',
          'wait_agent',
          'wait_all_agents',
          'list_agents',
          'read_agent_response',
          'send_message',
          'interrupt_agent',
        ])
        const agentType = SpawnAgentInputSchema.properties.agent_type
        expect(Reflect.get(agentType, 'enum')).toEqual([...PROFILE_ORDER])
        expect(Reflect.get(agentType, 'type')).toBe('string')
        expect(Reflect.get(agentType, 'description')).toBe(PROFILE_ORDER.map((key) => `${key}: ${PROFILE_REGISTRY[key].description}`).join('; '))
        const prompts = yield* Effect.promise(() => fixture.emit('before_agent_start', { systemPrompt: 'parent' }))
        expect(prompts).toEqual([{ systemPrompt: `parent\n\n${PARENT_GUIDANCE}` }])

        const child = createFakePi()
        makeFeature({ ...dependencies(child.pi, []), isSubagent: () => true }).implementation.register(child.pi)
        expect(child.state.tools).toHaveLength(0)
        const childPrompts = yield* Effect.promise(() => child.emit('before_agent_start', { systemPrompt: 'child' }))
        expect(childPrompts).toEqual([])
      })
    ))

  it.scoped('initializes settings on activation or first model selection and passes static models to tools', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'subagent-config-boundary-' })
      const fixture = createFakePi()
      const snapshots: AdmissionSnapshot[] = []
      const ports = Layer.succeed(SubagentOrchestrator)(orchestrator(snapshots))
      const runtime = ManagedRuntime.make(Layer.mergeAll(ports, BunFileSystem.layer, BunPath.layer))
      yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()))
      const plugin = makeFeature({
        ...dependencies(fixture.pi, snapshots),
        agentDir: root,
        isSubagent: () => false,
        runtime,
        subagents: undefined,
      })
      plugin.implementation.register(fixture.pi, asResult<AppRuntime>(runtime))
      const ctx = asExtensionContext({
        ...context('initial', { cwd: root, model: undefined }),
        ui: { getEditorComponent: () => undefined, setEditorComponent: () => undefined },
      })
      yield* plugin.implementation.activate({ reason: 'startup', type: 'session_start' }, ctx)
      expect(yield* fs.exists(`${root}/settings.json`)).toBe(false)
      const selected = asExtensionContext({ ...ctx, model: { id: 'selected', provider: 'provider' } })
      yield* Effect.promise(() => fixture.emit('model_select', {}, selected))
      expect(yield* fs.exists(`${root}/settings.json`)).toBe(true)
      const changed = asExtensionContext({ ...ctx, model: { id: 'changed', provider: 'other' } })
      yield* Effect.promise(() => fixture.emit('model_select', {}, changed))
      const spawn = asTool<DelegationTool>(fixture.state.tools.get('spawn_agent'))
      yield* Effect.promise(() => spawn.execute('call', { agent_type: 'scout', message: 'go', task_name: 'one' }, undefined, undefined, changed))
      expect(snapshots[0]?.subagents.scout).toBe('provider/selected')
      yield* plugin.implementation.deactivate(ctx, 'shutdown')
    })
  )

  it('renders spawn calls and outcomes with the selected profile color', () => {
    const fixture = createFakePi()
    const tool = asResult<SpawnRenderTool>(adapterTools(fixture.pi, [])[0])
    const colors: string[] = []
    const theme = asTheme({
      bold: (value: string) => value,
      fg: (color: string, value: string) => {
        colors.push(color)
        return value
      },
    })
    const renderCall = (input: {
      readonly agent_type: string
      readonly message: string
      readonly run_in_background?: boolean
      readonly task_name: string
    }) => tool.renderCall(input, theme).render(120).join('\n').trimEnd()
    const renderResult = (details: unknown, isError = false, content = 'ignored') =>
      tool
        .renderResult({ content: [{ text: content, type: 'text' }], details }, {}, theme, {
          args: { agent_type: 'scout', message: 'go', task_name: 'task' },
          isError,
        })
        .render(120)
        .join('\n')
        .trimEnd()

    expect(renderCall({ agent_type: 'scout', message: 'go', run_in_background: true, task_name: 'task' })).toBe(
      'spawn_agent task [scout] [background]'
    )
    expect(renderCall({ agent_type: 'scout', message: 'go', task_name: 'task' })).toBe('spawn_agent task [scout] [foreground]')
    expect(renderCall({ agent_type: 'scout', message: 'go', task_name: '' })).toBe('spawn_agent ? [scout] [foreground]')
    expect(colors).toContain('thinkingLow')

    expect(renderResult(completed())).toBe('✓ task completed')
    expect(renderResult(failed())).toBe('✗ task failed')
    expect(renderResult(interrupted())).toBe('✗ task interrupted')
    expect(renderResult({ profile: 'scout', status: 'running', task_name: 'task', turn: 1 })).toBe('✓ task background')
    expect(renderResult({ error: { code: 'unknown_agent', message: 'unknown' } })).toBe('✗ unknown')
    expect(renderResult({ error: { code: 'host_error', message: 'ignored' } }, true, 'host failed')).toBe('✗ host failed')
  })

  it('uses exact closed snake_case schemas and task-name boundaries', () => {
    const name64 = 'a'.repeat(64)
    const schemas = [
      SpawnAgentInputSchema,
      WaitAgentInputSchema,
      WaitAllInputSchema,
      ListAgentsInputSchema,
      ReadAgentResponseInputSchema,
      SendMessageInputSchema,
      InterruptAgentInputSchema,
    ]
    expect(Value.Check(SpawnAgentInputSchema, { agent_type: 'scout', message: 'inspect', task_name: name64 })).toBe(true)
    expect(Value.Check(SpawnAgentInputSchema, { agent_type: 'scout', message: 'inspect', task_name: '' })).toBe(false)
    expect(Value.Check(SpawnAgentInputSchema, { agent_type: 'scout', message: 'inspect', task_name: `${name64}a` })).toBe(false)
    expect(Value.Check(SpawnAgentInputSchema, { agent_type: 'scout', message: 'inspect', task_name: 'not valid' })).toBe(false)
    expect(Value.Check(WaitAgentInputSchema, { targets: [] })).toBe(false)
    expect(Value.Check(WaitAllInputSchema, { targets: ['same', 'same'] })).toBe(true)
    for (const schema of schemas) {
      expect(Value.Check(schema, { session: 'other' })).toBe(false)
    }
    expect(Value.Check(ListAgentsInputSchema, {})).toBe(true)
    expect(Value.Check(ListAgentsInputSchema, { target: 'task' })).toBe(false)
  })

  it('returns every public success and refusal branch as structured details', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = createFakePi()
        const tools = adapterTools(fixture.pi, [])
        const branches = [
          [0, { agent_type: 'scout', message: 'go', task_name: 'running' }, 'running'],
          [0, { agent_type: 'scout', message: 'go', task_name: 'truncated' }, 'completed'],
          [0, { agent_type: 'scout', message: 'go', task_name: 'failed' }, 'failed'],
          [1, { targets: ['interrupted'] }, 'interrupted'],
          [2, {}, undefined],
          [3, {}, undefined],
          [4, { target: 'task' }, undefined],
          [5, { message: 'go', target: 'ack' }, 'running'],
          [5, { message: 'go', target: 'queue' }, 'running'],
          [5, { message: 'go', target: 'settled' }, 'completed'],
          [5, { message: 'go', target: 'failed' }, 'failed'],
          [6, { target: 'noop' }, 'completed'],
          [6, { target: 'interrupted' }, 'interrupted'],
        ] as const
        for (const [index, input, status] of branches) {
          const result = yield* Effect.promise(() => call(tools, index, input))
          expect(result.content[0]?.text).toContain('"')
          if (status !== undefined) {
            expect(result.details).toMatchObject({ status })
          }
        }
        for (const [index, input] of branches) {
          const result = yield* Effect.promise(() => call(tools, index, input, context('refusal')))
          expect(result.details).toEqual({ error: { code: 'unknown_agent', message: 'unknown' } })
        }
      })
    ))

  it('snapshots admission at each spawn and send call without retaining a context', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = createFakePi()
        const snapshots: AdmissionSnapshot[] = []
        const registered = adapterTools(fixture.pi, [])
        fixture.pi.registerTool(registered[0])
        const tools = adapterTools(fixture.pi, snapshots)
        yield* Effect.promise(() => call(tools, 0, { agent_type: 'scout', message: 'go', task_name: 'one' }, context('one')))
        fixture.pi.registerTool(registered[1])
        yield* Effect.promise(() =>
          call(tools, 5, { message: 'again', target: 'ack' }, context('two', { cwd: '/work/two', isProjectTrusted: () => false, model: undefined }))
        )

        expect(snapshots).toEqual([
          {
            agent_dir: '/agents',
            child_model_view: childModelView,
            cwd: '/work/one',
            environment: { STRING: 'yes' },
            project_trusted: true,
            registered_tools: ['spawn_agent'],
            subagents: { scout: 'configured-provider/configured-model' },
          },
          {
            agent_dir: '/agents',
            child_model_view: childModelView,
            cwd: '/work/two',
            environment: { STRING: 'yes' },
            project_trusted: false,
            registered_tools: ['spawn_agent', 'wait_agent'],
            subagents: { scout: 'configured-provider/configured-model' },
          },
        ])
      })
    ))

  it('derives admission from the child-equivalent model view and captured environment', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = createFakePi()
        const snapshots: AdmissionSnapshot[] = []
        const tools = makeDelegationTools(
          {
            ...dependencies(fixture.pi, snapshots),
            childModelViewFor: (_ctx, environment) =>
              Promise.resolve({
                authenticated_providers: environment.CHILD_AUTH === 'present' ? ['persisted-provider', 'environment-provider'] : [],
                models: [{ contextWindow: 42, model: 'child-model', provider: 'persisted-provider' }],
              }),
            environment: () => ({ CHILD_AUTH: 'present', PARENT_MEMORY_KEY: undefined }),
          },
          executeWith(Layer.succeed(SubagentOrchestrator)(orchestrator(snapshots)))
        )
        yield* Effect.promise(() => call(tools, 0, { agent_type: 'scout', message: 'go', task_name: 'child-view' }))
        expect(snapshots[0]?.child_model_view).toEqual({
          authenticated_providers: ['persisted-provider', 'environment-provider'],
          models: [{ contextWindow: 42, model: 'child-model', provider: 'persisted-provider' }],
        })
        expect(snapshots[0]?.environment).toEqual({ CHILD_AUTH: 'present' })
      })
    ))

  it('maps unknown host failures to ToolFailure', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = createFakePi()
        const crashing: SubagentOrchestratorApi = {
          ...orchestrator([]),
          list: () =>
            Effect.fail(
              LifecycleError.make({ cause: new Error('host exploded'), message: 'host exploded', operation: 'initialize', reason: 'host_failure' })
            ),
        }
        const layer = Layer.succeed(SubagentOrchestrator)(crashing)
        const tools = makeDelegationTools({ ...dependencies(fixture.pi, []), runtime: ManagedRuntime.make(layer) }, executeWith(layer))
        const failure = yield* Effect.promise(() =>
          call(tools, 3, {}).then(
            () => undefined,
            (error: unknown) => error
          )
        )
        expect(failure).toMatchObject({ _tag: 'ToolFailure', message: 'host exploded' })
      })
    ))

  it('clears only the exact notification binding and releases the matching production target', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const first = createFakePi()
        const second = createFakePi()
        bindProductionNotificationSink(first.pi, 'first', 1, context('first'))
        bindProductionNotificationSink(second.pi, 'second', 2, context('second'))
        clearProductionNotificationSink('first', 1)
        yield* Effect.service(NotificationSink).pipe(
          Effect.flatMap((service) => service.publish(['current'], { generation: 2, session: 'second' })),
          Effect.provide(ProductionNotificationSinkLive)
        )
        expect(first.state.messages).toHaveLength(0)
        expect(second.state.messages).toEqual([{ message: 'current', options: undefined }])

        clearProductionNotificationSink('second', 2)
        yield* Effect.service(NotificationSink).pipe(
          Effect.flatMap((service) => service.publish(['released'], { generation: 2, session: 'second' })),
          Effect.provide(ProductionNotificationSinkLive)
        )
        expect(second.state.messages).toHaveLength(1)
      })
    ))

  it('delivers a sink batch once, steers running parents, and drops stale bindings before commit', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const idle = createFakePi()
        const sink = makePiNotificationSink(idle.pi)
        sink.bind('session', 1, context())
        yield* Effect.service(NotificationSink).pipe(
          Effect.flatMap((service) => service.publish(['one', 'two'], { generation: 1, session: 'session' })),
          Effect.provide(sink.layer)
        )
        expect(idle.state.messages).toEqual([{ message: 'one\ntwo', options: undefined }])

        const running = createFakePi()
        const runningSink = makePiNotificationSink(running.pi)
        runningSink.bind('session', 1, context('session', { isIdle: () => false }))
        yield* Effect.service(NotificationSink).pipe(
          Effect.flatMap((service) => service.publish(['one'], { generation: 1, session: 'session' })),
          Effect.provide(runningSink.layer)
        )
        expect(running.state.messages).toEqual([{ message: 'one', options: { deliverAs: 'steer' } }])

        const stale = createFakePi()
        const staleSink = makePiNotificationSink(stale.pi)
        staleSink.bind('session', 1, context('session', { isIdle: () => (staleSink.bind('replacement', 2, context('replacement')), true) }))
        yield* Effect.service(NotificationSink).pipe(
          Effect.flatMap((service) => service.publish(['lost'], { generation: 1, session: 'session' })),
          Effect.provide(staleSink.layer)
        )
        expect(stale.state.messages).toHaveLength(0)
        yield* Effect.service(NotificationSink).pipe(
          Effect.flatMap((service) => service.publish(['replacement'], { generation: 2, session: 'replacement' })),
          Effect.provide(staleSink.layer)
        )
        expect(stale.state.messages).toEqual([{ message: 'replacement', options: undefined }])
      })
    ))
})
