import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { ChildProcess, makeChildProcessLive, type PlatformChild, type ProcessPlatform } from '@/features/sub_agents/process.js'

const child: PlatformChild = {
  closeInput: Effect.void,
  isAlive: () => false,
  pid: 42,
  readStdout: Effect.void.pipe(Effect.as(undefined)),
  release: Effect.void,
  wait: Effect.succeed(0),
  write: () => Effect.void,
}

describe('ChildProcess', () => {
  it.effect('captures a birth marker at spawn and sends cooperative interrupt before force signalling', () => {
    const writes: string[] = []
    let forced = false
    const platform: ProcessPlatform = {
      birthMarker: () => Effect.succeed('birth'),
      forceTerminate: () =>
        Effect.sync(() => {
          forced = true
        }),
      spawn: () =>
        Effect.succeed({
          ...child,
          isAlive: () => true,
          write: (frame) =>
            Effect.sync(() => {
              writes.push(frame)
            }),
        }),
    }
    return Effect.gen(function* () {
      const process = yield* ChildProcess
      const running = yield* process.spawn({ args: [], command: 'worker', cwd: '/', environment: {} })
      expect(running.identity).toEqual({ birthMarker: 'birth', pid: 42 })
      yield* process.interruptVerified(running, '{"type":"interrupt"}\n')
      expect(writes).toEqual(['{"type":"interrupt"}\n'])
      expect(forced).toBe(false)
    }).pipe(Effect.provide(makeChildProcessLive(platform)))
  })

  it.effect('forces only after the five-second virtual grace and revalidates identity before signalling', () => {
    const writes: string[] = []
    let signals = 0
    let markerReads = 0
    const platform: ProcessPlatform = {
      birthMarker: () =>
        Effect.sync(() => {
          markerReads += 1
          return markerReads === 1 ? 'birth' : 'reused'
        }),
      forceTerminate: () =>
        Effect.sync(() => {
          signals += 1
        }),
      spawn: () =>
        Effect.succeed({
          ...child,
          isAlive: () => true,
          wait: Effect.never,
          write: (frame) =>
            Effect.sync(() => {
              writes.push(frame)
            }),
        }),
    }
    return Effect.gen(function* () {
      const process = yield* ChildProcess
      const running = yield* process.spawn({ args: [], command: 'worker', cwd: '/', environment: {} })
      const interruption = yield* Effect.forkDetach(process.interruptVerified(running, 'interrupt\n'))
      yield* Effect.yieldNow
      expect(signals).toBe(0)
      yield* TestClock.adjust('5 seconds')
      yield* Fiber.join(interruption)
      expect(writes).toEqual(['interrupt\n'])
      expect(signals).toBe(0)
    }).pipe(Effect.provide(makeChildProcessLive(platform)))
  })

  it.effect('does not signal exited, unreadable, or mismatched identities', () => {
    const outcomes: string[] = []
    let signals = 0
    const platform: ProcessPlatform = {
      birthMarker: (pid) => {
        if (pid === 1) {
          return Effect.void.pipe(Effect.as(undefined))
        }
        if (pid === 2) {
          return Effect.succeed('other')
        }
        return Effect.succeed('birth')
      },
      forceTerminate: () =>
        Effect.sync(() => {
          signals += 1
        }),
      spawn: () => Effect.succeed(child),
    }
    return Effect.gen(function* () {
      const process = yield* ChildProcess
      outcomes.push(yield* process.terminateVerified({ birthMarker: 'birth', pid: 1 }))
      outcomes.push(yield* process.terminateVerified({ birthMarker: 'birth', pid: 2 }))
      expect(outcomes).toEqual(['unverifiable', 'mismatch'])
      expect(signals).toBe(0)
    }).pipe(Effect.provide(makeChildProcessLive(platform)))
  })

  it.effect('refuses an unverifiable process identity', () => {
    const platform: ProcessPlatform = {
      birthMarker: () => Effect.void.pipe(Effect.as(undefined)),
      forceTerminate: () => Effect.void,
      spawn: () => Effect.succeed(child),
    }
    return Effect.gen(function* () {
      const process = yield* ChildProcess
      const outcome = yield* Effect.result(process.spawn({ args: [], command: 'worker', cwd: '/', environment: {} }))
      expect(outcome._tag).toBe('Failure')
    }).pipe(Effect.provide(makeChildProcessLive(platform)))
  })
})
