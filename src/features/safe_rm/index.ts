import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'

import { makeRmRouter, makeSafeRmRunner, SafeRmParams } from './remove.js'

export const register: {
  (runtime: AppRuntime): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime): void
} = Function.dual(
  (args) => typeof args[0].on === 'function',
  (pi: ExtensionAPI, runtime: AppRuntime): void => {
    const run = makeSafeRmRunner(runtime)
    const router = makeRmRouter({ pi, runRm: async (params, signal, ctx) => runtime.runPromise(run(params, signal, ctx)) })

    pi.registerTool({
      description:
        'Safely remove literal paths without shell rm. Every target is validated before deletion: targets must be below the working directory or /tmp, parent symlinks cannot escape those roots, credentials and Git repositories are protected even inside recursive targets, and directories require recursive=true.',
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => runtime.runPromise(run(params, signal ?? undefined, ctx)),
      label: 'Safe Remove',
      name: 'safe_rm',
      parameters: SafeRmParams,
      promptGuidelines: [
        'Use safe_rm for file and directory deletion. The shell guard routes simple literal rm commands through the same validation and blocks complex rm, rmdir, unlink, find deletion, and xargs rm commands.',
        'Set recursive=true only when intentionally removing directories. safe_rm validates all paths before deleting any of them.',
      ],
      promptSnippet: 'Remove files or directories through validated literal paths',
    })

    pi.on('tool_call', router.route)
    pi.on('tool_result', router.complete)
    pi.on('tool_execution_end', router.forget)
  }
)
