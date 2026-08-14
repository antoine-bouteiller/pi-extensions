import { Effect } from 'effect'

const swapProcessEnv = (key: string, value: string | undefined): string | undefined => {
  const previous = process.env[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
  return previous
}

export const withProcessEnv = <Success, Failure, Requirements>(
  key: string,
  value: string | undefined,
  use: () => Effect.Effect<Success, Failure, Requirements>
): Effect.Effect<Success, Failure, Requirements> =>
  Effect.acquireUseRelease(
    Effect.sync(() => swapProcessEnv(key, value)),
    () => Effect.suspend(use),
    (previous) => Effect.sync(() => swapProcessEnv(key, previous))
  )
