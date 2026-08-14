import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { makeEventHandler } from '@/shared/effect/runtime.js'

import { defaultEnvironment, makeDiscoveryHandlers, type ClaudeCodeEnvironment } from './discovery.js'

export const register = (pi: ExtensionAPI, runtime: AppRuntime, environment: ClaudeCodeEnvironment = defaultEnvironment()): void => {
  const handlers = makeDiscoveryHandlers(environment)

  pi.on('resources_discover', makeEventHandler(runtime)(handlers.discover))
  pi.on('session_shutdown', makeEventHandler(runtime)(handlers.shutdown))
}
