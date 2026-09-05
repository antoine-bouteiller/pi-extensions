import { initTheme } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asResult, asTheme, asTui } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime as appRuntime } from '@tests/utils/runtime.js'
import { Context, Effect, Layer, ManagedRuntime } from 'effect'

import { feature, makeFeature } from '@/features/sub_agents/index.js'
import { SubagentOrchestrator, type SubagentOrchestratorApi } from '@/features/sub_agents/orchestrator.js'
import { type SubagentRuntime } from '@/features/sub_agents/runtime.js'
import { NotificationSink, SubagentStore, SubagentStoreLive, type SubagentRecord } from '@/features/sub_agents/store.js'
import { bindProductionNotificationSink, clearProductionNotificationSink, ProductionNotificationSinkLive } from '@/features/sub_agents/tools.js'
import { type AppRuntime } from '@/shared/effect/app_services.js'

initTheme()

interface InputHandler {
  readonly handleInput: (data: string) => void
}

interface Keybindings {
  readonly matches: () => boolean
}

interface OverlayComponent extends InputHandler {
  readonly dispose: () => void
  readonly render: (width: number) => readonly string[]
}

type EditorFactory = (tui: ReturnType<typeof asTui>, theme: ReturnType<typeof asTheme>, keybindings: Keybindings) => InputHandler

type OverlayFactory = (
  tui: ReturnType<typeof asTui>,
  theme: ReturnType<typeof asTheme>,
  keybindings: Keybindings,
  done: () => void
) => OverlayComponent

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

  it.effect('scrolls a transcript overlay opened through the subagents command', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const agentId = `scroll-${Bun.randomUUIDv7()}`
      const store = Context.get(appRuntime.runSync(Effect.scoped(Layer.build(SubagentStoreLive))), SubagentStore)
      const session = yield* store.createSession(agentId)
      const transcript = [
        { cwd: '/workspace', id: 'session', timestamp: '2025-01-01T00:00:00.000Z', type: 'session', version: 3 },
        ...Array.from({ length: 30 }, (_unused, position) => ({
          id: `message-${position}`,
          message: { content: [{ text: `clipped line ${position}`, type: 'text' }], role: 'user', timestamp: position + 1 },
          parentId: position === 0 ? null : `message-${position - 1}`,
          timestamp: `2025-01-01T00:00:${String(position + 1).padStart(2, '0')}.000Z`,
          type: 'message',
        })),
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
      yield* Effect.tryPromise(() => Bun.write(session.sessionPath, `${transcript}\n`))
      const record: SubagentRecord = {
        logPath: 'worker.log',
        profile: { contextCeiling: 1, key: 'scout', model: 'model', prompt: 'prompt', provider: 'provider', tools: [] },
        session: 'current',
        sessionPath: session.sessionPath,
        settledAt: 1,
        status: 'completed',
        taskName: 'scroll task',
        turns: [],
      }
      yield* store.replaceRecord(agentId, record)
      let overlay: OverlayComponent | undefined
      const tui = asTui({ requestRender: () => undefined, terminal: { columns: 100, rows: 20 } })
      const ctx = asExtensionContext({
        cwd: '/workspace',
        sessionManager: { getSessionId: () => 'current' },
        ui: {
          custom: (factory: OverlayFactory) => {
            overlay = factory(tui, asTheme({}), { matches: () => false }, () => undefined)
            return Promise.resolve()
          },
          select: () => Promise.resolve('scroll task (completed)'),
        },
      })
      const plugin = makeFeature({
        agentDir: '/agents',
        childModelView: { authenticated_providers: [], models: [] },
        environment: () => ({}),
        isSubagent: () => false,
        subagents: {},
      })
      plugin.implementation.register(fixture.pi, appRuntime)
      const command = asResult<{ readonly handler: (args: string, commandCtx: typeof ctx) => Promise<void> }>(fixture.state.commands.get('subagents'))
      yield* Effect.promise(() => command.handler('', ctx))
      const component = asResult<OverlayComponent>(overlay)
      const first = component.render(120)
      expect(first.length).toBeLessThanOrEqual(Math.floor(20 * 0.8))
      expect(first.join('\n')).toContain('clipped line 0')
      expect(first.join('\n')).not.toContain('clipped line 5')

      component.handleInput('\u001b[6~')
      expect(component.render(120).join('\n')).toContain('clipped line 5')
      component.dispose()
      yield* store.delete(agentId)
    })
  )
})
