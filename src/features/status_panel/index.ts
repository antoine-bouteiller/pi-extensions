import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { makeEventHandler } from '@/shared/effect/runtime.js'

import { makePanelController, recordSubagentQuota, type StatusPanelDependencies } from './panel.js'

const registerImpl = (pi: ExtensionAPI, runtime: AppRuntime, dependencies: StatusPanelDependencies = {}): void => {
  if (process.env.PI_SUBAGENT_OWNER_TOKEN !== undefined) {
    pi.on('after_provider_response', recordSubagentQuota)
    return
  }

  const handlers = makePanelController({ dependencies, pi, runtime })
  const onEvent = makeEventHandler(runtime)

  pi.on('session_start', onEvent(handlers.sessionStart))
  pi.on('model_select', onEvent(handlers.modelSelect))
  pi.on('thinking_level_select', onEvent(handlers.thinkingLevelSelect))
  pi.on('agent_start', onEvent(handlers.agentStart))
  pi.on('turn_end', onEvent(handlers.turnEnd))
  pi.on('agent_settled', onEvent(handlers.agentSettled))
  pi.on('after_provider_response', onEvent(handlers.afterProviderResponse))
  pi.on('session_shutdown', onEvent(handlers.sessionShutdown))
}

export const register: {
  (runtime: AppRuntime, dependencies?: StatusPanelDependencies): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime, dependencies?: StatusPanelDependencies): void
} = Function.dual((args) => typeof args[0].on === 'function', registerImpl)
