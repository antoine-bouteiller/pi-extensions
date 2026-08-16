import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { it as effectIt, type Vitest } from '@effect/vitest'
import { Data, Effect, Layer, type FileSystem, type Path, type Scope } from 'effect'
import { it as vitestIt } from 'vitest'

export { describe, expect } from 'vitest'

export class PromiseEffectError extends Data.TaggedError('PromiseEffectError')<{ readonly cause: unknown }> {}

export const tryEffect = <Success>(evaluate: () => Success): Effect.Effect<Success, PromiseEffectError> =>
  Effect.try({ catch: (cause) => new PromiseEffectError({ cause }), try: evaluate })

export const tryPromiseEffect = <Success>(evaluate: () => PromiseLike<Success>): Effect.Effect<Success, PromiseEffectError> =>
  Effect.tryPromise({ catch: (cause) => new PromiseEffectError({ cause }), try: evaluate })

export const promiseFromEffect = <Success, Failure>(effect: Effect.Effect<Success, Failure>): Promise<Success> =>
  Effect.runPromise(effect).catch((error: unknown) => Promise.reject(error instanceof PromiseEffectError ? error.cause : error))

type TestServices = FileSystem.FileSystem | Path.Path | Scope.Scope
type Test = Vitest.Test<TestServices>
const nodeEnv = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const wrap =
  (register: Vitest.Test<Scope.Scope>): Test =>
  (name, self, timeout) =>
    register(name, (context) => self(context).pipe(Effect.provide(nodeEnv)), timeout)

const effect = Object.assign(wrap(effectIt.effect), {
  skip: wrap(effectIt.effect.skip),
  skipIf: (condition: unknown) => wrap(effectIt.effect.skipIf(condition)),
})

export const it = Object.assign(vitestIt, {
  effect,
  live: effectIt.live,
})
