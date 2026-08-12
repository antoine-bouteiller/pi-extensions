import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { makeEventHandler } from '@/shared/effect/runtime.js'

import { applySessionAffinity, scrubbedSystemPrompt } from './affinity.js'

export const register: {
  (runtime: AppRuntime): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime): void
} = Function.dual(
  (args) => typeof args[0].on === 'function',
  (pi: ExtensionAPI, runtime: AppRuntime): void => {
    pi.on('before_agent_start', (event, ctx) => scrubbedSystemPrompt({ ctx, event }))
    pi.on('before_provider_headers', makeEventHandler(runtime)(applySessionAffinity))
  }
)
