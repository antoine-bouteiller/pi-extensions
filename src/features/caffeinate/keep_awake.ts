// oxlint-disable-next-line effecttsgo/node-builtin-import -- Spawns `caffeinate` detached and `unref()`s it so the helper never keeps Pi alive; Effect's scope-bound `ChildProcess` cannot express that lifetime.
import { spawn } from 'node:child_process'

interface CaffeinateProcess {
  readonly kill: () => boolean
  readonly once: (event: 'error' | 'exit', listener: () => void) => unknown
  readonly unref: () => void
}

export interface CaffeinateDependencies {
  readonly isSubagent: boolean
  readonly pid: number
  readonly platform: NodeJS.Platform
  readonly spawn: (command: string, args: readonly string[]) => CaffeinateProcess
}

export interface KeepAwake {
  readonly start: () => void
  readonly stop: () => Promise<void>
}

export const productionDependencies: CaffeinateDependencies = {
  isSubagent: process.env.PI_SUBAGENT_OWNER_TOKEN !== undefined,
  pid: process.pid,
  platform: process.platform,
  spawn: (command, args) => spawn(command, args, { stdio: 'ignore' }),
}

export const makeKeepAwake = (dependencies: CaffeinateDependencies): KeepAwake => {
  let running: { child: CaffeinateProcess; exited: Promise<void> } | undefined

  const start = (): void => {
    if (dependencies.platform !== 'darwin' || running !== undefined) {
      return
    }

    const child = dependencies.spawn('/usr/bin/caffeinate', ['-w', String(dependencies.pid)])
    const exit = Promise.withResolvers<void>()
    const started = { child, exited: exit.promise }
    running = started
    child.unref()

    const clear = (): void => {
      exit.resolve()
      if (running === started) {
        running = undefined
      }
    }
    child.once('error', clear)
    child.once('exit', clear)
  }

  const stop = (): Promise<void> => {
    const current = running
    if (current === undefined) {
      return Promise.resolve()
    }
    running = undefined
    current.child.kill()
    return current.exited
  }

  return { start, stop }
}
