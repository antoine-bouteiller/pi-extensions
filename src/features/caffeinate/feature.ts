import { spawn } from 'node:child_process'

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'

interface CaffeinateProcess {
  readonly kill: () => boolean
  readonly once: (event: 'error' | 'exit', listener: () => void) => unknown
  readonly unref: () => void
}

interface CaffeinateDependencies {
  readonly isSubagent: boolean
  readonly pid: number
  readonly platform: NodeJS.Platform
  readonly spawn: (command: string, args: readonly string[]) => CaffeinateProcess
}

const productionDependencies: CaffeinateDependencies = {
  isSubagent: process.env.PI_SUBAGENT_OWNER_TOKEN !== undefined,
  pid: process.pid,
  platform: process.platform,
  spawn: (command, args) => spawn(command, args, { stdio: 'ignore' }),
}

const registerImpl = (pi: ExtensionAPI, _runtime: AppRuntime, dependencies: CaffeinateDependencies = productionDependencies): void => {
  if (dependencies.isSubagent) {
    return
  }

  let running: { child: CaffeinateProcess; exited: Promise<void> } | undefined

  pi.on('session_start', () => {
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
  })

  pi.on('session_shutdown', () => {
    const current = running
    if (current === undefined) {
      return Promise.resolve()
    }
    running = undefined
    current.child.kill()
    return current.exited
  })
}

export const register: {
  (runtime: AppRuntime, dependencies?: CaffeinateDependencies): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime, dependencies?: CaffeinateDependencies): void
} = Function.dual((args) => typeof args[0].on === 'function', registerImpl)
