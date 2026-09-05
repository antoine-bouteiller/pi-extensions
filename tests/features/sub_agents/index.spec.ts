import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asResult, asTheme, asTui } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { Effect, Layer, ManagedRuntime } from 'effect'

import { feature, makeFeature, renderTranscriptContent } from '@/features/sub_agents/index.js'
import { SubagentOrchestrator, type SubagentOrchestratorApi } from '@/features/sub_agents/orchestrator.js'
import { type SubagentRuntime } from '@/features/sub_agents/runtime.js'
import { NotificationSink } from '@/features/sub_agents/store.js'
import { bindProductionNotificationSink, clearProductionNotificationSink, ProductionNotificationSinkLive } from '@/features/sub_agents/tools.js'
import { type AppRuntime } from '@/shared/effect/app_services.js'

interface InputHandler {
  readonly handleInput: (data: string) => void
}

interface Keybindings {
  readonly matches: () => boolean
}

type EditorFactory = (tui: ReturnType<typeof asTui>, theme: ReturnType<typeof asTheme>, keybindings: Keybindings) => InputHandler

const escapeGuard = (idle: boolean, live: boolean) =>
  Effect.gen(function* () {
    const fixture = createFakePi()
    const interrupted: string[] = []
    const orchestrator = asResult<SubagentOrchestratorApi>({
      closeSession: () => Effect.void,
      hasLiveChildren: () => live,
      initialize: Effect.void,
      interrupt: () => Effect.void,
      interruptAll: (session: string) => Effect.sync(() => interrupted.push(session)),
      list: () => Effect.succeed([]),
      openSession: () => Effect.succeed(1),
      read: () => Effect.void,
      send: () => Effect.void,
      spawn: () => Effect.void,
      waitAll: () => Effect.succeed([]),
      waitOne: () => Effect.void,
    })
    const runtime = ManagedRuntime.make(Layer.succeed(SubagentOrchestrator)(orchestrator))
    const featureRuntime = asResult<SubagentRuntime>(runtime)
    let editor: unknown
    const ctx = asExtensionContext({
      isIdle: () => idle,
      sessionManager: { getSessionId: () => 'current' },
      ui: {
        getEditorComponent: () => undefined,
        setEditorComponent: (next: unknown) => {
          editor = next
        },
      },
    })
    const plugin = makeFeature({
      agentDir: '/agents',
      childModelView: { authenticated_providers: [], models: [] },
      environment: () => ({}),
      isSubagent: () => false,
      runtime: featureRuntime,
      subagents: {},
    })
    plugin.implementation.register(fixture.pi, asResult<AppRuntime>(runtime))
    yield* plugin.implementation
      .activate({ reason: 'startup', type: 'session_start' }, ctx)
      .pipe(Effect.provideService(SubagentOrchestrator, orchestrator))
    const factory = asResult<EditorFactory>(editor)
    factory(asTui({}), asTheme({}), { matches: () => false }).handleInput('\u001b')
    yield* Effect.promise(() => Promise.resolve())
    return interrupted
  })

describe('sub-agent feature registration', () => {
  it('is an eager parent-only feature', () => {
    expect(feature.bootstrap).toBe('eager')
    expect(feature.id).toBe('sub-agents')
  })

  it.effect('consumes idle Escape only for a live current-session child through the feature editor', () =>
    Effect.gen(function* () {
      expect(yield* escapeGuard(true, true)).toEqual(['current'])
      expect(yield* escapeGuard(false, true)).toEqual([])
      expect(yield* escapeGuard(true, false)).toEqual([])
    })
  )

  it.effect('keeps a replacement notification binding when an older session finishes closing', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      let replacementEditor: unknown
      const replacementCtx = asExtensionContext({
        isIdle: () => true,
        sessionManager: { getSessionId: () => 'replacement' },
        ui: {
          getEditorComponent: () => replacementEditor,
          setEditorComponent: (next: unknown) => {
            replacementEditor = next
          },
        },
      })
      const orchestrator = asResult<SubagentOrchestratorApi>({
        closeSession: (session: string) =>
          session === 'old' ? Effect.sync(() => bindProductionNotificationSink(fixture.pi, 'replacement', 2, replacementCtx)) : Effect.void,
        hasLiveChildren: () => false,
        initialize: Effect.void,
        interrupt: () => Effect.void,
        interruptAll: () => Effect.void,
        list: () => Effect.succeed([]),
        openSession: () => Effect.succeed(1),
        read: () => Effect.void,
        send: () => Effect.void,
        spawn: () => Effect.void,
        waitAll: () => Effect.succeed([]),
        waitOne: () => Effect.void,
      })
      const runtime = ManagedRuntime.make(Layer.succeed(SubagentOrchestrator)(orchestrator))
      const plugin = makeFeature({
        agentDir: '/agents',
        childModelView: { authenticated_providers: [], models: [] },
        environment: () => ({}),
        isSubagent: () => false,
        runtime: asResult<SubagentRuntime>(runtime),
        subagents: {},
      })
      plugin.implementation.register(fixture.pi, asResult<AppRuntime>(runtime))
      let oldEditor: unknown
      const oldCtx = asExtensionContext({
        isIdle: () => true,
        sessionManager: { getSessionId: () => 'old' },
        ui: {
          getEditorComponent: () => oldEditor,
          setEditorComponent: (next: unknown) => {
            oldEditor = next
          },
        },
      })
      yield* plugin.implementation
        .activate({ reason: 'startup', type: 'session_start' }, oldCtx)
        .pipe(Effect.provideService(SubagentOrchestrator, orchestrator))

      yield* plugin.implementation.deactivate(oldCtx, 'replaced').pipe(Effect.provideService(SubagentOrchestrator, orchestrator))

      yield* Effect.service(NotificationSink).pipe(
        Effect.flatMap((service) => service.publish(['replacement survives'], { generation: 2, session: 'replacement' })),
        Effect.provide(ProductionNotificationSinkLive)
      )
      expect(fixture.state.messages).toEqual([{ message: 'replacement survives', options: undefined }])
      clearProductionNotificationSink('replacement', 2)
    })
  )

  it('renders authoritative failed outcomes even without transcript entries', () => {
    expect(
      renderTranscriptContent('failed-task · failed', {
        entries: [],
        turns: [{ result: { error: { code: 'agent_failed', message: 'worker failed' }, status: 'failed', task_name: 'failed-task', turn: 1 } }],
        unavailable: false,
      })
    ).toContain('{"error":{"code":"agent_failed","message":"worker failed"},"status":"failed","task_name":"failed-task","turn":1}')
  })
})
