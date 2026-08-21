import { type EntryRenderer, type ExtensionAPI, type ExtensionContext, type MessageEndEvent } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Effect, Exit, Option, Ref, Scope } from 'effect'

import { type PlainEnglishConfig, proseLength } from '#features/plain_english/config'
import { rewriteMessage } from '#features/plain_english/rewrite'
import { StatusBar } from '#shared/effect/app_services'
import { type PiCtx, Ui } from '#shared/effect/pi_services'
import { publishStatus, type StatusItem } from '#shared/state/status_bar'

const STATUS_KEY = 'plain-english'

const statusItem = (config: PlainEnglishConfig, enabled: boolean): StatusItem =>
  Option.isNone(config.model)
    ? { icon: '💬', priority: 20, text: 'PI_PLAIN_ENGLISH_MODEL unset', tone: 'error' }
    : {
        icon: '💬',
        priority: 20,
        text: `${config.model.value.provider}/${config.model.value.modelId}${enabled ? '' : ' (off)'}`,
        tone: enabled ? 'success' : 'muted',
      }

interface Toggle {
  readonly get: () => boolean
  readonly set: (next: boolean) => void
}

interface DisplayOptions {
  readonly pi: ExtensionAPI
  readonly config: PlainEnglishConfig
  readonly toggle: Toggle
}

const isEligible = (
  event: MessageEndEvent,
  config: PlainEnglishConfig,
  toggle: Toggle
): { model: { provider: string; modelId: string }; text: string } | undefined => {
  if (!toggle.get() || Option.isNone(config.model) || event.message.role !== 'assistant') {
    return undefined
  }

  const toolCalls = event.message.content.filter((part) => part.type === 'toolCall')
  if (toolCalls.length > 1 || (toolCalls.length === 1 && toolCalls[0]?.name !== 'ask_user')) {
    return undefined
  }

  const text = event.message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
  return proseLength(text) >= config.minChars ? { model: config.model.value, text } : undefined
}

const collapsedRewrite = (text: string): string => {
  const firstLine = text.split('\n', 1)[0] ?? ''
  return firstLine.length === text.length ? firstLine : `${firstLine}…`
}

const renderRewriteEntry: EntryRenderer<{ text: string }> = (entry, options, theme) => {
  const rewrite = entry.data?.text ?? ''
  const displayed = options.expanded ? rewrite : collapsedRewrite(rewrite)
  return new Text(`💬 In plain English:\n${theme.fg('dim', displayed)}`, 0, 0)
}

export const makeDisplay = ({ pi, config, toggle }: DisplayOptions) => {
  const state = Effect.runSync(
    Effect.gen(function* () {
      return {
        alreadyNotified: yield* Ref.make(false),
        sessionScope: yield* Ref.make<Option.Option<Scope.Closeable>>(Option.none()),
      }
    })
  )

  /*
   * Published straight to the store at construction: a reload re-registers the extension without
   * replaying `session_start`, so waiting for that event leaves the status bar empty.
   */
  publishStatus(STATUS_KEY, statusItem(config, toggle.get()))

  const announceStatus: Effect.Effect<void, never, StatusBar | Ui> = Effect.gen(function* () {
    const bar = yield* StatusBar
    yield* bar.channel(STATUS_KEY).set(statusItem(config, toggle.get()))
  })

  const onSessionStart = Effect.gen(function* () {
    yield* announceStatus
    const next = yield* Scope.make()
    yield* Ref.set(state.alreadyNotified, false)
    const previous = yield* Ref.getAndSet(state.sessionScope, Option.some(next))
    if (Option.isSome(previous)) {
      yield* Scope.close(previous.value, Exit.void)
    }
  })

  const onSessionShutdown = Effect.gen(function* () {
    const bar = yield* StatusBar
    yield* bar.channel(STATUS_KEY).clear
    const current = yield* Ref.getAndSet(state.sessionScope, Option.none())
    if (Option.isSome(current)) {
      yield* Scope.close(current.value, Exit.void)
    }
  })

  const notifyOnce = (message: string) =>
    Ref.modify(state.alreadyNotified, (notified) => [!notified, true] as const).pipe(
      Effect.flatMap((shouldNotify) =>
        shouldNotify
          ? Effect.gen(function* () {
              const ui = yield* Ui
              yield* ui.notify(message, 'warning')
            })
          : Effect.void
      )
    )

  const handleMessageEnd = (event: MessageEndEvent, _ctx: ExtensionContext): Effect.Effect<undefined, never, PiCtx | Ui> =>
    Effect.suspend(() => {
      const eligible = isEligible(event, config, toggle)
      if (eligible === undefined) {
        return Effect.void
      }

      return Effect.gen(function* () {
        const scope = yield* Ref.get(state.sessionScope)
        if (Option.isNone(scope)) {
          return undefined
        }
        const messageId = 'responseId' in event.message && typeof event.message.responseId === 'string' ? event.message.responseId : undefined
        const rewrite = rewriteMessage({ model: eligible.model, text: eligible.text, timeoutMs: config.timeoutMs }).pipe(
          Effect.tap((rewritten) =>
            Effect.sync(() => pi.appendEntry('plain-english', messageId === undefined ? { text: rewritten } : { messageId, text: rewritten }))
          ),
          Effect.catchTag('RewriteError', (error) => notifyOnce(error.message))
        )
        yield* Effect.forkIn(rewrite, scope.value)
        return undefined
      })
    }).pipe(Effect.as(undefined))

  return { announceStatus, handleMessageEnd, onSessionShutdown, onSessionStart, renderRewriteEntry }
}
