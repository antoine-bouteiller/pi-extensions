import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeaturePlugin } from '#shared/effect/feature'
import { makeEventHandler } from '#shared/effect/runtime'

import { defaultRulesEnvironment, makeRulesHandlers, type RulesEnvironment } from './rules.js'

type EagerFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'eager' }>

export const makeFeature = (environment: RulesEnvironment = defaultRulesEnvironment()) => {
  const handlers = makeRulesHandlers(environment)
  return {
    bootstrap: 'eager',
    id: 'rules',
    implementation: {
      activate: (event, ctx) =>
        handlers.clearInjections(event, ctx).pipe(Effect.mapError((cause) => ({ _tag: 'RulesActivationError', reason: cause.message }))),
      register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
        const onEvent = makeEventHandler(runtime)
        pi.on('session_compact', onEvent(handlers.clearInjections))
        pi.on('session_tree', onEvent(handlers.clearInjections))
        pi.on('before_agent_start', onEvent(handlers.beforeAgentStart))
        pi.on('tool_result', onEvent(handlers.toolResult))
      },
    },
    status: { icon: '📜', name: 'rules' },
  } satisfies EagerFeaturePlugin
}

export const feature = makeFeature()
