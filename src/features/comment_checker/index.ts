import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { makeEventHandler } from '@/shared/effect/runtime.js'

import { makeCheckerHandler, type CheckerRunner } from './checker.js'

export const register: {
  (runtime: AppRuntime, runner?: CheckerRunner): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime, runner?: CheckerRunner): void
} = Function.dual(
  (args) => typeof args[0].on === 'function',
  (pi: ExtensionAPI, runtime: AppRuntime, runner?: CheckerRunner): void => {
    pi.on('tool_result', makeEventHandler(runtime)(makeCheckerHandler(runner)))
  }
)
