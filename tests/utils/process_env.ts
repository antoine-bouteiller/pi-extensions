import { Effect, Function } from 'effect'

const swapProcessEnv = (key: string, value: string | undefined): string | undefined => {
  const previous = process.env[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
  return previous
}

export const withProcessEnv: {
  <Success, Failure, Requirements>(
    value: string | undefined,
    use: () => Effect.Effect<Success, Failure, Requirements>
  ): (key: string) => Effect.Effect<Success, Failure, Requirements>
  <Success, Failure, Requirements>(
    key: string,
    value: string | undefined,
    use: () => Effect.Effect<Success, Failure, Requirements>
  ): Effect.Effect<Success, Failure, Requirements>
} = Function.dual(
  3,
  <Success, Failure, Requirements>(
    key: string,
    value: string | undefined,
    use: () => Effect.Effect<Success, Failure, Requirements>
  ): Effect.Effect<Success, Failure, Requirements> =>
    Effect.acquireUseRelease(
      Effect.sync(() => swapProcessEnv(key, value)),
      () => Effect.suspend(use),
      (previous) => Effect.sync(() => swapProcessEnv(key, previous))
    )
)
