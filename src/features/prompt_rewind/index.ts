/** Prompt_rewind restores the raw text of a just-cancelled text-only prompt. */
import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeaturePlugin } from '#shared/effect/feature'

import { makeRewindController, REWIND_COMMAND } from './rewind.js'

type EagerFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'eager' }>

export const feature = (() => {
  const controller = makeRewindController()
  return {
    bootstrap: 'eager',
    id: 'prompt-rewind',
    implementation: {
      activate: (event, ctx) => Effect.sync(() => controller.start(event, ctx)),
      deactivate: (_ctx, _reason) => Effect.sync(controller.shutdown),
      register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
        pi.on('input', controller.captureInput)
        pi.on('before_agent_start', controller.capturePrompt)
        pi.on('agent_start', controller.arm)
        pi.on('message_update', controller.disarm)
        pi.on('tool_execution_start', controller.disarm)
        pi.on('agent_end', controller.disarm)
        pi.registerCommand(REWIND_COMMAND, {
          description: 'Internal: rewinds the just-cancelled prompt from the active branch and restores its raw text to the editor.',
          // oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-5] §8.8; remove when migrated
          handler: (_args, ctx) => runtime.runPromise(controller.rewindCancelledPrompt(ctx)),
        })
      },
    },
    status: { icon: '↩️', name: 'prompt-rewind' },
  } satisfies EagerFeaturePlugin
})()
