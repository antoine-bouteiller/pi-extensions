import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeatureOptions, type FeaturePlugin } from '#shared/effect/feature'
import { makeEventHandler, runtimeEnvironment } from '#shared/effect/runtime'

import { makePanelController, recordSubagentQuota, type StatusPanelDependencies } from './panel.js'

export const feature = ((options: FeatureOptions<StatusPanelDependencies> = {}) => {
  const dependencies = options.dependencies ?? {}
  let handlers: ReturnType<typeof makePanelController> | undefined
  let isSubagent = false
  return {
    bootstrap: 'eager',
    id: 'status-panel',
    implementation: {
      activate: (event, ctx) => (handlers === undefined ? Effect.void : handlers.sessionStart(event, ctx)),
      deactivate: (ctx, _reason) =>
        handlers === undefined ? Effect.void : handlers.sessionShutdown({ reason: 'quit', type: 'session_shutdown' }, ctx),
      register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
        const onEvent = makeEventHandler(runtime)
        isSubagent = runtimeEnvironment(runtime).get('PI_SUBAGENT_OWNER_TOKEN') !== undefined
        if (isSubagent) {
          pi.on('after_provider_response', onEvent(recordSubagentQuota))
          return
        }
        handlers = makePanelController({ dependencies, pi })
        pi.on('model_select', onEvent(handlers.modelSelect))
        pi.on('thinking_level_select', onEvent(handlers.thinkingLevelSelect))
        pi.on('agent_start', onEvent(handlers.agentStart))
        pi.on('message_end', onEvent(handlers.messageEnd))
        pi.on('turn_end', onEvent(handlers.turnEnd))
        pi.on('agent_settled', onEvent(handlers.agentSettled))
        pi.on('after_provider_response', onEvent(handlers.afterProviderResponse))
      },
    },
    status: { icon: '📊', name: 'status-panel' },
  }
}) satisfies FeaturePlugin<StatusPanelDependencies>
