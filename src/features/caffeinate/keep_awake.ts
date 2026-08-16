import { Effect, Exit, Scope } from 'effect'
import { ChildProcess } from 'effect/unstable/process'

import { nodeChildProcessSpawner } from '#shared/effect/node_services'

interface CaffeinateProcess {
  readonly exited: Promise<void>
  readonly kill: () => Promise<void>
  readonly unref: () => Promise<void>
}

export interface CaffeinateDependencies {
  readonly isSubagent: boolean
  readonly pid: number
  readonly platform: NodeJS.Platform
  readonly spawn: (command: string, args: readonly string[]) => Promise<CaffeinateProcess>
}

export interface KeepAwake {
  readonly start: () => void
  readonly stop: () => Promise<void>
}

/** `stop()` must not be able to hang the session: the child is force-killed if SIGTERM is ignored. */
const KILL_ESCALATION_MS = 1000
const STOP_TIMEOUT_MS = 2000

const spawnCaffeinate = (command: string, args: readonly string[]): Promise<CaffeinateProcess> => {
  const scope = Scope.makeUnsafe()
  const spawn = nodeChildProcessSpawner
    .spawn(
      ChildProcess.make(command, args, {
        detached: false,
        forceKillAfter: KILL_ESCALATION_MS,
        stderr: 'ignore',
        stdin: 'ignore',
        stdout: 'ignore',
      })
    )
    .pipe(Effect.provideService(Scope.Scope, scope))
  return Effect.runPromise(spawn).then(
    (child) => ({
      exited: Effect.runPromise(child.exitCode.pipe(Effect.ignore, Effect.ensuring(Scope.close(scope, Exit.void)))),
      kill: () => Effect.runPromise(child.kill().pipe(Effect.ignore)),
      unref: () => Effect.runPromise(child.unref.pipe(Effect.asVoid, Effect.ignore)),
    }),
    (error) => Effect.runPromise(Scope.close(scope, Exit.void)).then(() => Promise.reject(error))
  )
}

export const productionDependencies: CaffeinateDependencies = {
  isSubagent: process.env.PI_SUBAGENT_OWNER_TOKEN !== undefined,
  pid: process.pid,
  platform: process.platform,
  spawn: spawnCaffeinate,
}

interface RunningCaffeinate {
  readonly completion: PromiseWithResolvers<void>
  child?: CaffeinateProcess
  cancelled: boolean
  kill?: Promise<void>
}
const killCaffeinate = (current: RunningCaffeinate): Promise<void> | undefined => {
  if (current.child === undefined) {
    return undefined
  }
  return (current.kill ??= current.child.kill().catch(() => undefined))
}

export const makeKeepAwake = (dependencies: CaffeinateDependencies): KeepAwake => {
  let running: RunningCaffeinate | undefined

  const start = (): void => {
    if (dependencies.platform !== 'darwin' || running !== undefined) {
      return
    }

    const current: RunningCaffeinate = { cancelled: false, completion: Promise.withResolvers<void>() }
    running = current
    void dependencies
      .spawn('/usr/bin/caffeinate', ['-w', String(dependencies.pid)])
      .then((child) => {
        current.child = child
        return child
          .unref()
          .catch(() => {
            current.cancelled = true
          })
          .then(() => (current.cancelled || running !== current ? killCaffeinate(current) : undefined))
          .then(() => child.exited.catch(() => undefined))
      })
      .catch(() => undefined)
      .finally(() => {
        current.completion.resolve()
        if (running === current) {
          running = undefined
        }
      })
  }

  const stop = (): Promise<void> => {
    const current = running
    if (current === undefined) {
      return Promise.resolve()
    }
    running = undefined
    current.cancelled = true
    void killCaffeinate(current)
    /*
     * Bounded so `agent_settled` and `session_shutdown` always return: an unresolved spawn or a
     * child that never reports exit would otherwise block the handler forever.
     */
    return Effect.runPromise(
      Effect.raceFirst(
        Effect.promise(() => current.completion.promise),
        Effect.sleep(STOP_TIMEOUT_MS)
      )
    )
  }

  return { start, stop }
}
