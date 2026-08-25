import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { piContext } from '#shared/effect/pi_services'
import { makeEventHandler } from '#shared/effect/runtime'

import { announceGuardStatus, handleToolCall } from './guard.js'
import { makeRmRouter, makeSafeRmRunner, SafeRmParams } from './remove.js'

export const register = (pi: ExtensionAPI, runtime: AppRuntime): void => {
  const run = makeSafeRmRunner(runtime)
  const router = makeRmRouter({ pi, runRm: run })
  const providedPi = piContext(pi)

  pi.registerTool({
    description:
      'Safely remove literal paths without shell rm. Every target is validated before deletion: targets must be below the working directory or /tmp, parent symlinks cannot escape those roots, credentials are protected even inside recursive targets, and directories require recursive=true.',
    // oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-3] §8.8; remove when migrated
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => runtime.runPromise(run(params, signal ?? undefined, ctx)),
    label: 'Safe Remove',
    name: 'safe_rm',
    parameters: SafeRmParams,
    promptGuidelines: [
      'Use safe_rm for file and directory deletion. The shell guard routes simple literal rm commands through the same validation, pre-validates literal rm inside compound commands, and blocks non-literal rm, rmdir, unlink, find deletion, and xargs rm commands.',
      'Set recursive=true only when intentionally removing directories. safe_rm validates all paths before deleting any of them.',
    ],
    promptSnippet: 'Remove files or directories through validated literal paths',
  })

  pi.on('tool_call', router.route)
  pi.on('tool_result', makeEventHandler(runtime)(router.complete))
  pi.on('tool_execution_end', router.forget)
  pi.on(
    'tool_call',
    makeEventHandler(runtime)((event, ctx) => handleToolCall(event, ctx).pipe(Effect.provide(providedPi)))
  )

  // oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-2a] §8.8; remove when lifecycle ownership migrates to src/config/feature_coordinator.ts
  pi.on(
    'session_start',
    makeEventHandler(runtime)(() => announceGuardStatus)
  )
}
