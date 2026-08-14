import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect } from 'effect'

import { register as caffeinate } from '@/features/caffeinate/index.js'

interface FakeChild {
  readonly exit: PromiseWithResolvers<void>
  killCalls: number
  unrefCalls: number
}

const createHarness = (platform: NodeJS.Platform = 'darwin', exitOnKill = true, isSubagent = false, deferSpawn = false, failSpawns = 0) => {
  const fixture = createFakePi()
  const children: FakeChild[] = []
  const spawns: { args: readonly string[]; command: string }[] = []
  const spawnGate = deferSpawn ? Promise.withResolvers<void>() : undefined
  let remainingFailures = failSpawns

  caffeinate(fixture.pi, runtime, {
    isSubagent,
    pid: 1234,
    platform,
    spawn: (command, args) => {
      spawns.push({ args, command })
      if (remainingFailures > 0) {
        remainingFailures -= 1
        return Promise.reject(new Error('spawn failed'))
      }
      const child: FakeChild = { exit: Promise.withResolvers<void>(), killCalls: 0, unrefCalls: 0 }
      children.push(child)
      return (spawnGate?.promise ?? Promise.resolve()).then(() => ({
        exited: child.exit.promise,
        kill: () => {
          child.killCalls += 1
          if (exitOnKill) {
            child.exit.resolve()
          }
          return Promise.resolve()
        },
        unref: () => {
          child.unrefCalls += 1
          return Promise.resolve()
        },
      }))
    },
  })

  const settle = (isIdle = true) => fixture.emit('agent_settled', {}, { isIdle: () => isIdle })
  return { children, fixture, settle, spawnGate, spawns }
}

describe('caffeinate', () => {
  it.effect('runs caffeinate only while the agent is active', () =>
    Effect.gen(function* () {
      const harness = createHarness()

      yield* Effect.promise(() => harness.fixture.emit('session_start'))
      expect(harness.spawns).toHaveLength(0)

      yield* Effect.promise(() => harness.fixture.emit('agent_start'))
      yield* Effect.promise(() => harness.settle())

      expect(harness.spawns).toEqual([{ args: ['-w', '1234'], command: '/usr/bin/caffeinate' }])
      expect(harness.children[0]?.unrefCalls).toBe(1)
      expect(harness.children[0]?.killCalls).toBe(1)
    })
  )

  it.effect('does nothing outside macOS', () =>
    Effect.gen(function* () {
      const harness = createHarness('linux')

      yield* Effect.promise(() => harness.fixture.emit('agent_start'))
      yield* Effect.promise(() => harness.settle())

      expect(harness.spawns).toHaveLength(0)
    })
  )

  it.effect('does not register in subagents', () =>
    Effect.sync(() => {
      const harness = createHarness('darwin', true, true)

      expect(harness.fixture.state.handlers.size).toBe(0)
      expect(harness.spawns).toHaveLength(0)
    })
  )

  it.effect('keeps one process until the agent settles and tolerates repeated settled events', () =>
    Effect.gen(function* () {
      const harness = createHarness()

      yield* Effect.promise(() => harness.fixture.emit('agent_start'))
      yield* Effect.promise(() => harness.fixture.emit('agent_start'))
      yield* Effect.promise(() => harness.fixture.emit('agent_end'))
      expect(harness.children[0]?.killCalls).toBe(0)

      yield* Effect.promise(() => harness.settle())
      yield* Effect.promise(() => harness.settle())

      expect(harness.children).toHaveLength(1)
      expect(harness.children[0]?.killCalls).toBe(1)
    })
  )

  it.effect('starts caffeinate again for the next agent run', () =>
    Effect.gen(function* () {
      const harness = createHarness()

      yield* Effect.promise(() => harness.fixture.emit('agent_start'))
      yield* Effect.promise(() => harness.settle())
      yield* Effect.promise(() => harness.fixture.emit('agent_start'))
      yield* Effect.promise(() => harness.settle())

      expect(harness.children).toHaveLength(2)
      expect(harness.children.map((child) => child.killCalls)).toEqual([1, 1])
    })
  )

  it.effect('waits for caffeinate to exit when the agent settles', () =>
    Effect.gen(function* () {
      const harness = createHarness('darwin', false)
      yield* Effect.promise(() => harness.fixture.emit('agent_start'))
      let stopped = false

      const settled = harness.settle().then(() => {
        stopped = true
      })
      yield* Effect.promise(() => Promise.resolve())
      expect(stopped).toBeFalse()

      harness.children[0]?.exit.resolve()
      yield* Effect.promise(() => settled)

      expect(stopped).toBeTrue()
    })
  )

  it.live('stops within a bounded deadline even when the child never reports its exit', () =>
    Effect.gen(function* () {
      const harness = createHarness('darwin', false)
      yield* Effect.promise(() => harness.fixture.emit('agent_start'))

      // The child's `exit` deferred is deliberately never resolved.
      yield* Effect.promise(() => harness.settle())

      expect(harness.children[0]?.killCalls).toBeGreaterThan(0)
    })
  )

  it.effect('reserves a pending spawn and kills it when settlement wins the race', () =>
    Effect.gen(function* () {
      const harness = createHarness('darwin', true, false, true)

      yield* Effect.promise(() => harness.fixture.emit('agent_start'))
      yield* Effect.promise(() => harness.fixture.emit('agent_start'))
      expect(harness.spawns).toHaveLength(1)

      let stopped = false
      const settled = harness.settle().then(() => {
        stopped = true
      })
      yield* Effect.promise(() => Promise.resolve())
      expect(stopped).toBeFalse()

      harness.spawnGate?.resolve()
      yield* Effect.promise(() => settled)

      expect(harness.children[0]?.killCalls).toBe(1)
      expect(stopped).toBeTrue()
    })
  )
  it.effect('clears a failed spawn reservation so the next run can retry', () =>
    Effect.gen(function* () {
      const harness = createHarness('darwin', true, false, false, 1)

      yield* Effect.promise(() => harness.fixture.emit('agent_start'))
      yield* Effect.promise(() => Promise.resolve())
      yield* Effect.promise(() => Promise.resolve())
      yield* Effect.promise(() => harness.fixture.emit('agent_start'))
      yield* Effect.promise(() => harness.settle())

      expect(harness.spawns).toHaveLength(2)
      expect(harness.children[0]?.killCalls).toBe(1)
    })
  )
  it.effect('keeps caffeinate running when settlement already triggered follow-up work', () =>
    Effect.gen(function* () {
      const harness = createHarness()

      yield* Effect.promise(() => harness.fixture.emit('agent_start'))
      yield* Effect.promise(() => harness.settle(false))
      expect(harness.children[0]?.killCalls).toBe(0)

      yield* Effect.promise(() => harness.settle())
      expect(harness.children[0]?.killCalls).toBe(1)
    })
  )

  it.effect('stops caffeinate on session shutdown as a fallback', () =>
    Effect.gen(function* () {
      const harness = createHarness()

      yield* Effect.promise(() => harness.fixture.emit('agent_start'))
      yield* Effect.promise(() => harness.fixture.emit('session_shutdown'))

      expect(harness.children[0]?.killCalls).toBe(1)
    })
  )
})
