import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { type AppRuntime } from '#shared/effect/app_services'
import { makeEventHandler } from '#shared/effect/runtime'

import { defaultEnvironment, makeDiscoveryHandlers, type ClaudeCodeEnvironment } from './discovery.js'

export const register = (pi: ExtensionAPI, runtime: AppRuntime, environment: ClaudeCodeEnvironment = defaultEnvironment()): void => {
  const handlers = makeDiscoveryHandlers(environment)

  pi.on('resources_discover', makeEventHandler(runtime)(handlers.discover))
  // oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-2a] §8.8; remove when lifecycle ownership migrates to src/config/feature_coordinator.ts
  pi.on('session_shutdown', makeEventHandler(runtime)(handlers.shutdown))
}
