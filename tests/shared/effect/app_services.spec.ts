import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext } from '@tests/utils/casts.js'
import { Effect, Layer, ManagedRuntime } from 'effect'

import { AgentActivity, AgentActivityLive, StatusBar, StatusBarLive } from '@/shared/effect/app_services.js'
import { perInvocation } from '@/shared/effect/runtime.js'
import { runningAgents } from '@/shared/state/agent_activity.js'
import { statusBar } from '@/shared/state/status_bar.js'

const uiContext = () => {
  const statuses: { key: string; text: string | undefined }[] = []
  const ctx = asExtensionContext({
    hasUI: true,
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        statuses.push({ key, text })
      },
    },
  })
  return { ctx, statuses }
}

const headlessContext = () =>
  asExtensionContext({
    hasUI: false,
    ui: {
      setStatus: () => {
        throw new Error('setStatus must not be called without a UI')
      },
    },
  })

describe('cross-runtime sharing', () => {
  it.effect('gives two independent extension runtimes the same store instances', () =>
    Effect.gen(function* () {
      const subAgentsRuntime = ManagedRuntime.make(Layer.mergeAll(StatusBarLive, AgentActivityLive))
      const statusPanelRuntime = ManagedRuntime.make(Layer.mergeAll(StatusBarLive, AgentActivityLive))

      yield* Effect.promise(() =>
        subAgentsRuntime.runPromise(
          Effect.gen(function* () {
            const activity = yield* AgentActivity
            yield* activity.publish([{ color: 'accent', name: 'scout' }])
          })
        )
      )

      const seen = yield* Effect.promise(() => statusPanelRuntime.runPromise(AgentActivity.pipe(Effect.map((activity) => activity.list()))))

      expect(seen.map((agent) => agent.name)).toEqual(['scout'])

      yield* Effect.promise(() => subAgentsRuntime.dispose())
      yield* Effect.promise(() => statusPanelRuntime.dispose())
      runningAgents.publish([])
    })
  )

  it.effect('lets one runtime observe a status published by another', () =>
    Effect.gen(function* () {
      const producer = ManagedRuntime.make(StatusBarLive)
      const consumer = ManagedRuntime.make(StatusBarLive)
      const { ctx } = uiContext()

      yield* Effect.promise(() =>
        producer.runPromise(
          Effect.gen(function* () {
            const bar = yield* StatusBar
            yield* bar.channel('mcp', { priority: 30, tone: 'muted' }).set({ text: '2 servers' })
          }).pipe(Effect.provide(perInvocation(ctx)))
        )
      )

      const entries = yield* Effect.promise(() => consumer.runPromise(StatusBar.pipe(Effect.map((bar) => bar.list()))))
      expect(entries.find((entry) => entry.key === 'mcp')?.text).toBe('2 servers')

      yield* Effect.promise(() =>
        producer.runPromise(
          Effect.gen(function* () {
            const bar = yield* StatusBar
            yield* bar.channel('mcp').clear
          }).pipe(Effect.provide(perInvocation(ctx)))
        )
      )
      expect(statusBar.has('mcp')).toBe(false)

      yield* Effect.promise(() => producer.dispose())
      yield* Effect.promise(() => consumer.dispose())
    })
  )
})

describe('status channel service', () => {
  it.effect('mirrors into Pi and applies channel defaults', () =>
    Effect.gen(function* () {
      const runtime = ManagedRuntime.make(StatusBarLive)
      const { ctx, statuses } = uiContext()

      yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const bar = yield* StatusBar
            const channel = bar.channel('guard', { icon: '🛡️', tone: 'warning' })
            yield* channel.set({ text: 'armed' })
            yield* channel.clear
          }).pipe(Effect.provide(perInvocation(ctx)))
        )
      )

      expect(statuses).toEqual([
        { key: 'guard', text: '🛡️ armed' },
        { key: 'guard', text: undefined },
      ])
      yield* Effect.promise(() => runtime.dispose())
    })
  )

  it.effect('still records the status when there is no UI to mirror into', () =>
    Effect.gen(function* () {
      const runtime = ManagedRuntime.make(StatusBarLive)

      yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const bar = yield* StatusBar
            yield* bar.channel('headless').set({ text: 'recorded' })
          }).pipe(Effect.provide(perInvocation(headlessContext())))
        )
      )

      expect(statusBar.list().find((entry) => entry.key === 'headless')?.text).toBe('recorded')

      yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const bar = yield* StatusBar
            yield* bar.channel('headless').clear
          }).pipe(Effect.provide(perInvocation(headlessContext())))
        )
      )
      yield* Effect.promise(() => runtime.dispose())
    })
  )

  it.effect('notifies subscribers of both stores', () =>
    Effect.gen(function* () {
      const runtime = ManagedRuntime.make(Layer.mergeAll(StatusBarLive, AgentActivityLive))
      let statusNotifications = 0
      let agentNotifications = 0

      const unsubscribes = yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const bar = yield* StatusBar
            const activity = yield* AgentActivity
            return [
              bar.subscribe(() => {
                statusNotifications += 1
              }),
              activity.subscribe(() => {
                agentNotifications += 1
              }),
            ]
          })
        )
      )

      yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const bar = yield* StatusBar
            const activity = yield* AgentActivity
            yield* bar.channel('sub').set({ text: 'one' })
            yield* activity.publish([{ color: 'success', name: 'worker' }])
          }).pipe(Effect.provide(perInvocation(headlessContext())))
        )
      )

      expect([statusNotifications, agentNotifications]).toEqual([1, 1])

      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
      yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const bar = yield* StatusBar
            yield* bar.channel('sub').clear
          }).pipe(Effect.provide(perInvocation(headlessContext())))
        )
      )
      runningAgents.publish([])
      yield* Effect.promise(() => runtime.dispose())
    })
  )
})
