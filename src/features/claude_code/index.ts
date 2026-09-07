import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeatureOptions, type FeaturePlugin } from '#shared/effect/feature'
import { makeEventHandler } from '#shared/effect/runtime'

import { defaultEnvironment, makeDiscoveryHandlers, type ClaudeCodeEnvironment } from './discovery.js'

export const feature = ((options: FeatureOptions<ClaudeCodeEnvironment> = {}) => {
  const environment = options.dependencies ?? defaultEnvironment()
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
    suppressInChild: true,
  }
}) satisfies FeaturePlugin<ClaudeCodeEnvironment>
