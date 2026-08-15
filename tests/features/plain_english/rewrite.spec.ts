import { type Api, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asNarrowed } from '@tests/utils/casts.js'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { rewriteDocument, rewriteMessage } from '@/features/plain_english/rewrite.js'
import { PiCtx } from '@/shared/effect/pi_services.js'

type TestModel = Model<Api>

const model = asNarrowed<TestModel, object>({ id: 'rewriter' })
const modelRef = { modelId: 'rewriter', provider: 'test' }

const completion = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage =>
  asNarrowed<AssistantMessage, object>({ content, stopReason })

const contextWith = (complete: () => Promise<AssistantMessage>, found: TestModel | undefined) =>
  asExtensionContext({
    modelRegistry: {
      complete: (_model: TestModel, _context: Context) => complete(),
      find: (provider: string, modelId: string) => (provider === modelRef.provider && modelId === modelRef.modelId ? found : undefined),
    },
  })

const provideCtx = <Success, Failure>(effect: Effect.Effect<Success, Failure, PiCtx>, ctx: ReturnType<typeof contextWith>) =>
  effect.pipe(Effect.provideService(PiCtx, ctx))

describe('plain_english rewriter', () => {
  it.effect('returns joined text content from a successful message rewrite', () => {
    let received: Context | undefined
    const ctx = asExtensionContext({
      modelRegistry: {
        complete: (_model: TestModel, context: Context) => {
          received = context
          return Promise.resolve(
            completion([
              { text: 'Plain ', type: 'text' },
              { text: 'words', type: 'text' },
            ])
          )
        },
        find: () => model,
      },
    })

    return Effect.gen(function* () {
      const result = yield* rewriteMessage({ model: modelRef, text: 'Dense answer', timeoutMs: 1000 }).pipe(Effect.provideService(PiCtx, ctx))
      expect(result).toBe('Plain words')
      expect(received).toMatchObject({ messages: [{ content: expect.stringContaining('Dense answer'), role: 'user' }] })
      expect(received?.tools).toBeUndefined()
    })
  })

  it.effect('fails with ModelUnavailable when the configured model cannot be found', () =>
    provideCtx(
      rewriteDocument({ body: 'Document', model: modelRef, timeoutMs: 1000 }).pipe(Effect.flip),
      contextWith(() => Promise.resolve(completion([])), undefined)
    ).pipe(Effect.tap((error) => Effect.sync(() => expect(error.reason).toBe('ModelUnavailable'))))
  )

  it.effect('maps a rejected provider completion to ProviderFailure', () =>
    provideCtx(
      rewriteDocument({ body: 'Document', model: modelRef, timeoutMs: 1000 }).pipe(Effect.flip),
      contextWith(() => Promise.reject(new Error('offline')), model)
    ).pipe(Effect.tap((error) => Effect.sync(() => expect(error.reason).toBe('ProviderFailure'))))
  )

  it.effect('rejects completions stopped by the output length cap', () =>
    provideCtx(
      rewriteDocument({ body: 'Document', model: modelRef, timeoutMs: 1000 }).pipe(Effect.flip),
      contextWith(() => Promise.resolve(completion([{ text: 'partial', type: 'text' }], 'length')), model)
    ).pipe(Effect.tap((error) => Effect.sync(() => expect(error.reason).toBe('RewriteTruncated'))))
  )

  it.effect('rejects resolved error completions even when they contain text', () =>
    provideCtx(
      rewriteDocument({ body: 'Document', model: modelRef, timeoutMs: 1000 }).pipe(Effect.flip),
      contextWith(() => Promise.resolve(completion([{ text: 'must not be used', type: 'text' }], 'error')), model)
    ).pipe(Effect.tap((error) => Effect.sync(() => expect(error.reason).toBe('ProviderFailure'))))
  )

  it.effect('rejects resolved aborted completions even when they contain text', () =>
    provideCtx(
      rewriteDocument({ body: 'Document', model: modelRef, timeoutMs: 1000 }).pipe(Effect.flip),
      contextWith(() => Promise.resolve(completion([{ text: 'must not be used', type: 'text' }], 'aborted')), model)
    ).pipe(Effect.tap((error) => Effect.sync(() => expect(error.reason).toBe('ProviderFailure'))))
  )

  it.effect('rejects empty completion content', () =>
    provideCtx(
      rewriteDocument({ body: 'Document', model: modelRef, timeoutMs: 1000 }).pipe(Effect.flip),
      contextWith(() => Promise.resolve(completion([{ text: '  ', type: 'text' }])), model)
    ).pipe(Effect.tap((error) => Effect.sync(() => expect(error.reason).toBe('ProviderFailure'))))
  )

  it.effect('fails with RewriteTimeout when completion exceeds the supplied deadline', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        provideCtx(
          rewriteDocument({ body: 'Document', model: modelRef, timeoutMs: 1000 }).pipe(Effect.flip),
          contextWith(() => Promise.race([]), model)
        )
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust('1 second')
      const error = yield* Fiber.join(fiber)
      expect(error.reason).toBe('RewriteTimeout')
    })
  )
})
