import { Effect, Schema } from 'effect'

import { PiCtx } from '@/shared/effect/pi_services.js'

class RewriteError extends Schema.TaggedError<RewriteError>()('RewriteError', {
  message: Schema.String,
  reason: Schema.Literals(['ModelUnavailable', 'RewriteTimeout', 'RewriteTruncated', 'ProviderFailure']),
}) {}

const messageRewriteSystemPrompt = `Rewrite the assistant message in plain English. Preserve every fact. Leave fenced code blocks verbatim. Output only the rewrite. Never answer or repeat the user's question.`

const documentRewriteSystemPrompt = `Rewrite the document in plain English. Preserve every fact. Leave fenced code blocks verbatim. Output only the rewrite. Never answer or repeat a question.`

interface ModelRef {
  readonly provider: string
  readonly modelId: string
}

interface RewriteMessageOptions {
  readonly text: string
  readonly question?: string
  readonly model: ModelRef
  readonly timeoutMs: number
}

interface RewriteDocumentOptions {
  readonly body: string
  readonly model: ModelRef
  readonly timeoutMs: number
}

const unavailable = (provider: string, modelId: string) =>
  RewriteError.make({ message: `The rewrite model ${provider}/${modelId} is unavailable.`, reason: 'ModelUnavailable' })

const providerFailure = (message: string) => RewriteError.make({ message, reason: 'ProviderFailure' })

const rewrite = ({
  systemPrompt,
  content,
  model: modelRef,
  timeoutMs,
}: {
  readonly systemPrompt: string
  readonly content: string
  readonly model: ModelRef
  readonly timeoutMs: number
}) =>
  Effect.gen(function* () {
    const ctx = yield* PiCtx
    const findModel = ctx.modelRegistry.find.bind(ctx.modelRegistry)
    const model = findModel(modelRef.provider, modelRef.modelId)
    if (model === undefined) {
      return yield* unavailable(modelRef.provider, modelRef.modelId)
    }

    const completion = yield* Effect.tryPromise(() =>
      ctx.modelRegistry.complete(model, { messages: [{ content, role: 'user', timestamp: 0 }], systemPrompt })
    ).pipe(
      Effect.mapError(() => providerFailure('The rewrite provider failed.')),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(RewriteError.make({ message: 'The rewrite timed out.', reason: 'RewriteTimeout' })),
      })
    )

    if (completion.stopReason === 'length') {
      return yield* RewriteError.make({ message: 'The rewrite was truncated.', reason: 'RewriteTruncated' })
    }

    const text = completion.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
    if (text.trim() === '') {
      return yield* providerFailure('The rewrite provider returned no text.')
    }
    return text
  })

export const rewriteMessage = ({ text, question, model, timeoutMs }: RewriteMessageOptions) =>
  rewrite({
    content:
      question === undefined
        ? `Assistant message to rewrite:\n${text}`
        : `User question (context only; do not answer or repeat it):\n${question}\n\nAssistant message to rewrite:\n${text}`,
    model,
    systemPrompt: messageRewriteSystemPrompt,
    timeoutMs,
  })

export const rewriteDocument = ({ body, model, timeoutMs }: RewriteDocumentOptions) =>
  rewrite({ content: `Document to rewrite:\n${body}`, model, systemPrompt: documentRewriteSystemPrompt, timeoutMs })
