import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { makeEventHandler } from '@/shared/effect/runtime.js'

import { defaultRulesEnvironment, makeRulesHandlers, type RulesEnvironment } from './rules.js'

export const register = (pi: ExtensionAPI, runtime: AppRuntime, environment: RulesEnvironment = defaultRulesEnvironment()): void => {
  const handlers = makeRulesHandlers(environment)
  const onEvent = makeEventHandler(runtime)

  pi.on('session_start', onEvent(handlers.clearInjections))
  pi.on('session_compact', onEvent(handlers.clearInjections))
  pi.on('session_tree', onEvent(handlers.clearInjections))
  pi.on('before_agent_start', onEvent(handlers.beforeAgentStart))
  pi.on('tool_result', onEvent(handlers.toolResult))
}
