import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeatureOptions, type FeaturePlugin } from '#shared/effect/feature'
import { makeEventHandler } from '#shared/effect/runtime'

import { makePanelController } from './panel.js'

export const feature = ((_options: FeatureOptions<undefined> = {}) => {
  let handlers: ReturnType<typeof makePanelController> | undefined
  return {
    id: 'status-panel',
    implementation: {
      activate: (event, ctx) => (handlers === undefined ? Effect.void : handlers.sessionStart(event, ctx)),
      deactivate: (ctx, _reason) =>
        handlers === undefined ? Effect.void : handlers.sessionShutdown({ reason: 'quit', type: 'session_shutdown' }, ctx),
      register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
        const onEvent = makeEventHandler(runtime)
        handlers = makePanelController(pi)
        pi.on('model_select', onEvent(handlers.modelSelect))
        pi.on('thinking_level_select', onEvent(handlers.thinkingLevelSelect))
        pi.on('message_end', onEvent(handlers.messageEnd))
        pi.on('turn_end', onEvent(handlers.turnEnd))
        pi.on('agent_settled', onEvent(handlers.agentSettled))
        pi.on('before_agent_start', onEvent(handlers.beforeAgentStart))
      },
    },
    status: { name: 'status-panel' },
  }
}) satisfies FeaturePlugin<undefined>
