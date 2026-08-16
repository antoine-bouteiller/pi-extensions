import { Deferred, Effect, Fiber } from 'effect'
import { afterEach } from 'vitest'

import { describe, expect, it } from '#tests/utils/effect'

import { withProcessEnv } from './process_env'

const KEY = 'PI_TEST_WITH_PROCESS_ENV'
const original = process.env[KEY]
const readValue = (): string | undefined => process.env[KEY]
const setValue = (value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[KEY]
  } else {
    process.env[KEY] = value
  }
}

afterEach(() => setValue(original))

describe('withProcessEnv', () => {
  it.effect('restores an originally absent variable after success and failure', () =>
    Effect.gen(function* () {
      setValue(undefined)
      yield* withProcessEnv(KEY, 'temporary', () => Effect.sync(() => expect(readValue()).toBe('temporary')))
      expect(readValue()).toBeUndefined()

      const exit = yield* Effect.exit(withProcessEnv(KEY, 'temporary', () => Effect.fail('expected failure')))
      expect(exit._tag).toBe('Failure')
      expect(readValue()).toBeUndefined()
    })
  )

  it.effect('restores an originally present variable after success and failure', () =>
    Effect.gen(function* () {
      setValue('original')
      yield* withProcessEnv(KEY, 'temporary', () => Effect.sync(() => expect(readValue()).toBe('temporary')))
      expect(readValue()).toBe('original')

      const exit = yield* Effect.exit(withProcessEnv(KEY, 'temporary', () => Effect.fail('expected failure')))
      expect(exit._tag).toBe('Failure')
      expect(readValue()).toBe('original')

      const thrown = yield* Effect.exit(
        withProcessEnv(KEY, 'temporary', (): Effect.Effect<never> => {
          throw new Error('expected synchronous throw')
        })
      )
      expect(thrown._tag).toBe('Failure')
      expect(readValue()).toBe('original')
    })
  )

  it.effect('restores the variable when use is interrupted', () =>
    Effect.gen(function* () {
      setValue('original')
      const acquired = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        withProcessEnv(KEY, 'temporary', () => Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.never)))
      )

      yield* Deferred.await(acquired)
      expect(readValue()).toBe('temporary')
      yield* Fiber.interrupt(fiber)
      expect(readValue()).toBe('original')
    })
  )
})
