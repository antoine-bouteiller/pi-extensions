import { afterEach } from 'bun:test'

import { type Api, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai'
import { type MessageEndEvent } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, promiseFromEffect } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asNarrowed, asTheme } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { Deferred, Effect, Option } from 'effect'

import { type PlainEnglishConfig, makeToggle } from '@/features/plain_english/config.js'
import { makeDisplay } from '@/features/plain_english/display.js'
import { StatusBarLive } from '@/shared/effect/app_services.js'
import { PiCtx, Ui, type UiApi } from '@/shared/effect/pi_services.js'
import { publishStatus, statusBar } from '@/shared/state/status_bar.js'

type TestModel = Model<Api>

const model = asNarrowed<TestModel, object>({ id: 'rewriter' })
const modelRef = { modelId: 'rewriter', provider: 'test' }
const config: PlainEnglishConfig = { mdTimeoutMs: 1000, minChars: 10, model: Option.some(modelRef), timeoutMs: 1000 }

const assistantEvent = (content: AssistantMessage['content']): MessageEndEvent =>
  asNarrowed<MessageEndEvent, object>({
    message: { api: 'test', content, model: 'test', provider: 'test', role: 'assistant', stopReason: 'stop', timestamp: 0, usage: {} },
    type: 'message_end',
  })

const contextWith = (complete: () => Promise<AssistantMessage>) =>
  asExtensionContext({
    modelRegistry: {
      complete: (_model: TestModel, _context: Context) => complete(),
      find: () => model,
    },
  })

const completion = (text: string): AssistantMessage => asNarrowed<AssistantMessage, object>({ content: [{ text, type: 'text' }], stopReason: 'stop' })

const ui = (notifications: { message: string; level: string }[]): UiApi => ({
  confirm: () => Effect.succeed(false),
  hasUI: Effect.succeed(true),
  notify: (message, level) =>
    Effect.sync(() => {
      notifications.push({ level, message })
    }),
  setStatus: () => Effect.void,
})

const settle = Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow))

const status = () => statusBar.list().find((entry) => entry.key === 'plain-english')

afterEach(() => publishStatus('plain-english', undefined))

describe('plain_english display', () => {
  it.scoped('appends one rewrite for an eligible assistant message without replacing it', () => {
    const { pi, state } = createFakePi()
    const display = makeDisplay({ config, pi, toggle: makeToggle() })
    const ctx = contextWith(() => Promise.resolve(completion('Plain wording')))

    return Effect.gen(function* () {
      yield* display.onSessionStart
      const result = yield* display.handleMessageEnd(assistantEvent([{ text: 'A sufficiently long answer.', type: 'text' }]), ctx)
      yield* settle
      expect(result).toBeUndefined()
      expect(state.entries).toEqual([{ customType: 'plain-english', data: { text: 'Plain wording' } }])
    }).pipe(Effect.provideService(PiCtx, ctx), Effect.provideService(Ui, ui([])), Effect.provide(StatusBarLive))
  })

  it.scoped('skips bash calls, short prose, disabled toggles, and an unset model', () => {
    const { pi, state } = createFakePi()
    const toggle = makeToggle()
    const ctx = contextWith(() => Promise.resolve(completion('Plain wording')))
    const display = makeDisplay({ config, pi, toggle })
    const noModel = makeDisplay({ config: { ...config, model: Option.none() }, pi, toggle })

    return Effect.gen(function* () {
      yield* display.onSessionStart
      yield* display.handleMessageEnd(
        assistantEvent([
          { arguments: {}, id: 'call-1', name: 'bash', type: 'toolCall' },
          { text: 'A sufficiently long answer.', type: 'text' },
        ]),
        ctx
      )
      yield* display.handleMessageEnd(assistantEvent([{ text: 'short', type: 'text' }]), ctx)
      yield* display.handleMessageEnd(assistantEvent([{ text: 'brief\n```ts\nthis code makes the raw text long\n```', type: 'text' }]), ctx)
      toggle.set(false)
      yield* display.handleMessageEnd(assistantEvent([{ text: 'A sufficiently long answer.', type: 'text' }]), ctx)
      toggle.set(true)
      yield* noModel.onSessionStart
      yield* noModel.handleMessageEnd(assistantEvent([{ text: 'A sufficiently long answer.', type: 'text' }]), ctx)
      yield* settle
      expect(state.entries).toEqual([])
    }).pipe(Effect.provideService(PiCtx, ctx), Effect.provideService(Ui, ui([])), Effect.provide(StatusBarLive))
  })

  it.scoped('rewrites an ask_user-only tool call', () => {
    const { pi, state } = createFakePi()
    const display = makeDisplay({ config, pi, toggle: makeToggle() })
    const ctx = contextWith(() => Promise.resolve(completion('Plain wording')))

    return Effect.gen(function* () {
      yield* display.onSessionStart
      yield* display.handleMessageEnd(
        assistantEvent([
          { arguments: {}, id: 'call-1', name: 'ask_user', type: 'toolCall' },
          { text: 'A sufficiently long answer.', type: 'text' },
        ]),
        ctx
      )
      yield* settle
      expect(state.entries).toHaveLength(1)
    }).pipe(Effect.provideService(PiCtx, ctx), Effect.provideService(Ui, ui([])), Effect.provide(StatusBarLive))
  })

  it.scoped('notifies once when consecutive rewrites fail', () => {
    const { pi, state } = createFakePi()
    const display = makeDisplay({ config, pi, toggle: makeToggle() })
    let completionCalls = 0
    const ctx = contextWith(() => {
      completionCalls += 1
      return Promise.reject(new Error('offline'))
    })
    const notifications: { message: string; level: string }[] = []

    return Effect.gen(function* () {
      yield* display.onSessionStart
      yield* display.handleMessageEnd(assistantEvent([{ text: 'A sufficiently long answer.', type: 'text' }]), ctx)
      yield* display.handleMessageEnd(assistantEvent([{ text: 'Another sufficiently long answer.', type: 'text' }]), ctx)
      yield* settle
      expect(state.entries).toEqual([])
      expect(completionCalls).toBe(2)
      expect(notifications).toHaveLength(1)
      expect(notifications[0]?.level).toBe('warning')
    }).pipe(Effect.provideService(PiCtx, ctx), Effect.provideService(Ui, ui(notifications)), Effect.provide(StatusBarLive))
  })

  it.scoped('does not append a rewrite interrupted by session shutdown', () => {
    const { pi, state } = createFakePi()
    const display = makeDisplay({ config, pi, toggle: makeToggle() })
    let completionCalls = 0
    const pending = Deferred.makeUnsafe<AssistantMessage>()
    const ctx = contextWith(() => {
      completionCalls += 1
      return promiseFromEffect(Deferred.await(pending))
    })

    return Effect.gen(function* () {
      yield* display.onSessionStart
      yield* display.handleMessageEnd(assistantEvent([{ text: 'A sufficiently long answer.', type: 'text' }]), ctx)
      yield* settle
      expect(completionCalls).toBe(1)
      yield* display.onSessionShutdown
      yield* Deferred.succeed(pending, completion('Plain wording'))
      yield* settle
      expect(state.entries).toEqual([])
    }).pipe(Effect.provideService(PiCtx, ctx), Effect.provideService(Ui, ui([])), Effect.provide(StatusBarLive))
  })

  it.effect('publishes a status naming the selected model until shutdown', () => {
    const { pi } = createFakePi()
    const toggle = makeToggle()
    const display = makeDisplay({ config, pi, toggle })
    const ctx = contextWith(() => Promise.resolve(completion('Plain wording')))

    return Effect.gen(function* () {
      expect(status()).toMatchObject({ text: 'test/rewriter', tone: 'success' })
      yield* display.onSessionStart
      toggle.set(false)
      yield* display.announceStatus
      expect(status()).toMatchObject({ text: 'test/rewriter (off)', tone: 'muted' })
      yield* display.onSessionShutdown
      expect(status()).toBeUndefined()
      makeDisplay({ config: { ...config, model: Option.none() }, pi, toggle })
      expect(status()).toMatchObject({ text: 'PI_PLAIN_ENGLISH_MODEL unset', tone: 'error' })
    }).pipe(Effect.provideService(PiCtx, ctx), Effect.provideService(Ui, ui([])), Effect.provide(StatusBarLive))
  })

  it('renders an expanded rewrite and collapsed first-line preview', () => {
    const { pi } = createFakePi()
    const display = makeDisplay({ config, pi, toggle: makeToggle() })
    const entry = asNarrowed<Parameters<typeof display.renderRewriteEntry>[0], object>({ data: { text: 'First line\nRemaining explanation' } })
    const theme = asTheme({ fg: (_color: string, text: string) => text })
    const expanded = asNarrowed<{ text: string }, object>(display.renderRewriteEntry(entry, { expanded: true }, theme) ?? {})
    const collapsed = asNarrowed<{ text: string }, object>(display.renderRewriteEntry(entry, { expanded: false }, theme) ?? {})

    expect(expanded.text).toContain('💬 In plain English:')
    expect(expanded.text).toContain('First line\nRemaining explanation')
    expect(collapsed.text).toContain('💬 In plain English:')
    expect(collapsed.text).toContain('First line…')
    expect(collapsed.text).not.toContain('Remaining explanation')
  })
})
