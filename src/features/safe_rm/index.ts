import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { makeEventHandler } from '@/shared/effect/runtime.js'

import { makeRmRouter, makeSafeRmRunner, SafeRmParams } from './remove.js'

export const register = (pi: ExtensionAPI, runtime: AppRuntime): void => {
  const run = makeSafeRmRunner(runtime)
  const router = makeRmRouter({ pi, runRm: run })

  pi.registerTool({
    description:
      'Safely remove literal paths without shell rm. Every target is validated before deletion: targets must be below the working directory or /tmp, parent symlinks cannot escape those roots, credentials are protected even inside recursive targets, and directories require recursive=true.',
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
}
