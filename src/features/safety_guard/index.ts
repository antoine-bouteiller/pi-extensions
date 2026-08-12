import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'
import { dual } from 'effect/Function'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { piContext } from '@/shared/effect/pi_services.js'
import { makeEventHandler } from '@/shared/effect/runtime.js'

import { announceGuardStatus, handleToolCall } from './guard.js'

export const register: {
  (runtime: AppRuntime): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime): void
} = dual(2, (pi: ExtensionAPI, runtime: AppRuntime): void => {
  const providedPi = piContext(pi)

  pi.on(
    'tool_call',
    makeEventHandler(runtime)((event, ctx) => handleToolCall(event, ctx).pipe(Effect.provide(providedPi)))
  )

  pi.on(
    'session_start',
    makeEventHandler(runtime)(() => announceGuardStatus)
  )
})
