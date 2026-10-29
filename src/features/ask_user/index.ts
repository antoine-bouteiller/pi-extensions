/**
 * Ask_user - Lets the model ask a single multiple-choice question.
 *
 * - 2 to 5 model-provided options, plus an always-present "Write my own answer" option
 * - Popup UI: arrow keys or number keys to pick, Enter to confirm
 * - "Write my own answer" opens an inline editor (Esc returns to the options)
 * - Esc on the options dismisses the question (the model is told you declined)
 */

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { type AppRuntime } from '#shared/effect/app_services'
import { processEnvironment } from '#shared/effect/env'
import { type FeatureOptions, type FeaturePlugin } from '#shared/effect/feature'
import { makeToolExecutor } from '#shared/effect/runtime'

import { makeQuestionStatus, type StatusWriter } from './program_status.js'
import { ASK_USER_PROMPT_GUIDELINES, ASK_USER_PROMPT_SNIPPET, ASK_USER_TOOL_DESCRIPTION } from './prompt.js'
import { askUserEffect, AskUserParams, renderAskUserCall, renderAskUserResult } from './tool.js'

const writeStdout: StatusWriter = (sequence) => {
  process.stdout.write(sequence)
}

export const feature = ((options: FeatureOptions<StatusWriter> = {}) => ({
  id: 'ask-user',
  implementation: {
    register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
      const status = makeQuestionStatus(options.environment ?? processEnvironment, options.dependencies ?? writeStdout)
      pi.registerTool({
        description: ASK_USER_TOOL_DESCRIPTION,
        /*
         * `signal` is threaded into the Effect body instead of being handed to `runPromise`. The
         * component already resolves `done(undefined)` cooperatively on abort so it can report
         * "Cancelled" as a normal result; letting `runPromise` interrupt the fiber on the same signal
         * would instead reject the tool call, which is exactly what "neither path may fail" rules out.
         */
        execute: makeToolExecutor(runtime)(({ params, signal }) => askUserEffect(pi.events, status, params, signal), { interruptOnAbort: false }),
        label: 'Ask User',
        name: 'ask_user',
        parameters: AskUserParams,
        promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
        promptSnippet: ASK_USER_PROMPT_SNIPPET,
        renderCall: renderAskUserCall,
        renderResult: renderAskUserResult,
      })
    },
  },
  status: { name: 'ask-user' },
})) satisfies FeaturePlugin<StatusWriter>
