import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'

import { makeKeepAwake, productionDependencies, type CaffeinateDependencies } from './keep_awake.js'

const registerImpl = (pi: ExtensionAPI, _runtime: AppRuntime, dependencies: CaffeinateDependencies = productionDependencies): void => {
  if (dependencies.isSubagent) {
    return
  }

  const keepAwake = makeKeepAwake(dependencies)

  pi.on('agent_start', keepAwake.start)
  pi.on('agent_settled', (_event, ctx) => (ctx.isIdle() ? keepAwake.stop() : undefined))
  pi.on('session_shutdown', keepAwake.stop)
}

export const register: {
  (runtime: AppRuntime, dependencies?: CaffeinateDependencies): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime, dependencies?: CaffeinateDependencies): void
} = Function.dual((args) => typeof args[0].on === 'function', registerImpl)
