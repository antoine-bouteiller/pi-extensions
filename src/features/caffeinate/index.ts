import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { type AppRuntime } from '#shared/effect/app_services'

import { makeKeepAwake, productionDependencies, type CaffeinateDependencies } from './keep_awake.js'

export const register = (pi: ExtensionAPI, _runtime: AppRuntime, dependencies: CaffeinateDependencies = productionDependencies): void => {
  if (dependencies.isSubagent) {
    return
  }

  const keepAwake = makeKeepAwake(dependencies)

  pi.on('agent_start', keepAwake.start)
  pi.on('agent_settled', (_event, ctx) => (ctx.isIdle() ? keepAwake.stop() : undefined))
  pi.on('session_shutdown', keepAwake.stop)
}
