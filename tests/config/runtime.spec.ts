import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import { features } from '#config/features'
import { getOrCreateProcessRuntime } from '#config/runtime'
import { register as registerStatusPanel } from '#features/status_panel/index'
import { AgentActivity, type AgentActivityApi, type AppRuntime, StatusBarLive } from '#shared/effect/app_services'
import { asExtensionContext, asResult, asTheme, asTui } from '#tests/utils/casts'
import { deferred } from '#tests/utils/deferred'
import { describe, expect, it, tryPromiseEffect } from '#tests/utils/effect'
import { createFakePi } from '#tests/utils/fake_pi'
import { withProcessEnv } from '#tests/utils/process_env'

import piExtensions from '../../src/index'

interface SidebarComponent {
  render: (width: number) => string[]
}

const panelContext = () => {
  let sidebar: SidebarComponent | undefined
  const ctx = asExtensionContext({
    cwd: '/project',
    getContextUsage: () => undefined,
    mode: 'tui',
    model: { contextWindow: 100_000, id: 'model', provider: 'openai' },
    ui: {
      custom: (factory: (tui: unknown, theme: unknown) => SidebarComponent) => {
        sidebar = factory(
          asTui({ render: () => [], requestRender: () => undefined, terminal: { columns: 120, rows: 30 } }),
          asTheme({ bold: (value: string) => value, fg: (_color: string, value: string) => value })
        )
        return deferred<void>().promise
      },
      setFooter: () => undefined,
      setTitle: () => undefined,
    },
  })
  return {
    ctx,
    render: () => {
      if (sidebar === undefined) {
        throw new Error('status-panel sidebar missing')
      }
      return sidebar.render(44).join('\n')
    },
  }
}

// Features register differently inside a subagent, so this worker must look like a top-level Pi run.
delete process.env.PI_SUBAGENT_OWNER_TOKEN

describe('process-wide runtime', () => {
  it.effect('memoises to one instance across repeated lookups', () =>
    Effect.sync(() => {
      expect(getOrCreateProcessRuntime()).toBe(getOrCreateProcessRuntime())
    })
  )

  it.effect('uses the runtime supplied to a feature register function', () =>
    Effect.gen(function* () {
      let subscriptions = 0
      const sentinelActivity: AgentActivityApi = {
        list: () => [],
        publish: () => Effect.void,
        subscribe: () => {
          subscriptions += 1
          return () => undefined
        },
      }
      const runtime: AppRuntime = ManagedRuntime.make(
        Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, FetchHttpClient.layer, StatusBarLive, Layer.succeed(AgentActivity)(sentinelActivity))
      )
      yield* withProcessEnv('PI_SUBAGENT_OWNER_TOKEN', undefined, () =>
        Effect.sync(() => {
          registerStatusPanel(createFakePi().pi, runtime)
          expect(subscriptions).toBe(1)
        })
      ).pipe(Effect.ensuring(Effect.promise(() => runtime.dispose())))
    })
  )

  it.effect('makes AgentActivity observable through aggregate and explicit feature registration', () =>
    Effect.gen(function* () {
      const runtime = getOrCreateProcessRuntime()
      const aggregate = createFakePi()
      piExtensions(aggregate.pi)
      const statusPanelIndex = features.findIndex((feature) => feature.register === registerStatusPanel)
      if (statusPanelIndex === -1) {
        throw new Error('status-panel feature missing')
      }
      const precedingSessionStarts = features.slice(0, statusPanelIndex).flatMap((feature) => {
        const fixture = createFakePi()
        feature.register(fixture.pi, runtime)
        return fixture.state.handlers.get('session_start') ?? []
      })
      const aggregateStart = aggregate.state.handlers.get('session_start')?.at(precedingSessionStarts.length)
      if (aggregateStart === undefined) {
        throw new Error('aggregate status-panel handler missing')
      }
      const aggregatePanel = panelContext()
      yield* tryPromiseEffect(() => asResult<Promise<unknown>>(aggregateStart({}, aggregatePanel.ctx)))

      const explicit = createFakePi()
      registerStatusPanel(explicit.pi, runtime)
      const explicitPanel = panelContext()
      yield* tryPromiseEffect(() => explicit.emit('session_start', {}, explicitPanel.ctx))

      yield* tryPromiseEffect(() =>
        runtime.runPromise(
          AgentActivity.pipe(Effect.flatMap((activity) => activity.publish([{ color: 'accent', name: 'shared-agent', profile: 'scout' }])))
        )
      )

      expect(aggregatePanel.render()).toContain('shared-agent')
      expect(explicitPanel.render()).toContain('shared-agent')
    })
  )
})
