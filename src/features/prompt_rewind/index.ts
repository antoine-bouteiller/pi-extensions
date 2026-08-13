/**
 * Prompt_rewind - Escape between submitting a text-only prompt and the first assistant
 * output rewinds the just-submitted message and restores its raw, pre-expansion text
 * to the editor instead of leaving an orphaned user turn on the active branch.
 *
 * Image prompts are left to Pi's built-in Escape handling: there is no public API to
 * restore attachments into the editor, so rewinding them would silently drop images.
 */

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { type AppRuntime } from '@/shared/effect/app_services.js'

import { makeRewindController, REWIND_COMMAND } from './rewind.js'

export const register = (pi: ExtensionAPI, _runtime: AppRuntime): void => {
  const controller = makeRewindController()

  pi.on('input', controller.captureInput)
  pi.on('before_agent_start', controller.capturePrompt)
  pi.on('agent_start', controller.arm)
  pi.on('message_update', controller.disarm)
  pi.on('tool_execution_start', controller.disarm)
  pi.on('agent_end', controller.disarm)
  pi.on('session_start', controller.start)
  pi.on('session_shutdown', controller.shutdown)

  pi.registerCommand(REWIND_COMMAND, {
    description: 'Internal: rewinds the just-cancelled prompt from the active branch and restores its raw text to the editor.',
    handler: (_args, ctx) => controller.rewindCancelledPrompt(ctx),
  })
}
