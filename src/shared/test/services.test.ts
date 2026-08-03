import { describe, expect, it } from 'bun:test'

import { Effect, Layer, ManagedRuntime } from 'effect'

import { asExtensionContext } from '#test-utils/casts'

import { perInvocation } from '../../effect/runtime.js'
import { runningAgents } from '../agent_activity.js'
import { AgentActivity, AgentActivityLive, StatusBar, StatusBarLive } from '../services.js'
import { statusBar } from '../status_bar.js'

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
  it('gives two independent extension runtimes the same store instances', async () => {
    const subAgentsRuntime = ManagedRuntime.make(Layer.mergeAll(StatusBarLive, AgentActivityLive))
    const statusPanelRuntime = ManagedRuntime.make(Layer.mergeAll(StatusBarLive, AgentActivityLive))

    await subAgentsRuntime.runPromise(
      Effect.gen(function* () {
        const activity = yield* AgentActivity
        yield* activity.publish([{ color: 'accent', name: 'scout' }])
      })
    )

    const seen = await statusPanelRuntime.runPromise(AgentActivity.pipe(Effect.map((activity) => activity.list())))

    expect(seen.map((agent) => agent.name)).toEqual(['scout'])

    await subAgentsRuntime.dispose()
    await statusPanelRuntime.dispose()
    runningAgents.publish([])
  })

  it('lets one runtime observe a status published by another', async () => {
    const producer = ManagedRuntime.make(StatusBarLive)
    const consumer = ManagedRuntime.make(StatusBarLive)
    const { ctx } = uiContext()

    await producer.runPromise(
      Effect.gen(function* () {
        const bar = yield* StatusBar
        yield* bar.channel('mcp', { priority: 30, tone: 'muted' }).set({ text: '2 servers' })
      }).pipe(Effect.provide(perInvocation(ctx)))
    )

    const entries = await consumer.runPromise(StatusBar.pipe(Effect.map((bar) => bar.list())))
    expect(entries.find((entry) => entry.key === 'mcp')?.text).toBe('2 servers')

    await producer.runPromise(
      Effect.gen(function* () {
        const bar = yield* StatusBar
        yield* bar.channel('mcp').clear
      }).pipe(Effect.provide(perInvocation(ctx)))
    )
    expect(statusBar.has('mcp')).toBe(false)

    await producer.dispose()
    await consumer.dispose()
  })
})

describe('status channel service', () => {
  it('mirrors into Pi and applies channel defaults', async () => {
    const runtime = ManagedRuntime.make(StatusBarLive)
    const { ctx, statuses } = uiContext()

    await runtime.runPromise(
      Effect.gen(function* () {
        const bar = yield* StatusBar
        const channel = bar.channel('guard', { icon: '🛡️', tone: 'warning' })
        yield* channel.set({ text: 'armed' })
        yield* channel.clear
      }).pipe(Effect.provide(perInvocation(ctx)))
    )

    expect(statuses).toEqual([
      { key: 'guard', text: '🛡️ armed' },
      { key: 'guard', text: undefined },
    ])
    await runtime.dispose()
  })

  it('still records the status when there is no UI to mirror into', async () => {
    const runtime = ManagedRuntime.make(StatusBarLive)

    await runtime.runPromise(
      Effect.gen(function* () {
        const bar = yield* StatusBar
        yield* bar.channel('headless').set({ text: 'recorded' })
      }).pipe(Effect.provide(perInvocation(headlessContext())))
    )

    expect(statusBar.list().find((entry) => entry.key === 'headless')?.text).toBe('recorded')

    await runtime.runPromise(
      Effect.gen(function* () {
        const bar = yield* StatusBar
        yield* bar.channel('headless').clear
      }).pipe(Effect.provide(perInvocation(headlessContext())))
    )
    await runtime.dispose()
  })

  it('notifies subscribers of both stores', async () => {
    const runtime = ManagedRuntime.make(Layer.mergeAll(StatusBarLive, AgentActivityLive))
    let statusNotifications = 0
    let agentNotifications = 0

    const unsubscribes = await runtime.runPromise(
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

    await runtime.runPromise(
      Effect.gen(function* () {
        const bar = yield* StatusBar
        const activity = yield* AgentActivity
        yield* bar.channel('sub').set({ text: 'one' })
        yield* activity.publish([{ color: 'success', name: 'worker' }])
      }).pipe(Effect.provide(perInvocation(headlessContext())))
    )

    expect([statusNotifications, agentNotifications]).toEqual([1, 1])

    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
    await runtime.runPromise(
      Effect.gen(function* () {
        const bar = yield* StatusBar
        yield* bar.channel('sub').clear
      }).pipe(Effect.provide(perInvocation(headlessContext())))
    )
    runningAgents.publish([])
    await runtime.dispose()
  })
})
