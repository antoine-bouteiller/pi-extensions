import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { makeEventHandler } from '@/shared/effect/runtime.js'

import { defaultEnvironment, makeDiscoveryHandlers, type ClaudeCodeEnvironment } from './discovery.js'

const registerImpl = (pi: ExtensionAPI, runtime: AppRuntime, environment: ClaudeCodeEnvironment = defaultEnvironment()): void => {
  const handlers = makeDiscoveryHandlers(environment)

  pi.on('resources_discover', makeEventHandler(runtime)(handlers.discover))
  pi.on('session_shutdown', makeEventHandler(runtime)(handlers.shutdown))
}

export const register: {
  (runtime: AppRuntime, environment?: ClaudeCodeEnvironment): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime, environment?: ClaudeCodeEnvironment): void
} = Function.dual((args) => typeof args[0].on === 'function', registerImpl)
