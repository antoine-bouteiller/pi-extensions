import { NodeFileSystem } from '@effect/platform-node'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect, Fiber } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { TestClock } from 'effect/testing'

describe('bun-effect shim', () => {
  it.effect('runs an effect', () =>
    Effect.gen(function* () {
      expect(yield* Effect.succeed(42)).toBe(42)
    })
  )

  it.effect('virtual clock: 1h sleep completes with no real delay', () =>
    Effect.gen(function* () {
      const started = Date.now()
      const fiber = yield* Effect.forkChild(Effect.as(Effect.sleep('1 hour'), 'woke'))
      yield* TestClock.adjust('1 hour')
      expect(yield* Fiber.join(fiber)).toBe('woke')
      expect(Date.now() - started).toBeLessThan(500)
    })
  )

  it.effect('timeout fires on virtual time', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.sleep('10 minutes').pipe(Effect.timeout('5 minutes'), Effect.result))
      yield* TestClock.adjust('6 minutes')
      expect((yield* Fiber.join(fiber))._tag).toBe('Failure')
    })
  )

  const log: string[] = []
  it.scoped('acquires inside the scope', () =>
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

  it('released after the scoped test finished', () => {
    expect(log).toEqual(['acquire', 'release'])
  })
})

describe('node platform layer', () => {
  it.effect('reads a file through the Node FileSystem layer', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem
      const pkg = yield* fs.readFileString('package.json')
      expect(JSON.parse(pkg).name).toBe('pi-extensions')
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )
})
