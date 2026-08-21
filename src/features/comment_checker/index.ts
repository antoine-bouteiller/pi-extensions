import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { type AppRuntime } from '#shared/effect/app_services'
import { makeEventHandler } from '#shared/effect/runtime'

import { makeCheckerHandler, type CheckerRunner } from './checker.js'

export const register = (pi: ExtensionAPI, runtime: AppRuntime, runner?: CheckerRunner): void => {
  pi.on('tool_result', makeEventHandler(runtime)(makeCheckerHandler(runner)))
}
