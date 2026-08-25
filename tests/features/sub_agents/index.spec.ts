import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asResult, asTheme, asTui } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { Effect, Layer, ManagedRuntime } from 'effect'

import { feature, makeFeature, renderTranscriptContent } from '@/features/sub_agents/index.js'
import { SubagentOrchestrator, type SubagentOrchestratorApi } from '@/features/sub_agents/orchestrator.js'
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
      openSession: () => Effect.void,
      read: () => Effect.void,
      send: () => Effect.void,
      spawn: () => Effect.void,
      waitAll: () => Effect.succeed([]),
      waitOne: () => Effect.void,
    })
    const runtime = ManagedRuntime.make(Layer.succeed(SubagentOrchestrator)(orchestrator))
    const featureRuntime = asResult<AppRuntime>(runtime)
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
    })
    plugin.implementation.register(fixture.pi, featureRuntime)
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
