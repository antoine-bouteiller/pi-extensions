import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeaturePlugin } from '#shared/effect/feature'
import { makeEventHandler } from '#shared/effect/runtime'

import { defaultEnvironment, makeDiscoveryHandlers, type ClaudeCodeEnvironment } from './discovery.js'

type EagerFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'eager' }>

export const makeFeature = (environment: ClaudeCodeEnvironment = defaultEnvironment()) => {
  const handlers = makeDiscoveryHandlers(environment)
  return {
    bootstrap: 'eager',
    id: 'claude-code',
    implementation: {
      deactivate: (ctx, reason) => (reason === 'shutdown' ? handlers.shutdown({ reason: 'quit', type: 'session_shutdown' }, ctx) : Effect.void),
      register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
        pi.on('resources_discover', makeEventHandler(runtime)(handlers.discover))
      },
    },
    status: { icon: '🤖', name: 'claude-code' },
  } satisfies EagerFeaturePlugin
}

export const feature = makeFeature()
