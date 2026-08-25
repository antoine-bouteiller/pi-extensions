import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { type AppRuntime } from '#shared/effect/app_services'
import { makeEventHandler } from '#shared/effect/runtime'

import { makePanelController, recordSubagentQuota, type StatusPanelDependencies } from './panel.js'

export const register = (pi: ExtensionAPI, runtime: AppRuntime, dependencies: StatusPanelDependencies = {}): void => {
  const onEvent = makeEventHandler(runtime)
  if (process.env.PI_SUBAGENT_OWNER_TOKEN !== undefined) {
    pi.on('after_provider_response', onEvent(recordSubagentQuota))
    return
  }

  const handlers = makePanelController({ dependencies, pi, runtime })

  // oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-2a] §8.8; remove when lifecycle ownership migrates to src/config/feature_coordinator.ts
  pi.on('session_start', onEvent(handlers.sessionStart))
  pi.on('model_select', onEvent(handlers.modelSelect))
  pi.on('thinking_level_select', onEvent(handlers.thinkingLevelSelect))
  pi.on('agent_start', onEvent(handlers.agentStart))
  pi.on('turn_end', onEvent(handlers.turnEnd))
  pi.on('agent_settled', onEvent(handlers.agentSettled))
  pi.on('after_provider_response', onEvent(handlers.afterProviderResponse))
  // oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-2a] §8.8; remove when lifecycle ownership migrates to src/config/feature_coordinator.ts
  pi.on('session_shutdown', onEvent(handlers.sessionShutdown))
}
