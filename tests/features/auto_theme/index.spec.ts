import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Deferred, Effect, Option } from 'effect'

import { register as autoTheme, type AutoThemeDependencies } from '@/features/auto_theme/index.js'
import { type SystemTheme } from '@/features/auto_theme/theme.js'

const createHarness = (
  themes: Effect.Effect<Option.Option<SystemTheme>>[],
  isSubagent = false,
  themeSetting = 'catppuccin-latte/catppuccin-mocha'
) => {
  const fixture = createFakePi()
  const sleepers: (() => void)[] = []
  const applied: unknown[] = []
  let sleeperRegistered = Promise.withResolvers<void>()
  let index = 0
  const dependencies: AutoThemeDependencies = {
    detect: Effect.suspend(() => themes[index++] ?? Effect.succeed(Option.none())),
    isSubagent,
    sleep: Effect.callback<void>((resume) => {
      sleepers.push(() => resume(Effect.void))
      sleeperRegistered.resolve()
    }),
    themeSetting,
  }
  autoTheme(fixture.pi, runtime, dependencies)
  const context = {
    mode: 'tui',
    ui: {
      getTheme: (name: string) => ({ name }),
      setTheme: (theme: unknown) => {
        applied.push(theme)
        return { success: true }
      },
    },
  }
  const waitForSleeper = () =>
    sleeperRegistered.promise.then(() => {
      sleeperRegistered = Promise.withResolvers<void>()
    })
  return { applied, context, fixture, sleepers, waitForSleeper }
}

describe('auto theme', () => {
  it.effect('applies the system theme and follows changes without repeating it', () =>
    Effect.gen(function* () {
      const harness = createHarness([Effect.succeed(Option.some('dark')), Effect.succeed(Option.some('dark')), Effect.succeed(Option.some('light'))])
      yield* Effect.promise(() => harness.fixture.emit('session_start', {}, harness.context))
      yield* Effect.promise(harness.waitForSleeper)

      harness.sleepers[0]?.()
      yield* Effect.promise(harness.waitForSleeper)
      harness.sleepers[1]?.()
      yield* Effect.promise(harness.waitForSleeper)

      expect(harness.applied).toEqual([{ name: 'catppuccin-mocha' }, { name: 'catppuccin-latte' }])
      yield* Effect.promise(() => harness.fixture.emit('session_shutdown'))
    })
  )

  it.effect('does nothing when the theme setting is not a light/dark pair', () =>
    Effect.gen(function* () {
      const harness = createHarness([Effect.succeed(Option.some('dark'))], false, 'catppuccin-mocha')
      yield* Effect.promise(() => harness.fixture.emit('session_start', {}, harness.context))
      expect(harness.applied).toEqual([])
      yield* Effect.promise(() => harness.fixture.emit('session_shutdown'))
    })
  )

  it.effect('keeps the current theme when system detection is unavailable', () =>
    Effect.gen(function* () {
      const harness = createHarness([Effect.succeed(Option.none())])
      yield* Effect.promise(() => harness.fixture.emit('session_start', {}, harness.context))
      yield* Effect.promise(harness.waitForSleeper)
      expect(harness.applied).toEqual([])
      yield* Effect.promise(() => harness.fixture.emit('session_shutdown'))
    })
  )

  it.effect('interrupts an in-flight detection on shutdown', () =>
    Effect.gen(function* () {
      const detection = yield* Deferred.make<Option.Option<SystemTheme>>()
      const harness = createHarness([Deferred.await(detection)])
      yield* Effect.promise(() => harness.fixture.emit('session_start', {}, harness.context))

      yield* Effect.promise(() => harness.fixture.emit('session_shutdown'))
      yield* Deferred.succeed(detection, Option.some('dark'))

      expect(harness.applied).toEqual([])
      expect(harness.sleepers).toHaveLength(0)
    })
  )

  it.effect('runs only in the main TUI session', () =>
    Effect.gen(function* () {
      const harness = createHarness([Effect.succeed(Option.some('dark'))])
      yield* Effect.promise(() => harness.fixture.emit('session_start', {}, { ...harness.context, mode: 'print' }))
      expect(harness.applied).toEqual([])

      const subagent = createHarness([Effect.succeed(Option.some('dark'))], true)
      expect(subagent.fixture.state.handlers.size).toBe(0)
    })
  )
})
