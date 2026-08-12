import { test } from 'bun:test'

import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Effect, Layer, type FileSystem, type Path, type Scope } from 'effect'
import { TestClock } from 'effect/testing'

export { describe, expect } from 'bun:test'

type Options = number | { timeout?: number }
const timeoutOf = (opts?: Options) => (typeof opts === 'number' ? opts : opts?.timeout)

/** Virtual time and the real Node platform by default. */
type TestServices = FileSystem.FileSystem | Path.Path | TestClock.TestClock
const testEnv: Layer.Layer<TestServices> = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, TestClock.layer())

const run = <Success, Failure>(eff: Effect.Effect<Success, Failure, TestServices>) => Effect.runPromise(Effect.provide(eff, testEnv))

const mkEffect = (runner: typeof test) => {
  function effectTest<Success, Failure>(name: string, fn: () => Effect.Effect<Success, Failure, TestServices>, opts?: Options): void
  function effectTest(name: string, fn: () => PromiseLike<void> | void, opts?: Options): void
  function effectTest<Success, Failure>(
    name: string,
    fn: () => Effect.Effect<Success, Failure, TestServices> | PromiseLike<void> | void,
    opts?: Options
  ): void {
    const timeout = timeoutOf(opts)
    runner(
      name,
      () => {
        const result = fn()
        return Effect.isEffect(result) ? run(result) : Promise.resolve(result)
      },
      timeout === undefined ? undefined : { timeout }
    )
  }
  return effectTest
}

const mkScoped =
  (runner: typeof test) =>
  <Success, Failure>(name: string, fn: () => Effect.Effect<Success, Failure, TestServices | Scope.Scope>, opts?: Options) => {
    const timeout = timeoutOf(opts)
    runner(name, () => run(Effect.scoped(fn())), timeout === undefined ? undefined : { timeout })
  }

/** Real clock. Required for tests that mix real I/O with Effect.sleep/timeout. */
const mkLive =
  (runner: typeof test) =>
  <Success, Failure>(name: string, fn: () => Effect.Effect<Success, Failure>, opts?: Options) => {
    const timeout = timeoutOf(opts)
    runner(name, () => Effect.runPromise(fn()), timeout === undefined ? undefined : { timeout })
  }

const mods = <Runner extends object>(make: (runner: typeof test) => Runner): Runner & { skip: Runner; skipIf: (condition: boolean) => Runner } =>
  Object.assign(make(test), { skip: make(test.skip), skipIf: (condition: boolean) => make(test.skipIf(condition)) })

// oxlint-disable-next-line effecttsgo/missing-pipeable-signature -- Bun's callable test API is not an Effect function and cannot expose a pipeable data-first overload.
export const it = Object.assign(test, {
  effect: mods(mkEffect),
  live: mods(mkLive),
  scoped: mods(mkScoped),
})
