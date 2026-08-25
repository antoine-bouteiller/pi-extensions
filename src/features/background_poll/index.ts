import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeaturePlugin } from '#shared/effect/feature'

import { BackgroundPollParams, makePollHandlers, type PollExec } from './poll.js'

type EagerFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'eager' }>

export const makeFeature = (exec?: PollExec) => {
  let handlers: ReturnType<typeof makePollHandlers> | undefined
  return {
    bootstrap: 'eager',
    id: 'background-poll',
    implementation: {
      activate: (_event, _ctx) => (handlers === undefined ? Effect.die('background-poll is not registered') : handlers.startSession),
      deactivate: (ctx, _reason) => (handlers === undefined ? Effect.die('background-poll is not registered') : handlers.stopSession(ctx)),
      register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
        const pollHandlers = makePollHandlers(pi, exec)
        handlers = pollHandlers
        pi.registerTool({
          description:
            'Register a shell command that is polled in the background until it exits successfully. The current agent run can end completely; completion, timeout, or failure automatically wakes the agent with the final output. Output is truncated to 50KB or 2000 lines.',
          execute: async (toolCallId, params, signal, _onUpdate, ctx) =>
            // oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-3] §8.8; remove when migrated
            runtime.runPromise(pollHandlers.registerTask(toolCallId, params, signal ?? undefined, ctx)),
          label: 'Background Poll',
          name: 'background_poll',
          parameters: BackgroundPollParams,
          promptGuidelines: [
            'Use background_poll for long-running external work that can be checked with a repeatable shell command. Make the command exit 0 only when the awaited result is ready, then end the response; background_poll wakes the agent automatically.',
            'Do not manually poll after registering background_poll. Call background_poll in a tool-only turn after finishing all other immediate work so the agent can stop until the result arrives.',
          ],
          promptSnippet: 'Wait for an asynchronous condition without repeatedly polling or keeping the agent running',
        })
      },
    },
    status: { icon: '⏳', name: 'background-poll' },
  } satisfies EagerFeaturePlugin
}
export const feature = makeFeature()
