import { Data, Deferred, Effect, Exit, Scope } from 'effect'
import { ChildProcess } from 'effect/unstable/process'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

export class CaffeinateError extends Data.TaggedError('CaffeinateError')<{ readonly cause: unknown }> {}

interface CaffeinateProcess {
  readonly exited: Effect.Effect<void>
  readonly kill: Effect.Effect<void>
  readonly unref: Effect.Effect<void, CaffeinateError>
}

export interface CaffeinateDependencies {
  readonly isSubagent: boolean
  readonly pid: number
  readonly platform: NodeJS.Platform
  readonly spawn: (command: string, args: readonly string[]) => Effect.Effect<CaffeinateProcess, CaffeinateError, ChildProcessSpawner>
}

export interface KeepAwake {
  readonly start: Effect.Effect<void, never, ChildProcessSpawner>
  readonly stop: Effect.Effect<void>
}

/** `stop` must not be able to hang the session: the child is force-killed if SIGTERM is ignored. */
const KILL_ESCALATION_MS = 1000
const STOP_TIMEOUT_MS = 2000

const spawnCaffeinate = (command: string, args: readonly string[]): Effect.Effect<CaffeinateProcess, CaffeinateError, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const scope = Scope.makeUnsafe()
    const spawner = yield* ChildProcessSpawner
    const child = yield* spawner
      .spawn(
        ChildProcess.make(command, args, {
          detached: false,
          forceKillAfter: KILL_ESCALATION_MS,
          stderr: 'ignore',
          stdin: 'ignore',
          stdout: 'ignore',
        })
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
        Effect.mapError((cause) => new CaffeinateError({ cause }))
      )

    return {
      exited: child.exitCode.pipe(Effect.ignore, Effect.ensuring(Scope.close(scope, Exit.void))),
      kill: child.kill().pipe(Effect.ignore),
      unref: child.unref.pipe(Effect.asVoid, Effect.ignore),
    }
  })

export const productionDependencies: CaffeinateDependencies = {
  isSubagent: process.env.PI_SUBAGENT_OWNER_TOKEN !== undefined,
  pid: process.pid,
  platform: process.platform,
  spawn: spawnCaffeinate,
}

interface RunningCaffeinate {
  readonly completion: Deferred.Deferred<void>
  child?: CaffeinateProcess
  cancelled: boolean
  killed: boolean
}

const killCaffeinate = (current: RunningCaffeinate): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (current.child === undefined || current.killed) {
      return Effect.void
    }
    current.killed = true
    return current.child.kill
  })

export const makeKeepAwake = (dependencies: CaffeinateDependencies): KeepAwake => {
  let running: RunningCaffeinate | undefined

  const supervise = (current: RunningCaffeinate): Effect.Effect<void, never, ChildProcessSpawner> =>
    Effect.gen(function* () {
      const child = yield* dependencies.spawn('/usr/bin/caffeinate', ['-w', String(dependencies.pid)])
      current.child = child
      // A child that cannot be unrefed would outlive the session, so treat the failure as a cancellation.
      yield* child.unref.pipe(Effect.catchCause(() => Effect.sync(() => void (current.cancelled = true))))
      if (current.cancelled || running !== current) {
        yield* killCaffeinate(current)
      }
      yield* child.exited
    }).pipe(
      Effect.ignore,
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Deferred.succeed(current.completion, undefined)
          if (running === current) {
            running = undefined
          }
        })
      )
    )

  const start: Effect.Effect<void, never, ChildProcessSpawner> = Effect.gen(function* () {
    if (dependencies.platform !== 'darwin' || running !== undefined) {
      return
    }
    const current: RunningCaffeinate = { cancelled: false, completion: yield* Deferred.make<void>(), killed: false }
    running = current
    /*
     * Detached by design (spec [KD-7]): Pi awaits its event handlers, so supervising the child on the
     * caller's fiber would keep `agent_start` pending for the entire agent run. The fiber is bounded
     * by the child's lifetime and `stop` is the tracked teardown path.
     *
     * Started immediately so the spawn is reserved before `start` returns: a settlement racing the
     * spawn must find the child, or it would leave an unkillable process behind.
     */
    yield* Effect.forkDetach(supervise(current), { startImmediately: true })
  })

  const stop: Effect.Effect<void> = Effect.suspend(() => {
    const current = running
    if (current === undefined) {
      return Effect.void
    }
    running = undefined
    current.cancelled = true
    /*
     * Bounded so `agent_settled` and `session_shutdown` always return: an unresolved spawn or a
     * child that never reports exit would otherwise block the handler forever.
     */
    return Effect.raceFirst(
      Effect.gen(function* () {
        yield* Effect.forkDetach(killCaffeinate(current))
        yield* Deferred.await(current.completion)
      }),
      Effect.sleep(STOP_TIMEOUT_MS)
    )
  })

  return { start, stop }
}
