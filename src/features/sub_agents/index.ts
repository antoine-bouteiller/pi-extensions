import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'

import { makeSubagentFeature } from './agents.js'
import { type AgentManagerOptions } from './core.js'

const registerImpl = (pi: ExtensionAPI, runtime: AppRuntime, managerOptions: AgentManagerOptions = {}): void => {
  const feature = makeSubagentFeature({ managerOptions, pi, runtime })

  pi.on('session_start', feature.onSessionStart)
  pi.on('before_agent_start', feature.onBeforeAgentStart)
  pi.on('session_shutdown', feature.onSessionShutdown)

  pi.registerTool(feature.spawnAgentTool)
  pi.registerTool(feature.waitAgentTool)
  pi.registerTool(feature.waitAllAgentsTool)
  pi.registerTool(feature.listAgentsTool)
  pi.registerTool(feature.readAgentResponseTool)
  pi.registerTool(feature.sendMessageTool)
  pi.registerTool(feature.interruptAgentTool)

  pi.registerCommand('subagent', feature.subagentCommand)
  pi.registerCommand('agents', feature.browseAgentsCommand)
  pi.registerCommand('subagents', feature.browseAgentsCommand)
}

export const register: {
  (runtime: AppRuntime, managerOptions?: AgentManagerOptions): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime, managerOptions?: AgentManagerOptions): void
} = Function.dual((args) => typeof args[0].on === 'function', registerImpl)
