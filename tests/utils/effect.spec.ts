import { Effect, Fiber, Schema } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { Path } from 'effect/Path'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '#tests/utils/effect'

describe('effect test harness', () => {
  it.effect('runs an effect', () =>
    Effect.gen(function* () {
      expect(yield* Effect.succeed(42)).toBe(42)
    })
  )

  it.effect('virtual clock: 1h sleep completes with no real delay', () =>
    Effect.gen(function* () {
      const started = performance.now()
      const fiber = yield* Effect.forkChild(Effect.as(Effect.sleep('1 hour'), 'woke'))
      yield* TestClock.adjust('1 hour')
      expect(yield* Fiber.join(fiber)).toBe('woke')
      expect(performance.now() - started).toBeLessThan(500)
    })
  )

  it.effect('timeout fires on virtual time', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.sleep('10 minutes').pipe(Effect.timeout('5 minutes'), Effect.result))
      yield* TestClock.adjust('6 minutes')
      expect((yield* Fiber.join(fiber))._tag).toBe('Failure')
    })
  )

  it.live('uses the live clock', () =>
    Effect.gen(function* () {
      const started = performance.now()
      yield* Effect.sleep('20 millis')
      expect(performance.now() - started).toBeGreaterThanOrEqual(15)
    })
  )

  const log: string[] = []
  it.effect('acquires inside the scope', () =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          log.push('acquire')
        }),
        () =>
          Effect.sync(() => {
            log.push('release')
          })
      )
      expect(log).toEqual(['acquire'])
    })
  )

  it.effect('released after the scoped test finished', () =>
    Effect.sync(() => {
      expect(log).toEqual(['acquire', 'release'])
    })
  )
})

describe('node platform layer', () => {
  it.effect('provides NodePath', () =>
    Effect.gen(function* () {
      const path = yield* Path
      expect(path.resolve('a', 'b')).toMatch(/a[/\\]b$/)
    })
  )

  it.effect('reads a file through the Node FileSystem layer', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem
      const pkg = yield* fs.readFileString('package.json')
      const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(pkg)
      expect(parsed).toMatchObject({ name: 'pi-extensions' })
    })
  )
})

describe('effect test modifiers', () => {
  it.effect.skip('collects effect.skip as skipped', () => Effect.die('must not run'))
  it.effect.skipIf(true)('collects effect.skipIf as skipped', () => Effect.die('must not run'))
})
