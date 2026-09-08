import { type ExtensionAPI, keyHint } from '@earendil-works/pi-coding-agent'
import { Text, truncateToWidth } from '@earendil-works/pi-tui'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeatureOptions, type FeaturePlugin } from '#shared/effect/feature'
import { makeToolExecutor } from '#shared/effect/runtime'

import { BackgroundPollParams, makePollHandlers, type PollExec, type PollRegistration } from './poll.js'

export const feature = ((options: FeatureOptions<PollExec> = {}) => {
  const exec = options.dependencies ?? undefined
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
        pi.registerTool<typeof BackgroundPollParams, PollRegistration['details']>({
          description:
            'Register a shell command that is polled in the background until it exits successfully. The current agent run can end completely; completion, timeout, or failure automatically wakes the agent with the final output. Output is truncated to 50KB or 2000 lines.',
          execute: makeToolExecutor(runtime)(({ ctx, params, signal, toolCallId }) => pollHandlers.registerTask(toolCallId, params, signal, ctx), {
            interruptOnAbort: false,
          }),
          label: 'Background Poll',
          name: 'background_poll',
          parameters: BackgroundPollParams,
          promptGuidelines: [
            'Use background_poll for long-running external work that can be checked with a repeatable shell command. Make the command exit 0 only when the awaited result is ready, then end the response; background_poll wakes the agent automatically.',
            'Do not manually poll after registering background_poll. Call background_poll in a tool-only turn after finishing all other immediate work so the agent can stop until the result arrives.',
          ],
          promptSnippet: 'Wait for an asynchronous condition without repeatedly polling or keeping the agent running',
          renderCall: (args, theme, context) => {
            const description = args.label?.trim() || args.command || '?'
            const summary = context.expanded ? description : truncateToWidth(description.replaceAll(/\s+/g, ' '), 120)
            const command =
              context.expanded && (args.label?.trim() || '') !== '' && args.command !== undefined ? `\n${theme.fg('dim', args.command)}` : ''
            return new Text(theme.fg('toolTitle', theme.bold('background_poll ')) + theme.fg('text', summary) + command, 0, 0)
          },
          renderResult: (result, { expanded, isPartial }, theme, context) => {
            const output = result.content
              .filter((content) => content.type === 'text')
              .map((content) => content.text)
              .join('\n')
            if (context.isError) {
              return new Text(theme.fg('error', `✗ ${output || 'Poll registration failed'}`), 0, 0)
            }
            if (isPartial) {
              return new Text(theme.fg('muted', 'Registering background poll…'), 0, 0)
            }
            const { details } = result
            if (details === undefined) {
              return new Text(theme.fg('muted', output || 'No poll registration details'), 0, 0)
            }
            let text =
              theme.fg('success', '✓ Registered') + theme.fg('muted', ` · every ${details.intervalSeconds}s · timeout ${details.timeoutSeconds}s`)
            text += expanded
              ? `\n${theme.fg('dim', `Task: ${details.taskId}`)}\n${theme.fg('text', output)}`
              : `\n${theme.fg('dim', keyHint('app.tools.expand', 'to expand'))}`
            return new Text(text, 0, 0)
          },
        })
      },
    },
    status: { icon: '⏳', name: 'background-poll' },
    suppressInChild: true,
  }
}) satisfies FeaturePlugin<PollExec>
