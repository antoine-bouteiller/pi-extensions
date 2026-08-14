import { Deferred, Effect } from 'effect'

export const deferred = <Value>() => {
  const value = Deferred.makeUnsafe<Value>()
  return {
    promise: Effect.runPromise(Deferred.await(value)),
    resolve: (result: Value): void => {
      Effect.runSync(Deferred.succeed(value, result))
    },
  }
}
