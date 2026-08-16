import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { piContext } from '#shared/effect/pi_services'
import { makeEventHandler } from '#shared/effect/runtime'

import { announceGuardStatus, handleToolCall } from './guard'

export const register = (pi: ExtensionAPI, runtime: AppRuntime): void => {
  const providedPi = piContext(pi)

  pi.on(
    'tool_call',
    makeEventHandler(runtime)((event, ctx) => handleToolCall(event, ctx).pipe(Effect.provide(providedPi)))
  )

  pi.on(
    'session_start',
    makeEventHandler(runtime)(() => announceGuardStatus)
  )
}
