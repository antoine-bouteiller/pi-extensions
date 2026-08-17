import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect, Option } from 'effect'

import { loadConfig, makeToggle } from '@/features/plain_english/config.js'
import { makeDisplay } from '@/features/plain_english/display.js'
import { makeMarkdownCommand } from '@/features/plain_english/markdown.js'
import { type AppRuntime } from '@/shared/effect/app_services.js'
import { Ui } from '@/shared/effect/pi_services.js'
import { makeEventHandler, perInvocation } from '@/shared/effect/runtime.js'

const toggleMessage = (enabled: boolean) => `Plain-English rewrites are ${enabled ? 'on' : 'off'}.`

export const register = (pi: ExtensionAPI, runtime: AppRuntime, environment: Readonly<Record<string, string | undefined>> = process.env): void => {
  const config = loadConfig(environment)
  const toggle = makeToggle()
  const display = makeDisplay({ config, pi, toggle })
  const markdownCommand = makeMarkdownCommand({ config })

  pi.registerEntryRenderer('plain-english', display.renderRewriteEntry)

  if (Option.isSome(config.model)) {
    pi.on(
      'session_start',
      makeEventHandler(runtime)(() => display.onSessionStart)
    )
    pi.on(
      'session_shutdown',
      makeEventHandler(runtime)(() => display.onSessionShutdown)
    )
    pi.on('message_end', makeEventHandler(runtime)(display.handleMessageEnd))
  }

  pi.registerCommand('plain-english', {
    description: 'Turn automatic plain-English message rewrites on or off. Usage: /plain-english [on|off]',
    handler: (args, ctx) => {
      const requested = args.trim().toLowerCase()
      if (requested !== '' && requested !== 'on' && requested !== 'off') {
        return runtime.runPromise(
          Effect.gen(function* () {
            const ui = yield* Ui
            yield* ui.notify('Usage: /plain-english [on|off]', 'warning')
          }).pipe(Effect.provide(perInvocation(ctx)))
        )
      }
      let enabled: boolean
      if (requested === 'on') {
        enabled = true
      } else if (requested === 'off') {
        enabled = false
      } else {
        enabled = !toggle.get()
      }
      toggle.set(enabled)
      return runtime.runPromise(
        Effect.gen(function* () {
          const ui = yield* Ui
          yield* ui.notify(toggleMessage(enabled), 'info')
          yield* display.announceStatus
        }).pipe(Effect.provide(perInvocation(ctx)))
      )
    },
  })

  pi.registerCommand('plain-english-md', {
    description: 'Rewrite a Markdown file in plain English. Usage: /plain-english-md <path> [--overwrite]',
    handler: (args, ctx) => runtime.runPromise(markdownCommand(args, ctx).pipe(Effect.provide(perInvocation(ctx)))),
  })
}
