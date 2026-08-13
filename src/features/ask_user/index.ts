/**
 * Ask_user - Lets the model ask a single multiple-choice question.
 *
 * - 2 to 5 model-provided options, plus an always-present "Write my own answer" option
 * - Popup UI: arrow keys or number keys to pick, Enter to confirm
 * - "Write my own answer" opens an inline editor (Esc returns to the options)
 * - Esc on the options dismisses the question (the model is told you declined)
 */

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { type Component, Text } from '@earendil-works/pi-tui'
import { Effect } from 'effect'
import { Check } from 'typebox/schema'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { perInvocation } from '@/shared/effect/runtime.js'

import { ASK_USER_PROMPT_GUIDELINES, ASK_USER_PROMPT_SNIPPET, ASK_USER_TOOL_DESCRIPTION } from './prompt.js'
import { AskUserDetailsSchema, askUserEffect, AskUserParams, type DisplayOption } from './tool.js'

export const register = (pi: ExtensionAPI, runtime: AppRuntime): void => {
  pi.registerTool({
    description: ASK_USER_TOOL_DESCRIPTION,
    /*
     * `signal` is threaded into the Effect body instead of being handed to `runPromise`. The
     * component already resolves `done(undefined)` cooperatively on abort so it can report
     * "Cancelled" as a normal result; letting `runPromise` interrupt the fiber on the same signal
     * would instead reject the tool call, which is exactly what "neither path may fail" rules out.
     */
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) =>
      runtime.runPromise(askUserEffect(params, signal ?? undefined).pipe(Effect.provide(perInvocation(ctx)))),
    label: 'Ask User',
    name: 'ask_user',
    parameters: AskUserParams,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    renderCall: (args, theme) => {
      let text = theme.fg('toolTitle', theme.bold('ask_user '))
      text += theme.fg('muted', typeof args.question === 'string' ? args.question : '')
      const opts: DisplayOption[] = Array.isArray(args.options) ? args.options : []
      if (opts.length > 0) {
        const numbered = opts.map((option, index) => `${index + 1}. ${option.label}`)
        text += `\n${theme.fg('dim', `  ${numbered.join('  ')}`)}`
      }
      return new Text(text, 0, 0)
    },
    renderResult: (result, _options, theme): Component => {
      const details = Check(AskUserDetailsSchema, result.details) ? result.details : undefined
      if (details === undefined) {
        const [first] = result.content
        return new Text(first?.type === 'text' ? first.text : '', 0, 0)
      }

      if (details.cancelled || details.answer === undefined) {
        return new Text(theme.fg('warning', '✗ dismissed'), 0, 0)
      }

      if (details.wasCustom) {
        return new Text(theme.fg('success', '✓ ') + theme.fg('muted', '(wrote) ') + theme.fg('accent', details.answer), 0, 0)
      }

      const idx = details.options.indexOf(details.answer) + 1
      const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer
      return new Text(theme.fg('success', '✓ ') + theme.fg('accent', display), 0, 0)
    },
  })
}
