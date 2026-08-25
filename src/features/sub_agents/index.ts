import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeaturePlugin } from '#shared/effect/feature'

import { makeSubagentFeature } from './agents.js'
import { type AgentManagerOptions } from './core.js'

type EagerFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'eager' }>

export const makeFeature = (managerOptions: AgentManagerOptions = {}) => {
  let implementation: ReturnType<typeof makeSubagentFeature> | undefined
  return {
    bootstrap: 'eager',
    id: 'sub-agents',
    implementation: {
      activate: (event, ctx) => (implementation === undefined ? Effect.void : implementation.activate(event, ctx)),
      deactivate: (_ctx, reason) => (implementation === undefined ? Effect.void : implementation.deactivate(reason)),
      register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
        implementation = makeSubagentFeature({ managerOptions, pi, runtime })
        pi.on('before_agent_start', implementation.onBeforeAgentStart)
        pi.registerTool(implementation.spawnAgentTool)
        pi.registerTool(implementation.waitAgentTool)
        pi.registerTool(implementation.waitAllAgentsTool)
        pi.registerTool(implementation.listAgentsTool)
        pi.registerTool(implementation.readAgentResponseTool)
        pi.registerTool(implementation.sendMessageTool)
        pi.registerTool(implementation.interruptAgentTool)
        pi.registerCommand('subagent', implementation.subagentCommand)
        pi.registerCommand('agents', implementation.browseAgentsCommand)
        pi.registerCommand('subagents', implementation.browseAgentsCommand)
        pi.registerMessageRenderer(implementation.completionMessageType, implementation.renderCompletionMessage)
      },
    },
    status: { icon: '👥', name: 'sub-agents' },
  } satisfies EagerFeaturePlugin
}

export const feature = makeFeature()
