import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'

import { BackgroundPollParams, makePollHandlers } from './poll.js'

const registerImpl = (pi: ExtensionAPI, runtime: AppRuntime): void => {
  const handlers = makePollHandlers(pi)

  pi.registerTool({
    description:
      'Register a shell command that is polled in the background until it exits successfully. The current agent run can end completely; completion, timeout, or failure automatically wakes the agent with the final output. Output is truncated to 50KB or 2000 lines.',
    execute: async (toolCallId, params, signal, _onUpdate, ctx) =>
      runtime.runPromise(handlers.registerTask(toolCallId, params, signal ?? undefined, ctx)),
    label: 'Background Poll',
    name: 'background_poll',
    parameters: BackgroundPollParams,
    promptGuidelines: [
      'Use background_poll for long-running external work that can be checked with a repeatable shell command. Make the command exit 0 only when the awaited result is ready, then end the response; background_poll wakes the agent automatically.',
      'Do not manually poll after registering background_poll. Call background_poll in a tool-only turn after finishing all other immediate work so the agent can stop until the result arrives.',
    ],
    promptSnippet: 'Wait for an asynchronous condition without repeatedly polling or keeping the agent running',
  })

  pi.on('session_start', () => runtime.runPromise(handlers.startSession))
  pi.on('session_shutdown', (_event, ctx) => runtime.runPromise(handlers.stopSession(ctx)))
}

export const register: {
  (runtime: AppRuntime): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime): void
} = Function.dual((args) => typeof args[0].on === 'function', registerImpl)
