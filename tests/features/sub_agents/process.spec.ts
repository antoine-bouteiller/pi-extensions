import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { DateTime, Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import {
  ChildProcess,
  macosProcessBirthMarker,
  makeChildProcessLive,
  type PlatformChild,
  type ProcessPlatform,
} from '@/features/sub_agents/process.js'
import { linuxProcessBirthMarker } from '@/shared/effect/bun_host_file_system.js'

const child: PlatformChild = {
  closeInput: Effect.void,
  isAlive: () => false,
  pid: 42,
  readStdout: Effect.void.pipe(Effect.as(undefined)),
  release: Effect.void,
  wait: Effect.succeed(0),
  write: () => Effect.void,
}

const expectPlausibleCurrentProcessStart = (seconds: number, now: number, thisYearStarted: number): void => {
  expect(seconds).toBeGreaterThanOrEqual(thisYearStarted)
  expect(seconds).toBeGreaterThanOrEqual(now - 5 * 60)
  expect(seconds).toBeLessThanOrEqual(now + 1)
}

const systemFileText = (path: string): string => {
  const result = Bun.spawnSync(['cat', path])
  expect(result.exitCode).toBe(0)
  return new TextDecoder().decode(result.stdout)
}

describe('ChildProcess', () => {
  it.live('reads a stable, plausible native birth marker for the current process', () =>
    Effect.gen(function* () {
      const now = (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) / 1000
      const currentYear = DateTime.getPartUtc(DateTime.makeUnsafe(now * 1000), 'year')
      const thisYearStarted = DateTime.toEpochSeconds(DateTime.makeUnsafe({ year: currentYear }))

      if (process.platform === 'linux') {
        const first = linuxProcessBirthMarker(process.pid)
        const second = linuxProcessBirthMarker(process.pid)
        expect(first?.length).toBeGreaterThan(0)
        expect(first).toBe(second)
        if (first === undefined) {
          throw new Error('Current process birth marker is unavailable')
        }

        const separator = first.lastIndexOf(':')
        const bootIdentifier = first.slice(0, separator)
        const startTicks = Number(first.slice(separator + 1))
        const processStat = systemFileText(`/proc/${process.pid}/stat`)
        const statStartTicks = Number(
          processStat
            .slice(processStat.lastIndexOf(')') + 2)
            .split(' ')
            .at(19)
        )
        const currentBootIdentifier = systemFileText('/proc/sys/kernel/random/boot_id').trim()
        const bootTime = /^btime (?<seconds>\d+)$/m.exec(systemFileText('/proc/stat'))
        const clockTickResult = Bun.spawnSync(['getconf', 'CLK_TCK'])
        const clockTicks = Number(new TextDecoder().decode(clockTickResult.stdout).trim())

        expect(bootIdentifier).toBe(currentBootIdentifier)
        expect(startTicks).toBe(statStartTicks)
        expect(bootTime).not.toBeNull()
        expect(clockTickResult.exitCode).toBe(0)
        expect(clockTicks).toBeGreaterThan(0)
        if (bootTime === null) {
          throw new Error('Linux boot time is unavailable')
        }
        expectPlausibleCurrentProcessStart(Number(bootTime.groups?.seconds) + startTicks / clockTicks, now, thisYearStarted)
        return
      }
      if (process.platform === 'darwin') {
        const first = macosProcessBirthMarker(process.pid)
        const second = macosProcessBirthMarker(process.pid)
        expect(first?.length).toBeGreaterThan(0)
        expect(first).toBe(second)
        if (first === undefined) {
          throw new Error('Current process birth marker is unavailable')
        }

        expectPlausibleCurrentProcessStart(Number(first.split(':', 1)[0]), now, thisYearStarted)
        return
      }
      expect(process.platform).toBe('win32')
    })
  )

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

  it.effect('closes and releases an unverifiable child without signalling its PID', () => {
    const operations: string[] = []
    const platform: ProcessPlatform = {
      birthMarker: () => Effect.void.pipe(Effect.as(undefined)),
      forceTerminate: () =>
        Effect.sync(() => {
          operations.push('terminate')
        }),
      spawn: () =>
        Effect.succeed({
          ...child,
          closeInput: Effect.sync(() => {
            operations.push('input')
          }),
          release: Effect.sync(() => {
            operations.push('release')
          }),
          wait: Effect.sync(() => {
            operations.push('wait')
            return 0
          }),
        }),
    }
    return Effect.gen(function* () {
      const process = yield* ChildProcess
      const outcome = yield* Effect.result(process.spawn({ args: [], command: 'worker', cwd: '/', environment: {} }))
      expect(outcome._tag).toBe('Failure')
      expect(operations).toEqual(['input', 'wait', 'release'])
    }).pipe(Effect.provide(makeChildProcessLive(platform)))
  })
})
