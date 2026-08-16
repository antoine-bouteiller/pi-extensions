import { StringEnum } from '@earendil-works/pi-ai'
import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  formatSize,
  keyText,
  type Theme,
  type ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent'
import { Text, type Component } from '@earendil-works/pi-tui'
import { Duration, Effect, Schema, Stream } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, type HttpClientResponse } from 'effect/unstable/http'
import TurndownService from 'turndown'
import { Type, type Static } from 'typebox'

import { type AppRuntime } from '#shared/effect/app_services'
import { ToolFailure } from '#shared/effect/errors'
import { isEmptyString, isNotEmptyString, isNullOrUndefined, isTrue } from '#shared/utils/predicates'
import { boundToolTextEffect, writePrivateTempFileEffect } from '#shared/utils/tool_output'

const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 120
export const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024
export const MAX_OUTPUT_BYTES = 50 * 1024
export const MAX_OUTPUT_LINES = 2000
const PREVIEW_LINES = 20

export const WebfetchParams = Type.Object({
  format: Type.Optional(
    StringEnum(['markdown', 'text', 'html'] as const, {
      description: 'Output format for HTML responses. Defaults to markdown.',
    })
  ),
  timeout: Type.Optional(
    Type.Number({
      description: `Timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS} and is capped at ${MAX_TIMEOUT_SECONDS}.`,
    })
  ),
  url: Type.String({ description: 'HTTP or HTTPS URL to fetch.' }),
})

export type WebfetchInput = Static<typeof WebfetchParams>

const WebfetchFormatSchema = Schema.Literals(['markdown', 'text', 'html'] as const)
type WebfetchFormat = typeof WebfetchFormatSchema.Type
const DEFAULT_FORMAT: WebfetchFormat = 'markdown'

const resolveFormat = (value: string | undefined): WebfetchFormat =>
  value === undefined ? DEFAULT_FORMAT : Schema.decodeUnknownSync(WebfetchFormatSchema)(value)

export interface WebfetchDetails {
  url: string
  finalUrl: string
  status: number
  statusText: string
  contentType: string
  downloadedBytes: number
  timeoutSeconds: number
  format: WebfetchFormat
  converted: boolean
  outputTruncated: boolean
  outputBytes: number
  fullOutputPath?: string
}

const normalizeTimeout = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_SECONDS
  }
  return Math.min(Math.ceil(value), MAX_TIMEOUT_SECONDS)
}

const parseUrl = (value: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`webfetch only supports HTTP and HTTPS URLs: ${value}`)
  }
  return url
}

const parseUrlEffect = (value: string): Effect.Effect<URL, ToolFailure> =>
  Effect.try({
    catch: (cause) => ToolFailure.make({ cause, message: cause instanceof Error ? cause.message : String(cause) }),
    try: () => parseUrl(value),
  })

const isHtml = (contentType: string): boolean => {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'text/html' || mediaType === 'application/xhtml+xml'
}

const turndown = (): TurndownService => {
  const service = new TurndownService({
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
  })
  service.remove(['script', 'style', 'noscript', 'template', 'form'])
  return service
}

const articleHtml = (html: string): string => {
  for (const tag of ['article', 'main', 'body'] as const) {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html)
    if (!isNullOrUndefined(match?.[1]) && isNotEmptyString(match[1])) {
      return match[1]
    }
  }
  return html
}

const pageTitle = (html: string): string | undefined => {
  const match = /<title\b[^>]*>(?<title>[\s\S]*?)<\/title>/i.exec(html)
  const captured = match?.groups?.title
  if (isNullOrUndefined(captured) || isEmptyString(captured)) {
    return undefined
  }
  const title = turndown().turndown(captured).replaceAll(/\s+/g, ' ').trim()
  return isEmptyString(title) ? undefined : title
}

const htmlToMarkdown = (html: string): string => {
  const title = pageTitle(html)
  const content = turndown()
    .turndown(articleHtml(html))
    .replaceAll(/[ \t]+$/gm, '')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()

  if (isNullOrUndefined(title) || isEmptyString(title)) {
    return content
  }
  const titleHeading = `# ${title}`
  return content.startsWith(titleHeading) ? content : `${titleHeading}\n\n${content}`.trim()
}

const markdownToText = (markdown: string): string =>
  markdown
    .replaceAll(/```[^\n]*\n(?<code>[\s\S]*?)```/g, '$<code>')
    .replaceAll(/!\[(?<alt>[^\]]*)\]\([^)]*\)/g, '$<alt>')
    .replaceAll(/\[(?<label>[^\]]+)\]\([^)]*\)/g, '$<label>')
    .replaceAll(/^[ \t]{0,3}(?:#{1,6}|>|[-+*])[ \t]+/gm, '')
    .replaceAll(/(?:\*\*|__|~~|`)/g, '')
    .replaceAll(/^[ \t]*[-*_](?:[ \t]*[-*_]){2,}[ \t]*$/gm, '')
    .replaceAll(/[ \t]+$/gm, '')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()

const convertHtml = (html: string, format: WebfetchFormat): string => {
  if (format === 'html') {
    return html
  }
  const markdown = htmlToMarkdown(html)
  return format === 'text' ? markdownToText(markdown) : markdown
}

const requestHeaders = (format: WebfetchFormat) => ({
  accept:
    format === 'html'
      ? 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'
      : 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
  'user-agent': 'pi-webfetch/1.0',
})

/**
 * `HttpClientResponse` exposes neither `statusText` nor the raw body needed to cancel an
 * abandoned redirect hop (effect v4 beta.102 has no client-side accessor for either).
 * `FetchHttpClient.Fetch` runs exactly once per request (no retry), so wrapping it here to
 * capture the raw values alongside the real fetch call is safe and does not change what is
 * sent over the wire.
 */
interface RawResponseMeta {
  readonly statusText: string
  readonly body: ReadableStream<Uint8Array> | null
  readonly url: string
}

interface ResponseCapture {
  current?: RawResponseMeta
}

const capturingFetch = (raw: typeof fetch, box: ResponseCapture): typeof fetch => {
  // oxlint-disable-next-line effecttsgo/async-function -- Must stay assignable to `typeof fetch` for the callers that receive it.
  const wrapped = async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
    const response = await raw(input, init)
    box.current = { body: response.body, statusText: response.statusText, url: response.url }
    return response
  }
  return wrapped
}

/** Redirects are followed by `fetch` itself; `response.url` is the hop the body finally came from. */
const executeRequest = (
  url: URL,
  format: WebfetchFormat
): Effect.Effect<
  { finalUrl: string; meta: RawResponseMeta | undefined; response: HttpClientResponse.HttpClientResponse },
  HttpClientError.HttpClientError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const rawFetch = yield* FetchHttpClient.Fetch
    const box: ResponseCapture = {}
    const response = yield* client
      .execute(HttpClientRequest.get(url, { headers: requestHeaders(format) }))
      .pipe(Effect.provideService(FetchHttpClient.Fetch, capturingFetch(rawFetch, box)))
    const meta = box.current
    return { finalUrl: isNullOrUndefined(meta) || isEmptyString(meta.url) ? url.href : meta.url, meta, response }
  })

const isEmptyBodyError = (error: unknown): error is HttpClientError.HttpClientError =>
  HttpClientError.isHttpClientError(error) && error.reason._tag === 'EmptyBodyError'

const readCappedBody = (
  response: HttpClientResponse.HttpClientResponse,
  meta: RawResponseMeta | undefined
): Effect.Effect<Uint8Array, ToolFailure | HttpClientError.HttpClientError> =>
  Effect.gen(function* () {
    const declaredLength = Number(response.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
      /*
       * Rejecting on the declared length alone leaves the body unread, so it is cancelled here for
       * the same reason an abandoned redirect hop is: otherwise the connection is held until GC.
       */
      yield* Effect.promise(() => meta?.body?.cancel() ?? Promise.resolve()).pipe(Effect.ignore)
      return yield* ToolFailure.make({
        message: `Response is too large: ${formatSize(declaredLength)} exceeds the ${formatSize(MAX_DOWNLOAD_BYTES)} download limit`,
      })
    }

    const chunks: Uint8Array[] = []
    let size = 0
    yield* response.stream.pipe(
      Stream.runForEach((chunk) => {
        size += chunk.byteLength
        if (size > MAX_DOWNLOAD_BYTES) {
          return Effect.fail(ToolFailure.make({ message: `Response is too large: it exceeds the ${formatSize(MAX_DOWNLOAD_BYTES)} download limit` }))
        }
        chunks.push(chunk)
        return Effect.void
      }),
      Effect.catchIf(isEmptyBodyError, () => Effect.void)
    )

    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return body
  })

const webfetchFailure = (failure: ToolFailure | HttpClientError.HttpClientError): ToolFailure => {
  if (failure._tag === 'ToolFailure') {
    return failure
  }
  const transportCause = failure.reason._tag === 'TransportError' ? failure.reason.cause : undefined
  return ToolFailure.make({
    cause: transportCause ?? failure,
    message: transportCause instanceof Error ? transportCause.message : failure.message,
  })
}

const saveFullOutput = (content: string): Effect.Effect<string, ToolFailure> =>
  writePrivateTempFileEffect(content, { prefix: 'pi-webfetch-' }).pipe(
    Effect.mapError((cause) => ToolFailure.make({ cause, message: cause.message }))
  )

interface BuildFetchResultOptions {
  readonly body: Uint8Array
  readonly finalUrl: string
  readonly format: WebfetchFormat
  readonly response: HttpClientResponse.HttpClientResponse
  readonly statusText: string
  readonly timeoutSeconds: number
  readonly url: URL
}

const buildFetchResult = ({
  body,
  finalUrl,
  format,
  response,
  statusText,
  timeoutSeconds,
  url,
}: BuildFetchResultOptions): Effect.Effect<AgentToolResult<WebfetchDetails>, ToolFailure> =>
  Effect.gen(function* () {
    const decoded = new TextDecoder().decode(body)
    const contentType = response.headers['content-type'] ?? ''
    const converted = isHtml(contentType) && format !== 'html'
    const completeOutput = isHtml(contentType) ? yield* Effect.sync(() => convertHtml(decoded, format)) : decoded
    const bounded = yield* boundToolTextEffect(completeOutput, {
      maxBytes: MAX_OUTPUT_BYTES,
      maxLines: MAX_OUTPUT_LINES,
      saveFullOutput,
    })
    const { fullOutputPath, truncation } = bounded

    const details: WebfetchDetails = {
      contentType,
      converted,
      downloadedBytes: body.byteLength,
      finalUrl,
      format,
      outputBytes: truncation.outputBytes,
      outputTruncated: truncation.truncated,
      status: response.status,
      statusText,
      timeoutSeconds,
      url: url.href,
    }
    if (!isNullOrUndefined(fullOutputPath) && !isEmptyString(fullOutputPath)) {
      details.fullOutputPath = fullOutputPath
    }
    return { content: [{ text: bounded.text, type: 'text' }], details }
  })

const cancellationEffect = (signal: AbortSignal): Effect.Effect<never, ToolFailure> =>
  Effect.callback<never, ToolFailure>((resume) => {
    const cancel = () => resume(Effect.fail(ToolFailure.make({ message: 'webfetch was cancelled' })))
    if (signal.aborted) {
      cancel()
      return undefined
    }
    signal.addEventListener('abort', cancel, { once: true })
    return Effect.sync(() => signal.removeEventListener('abort', cancel))
  })

interface FetchResultOptions {
  readonly onUpdate: ((result: AgentToolResult<unknown>) => void) | undefined
  readonly params: WebfetchInput
  readonly signal: AbortSignal | undefined
}

const fetchResult = ({
  onUpdate,
  params,
  signal,
}: FetchResultOptions): Effect.Effect<AgentToolResult<WebfetchDetails>, ToolFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = yield* parseUrlEffect(params.url)
    const format = resolveFormat(params.format)
    const timeoutSeconds = normalizeTimeout(params.timeout)

    onUpdate?.({
      content: [{ text: `Fetching ${url.href} as ${format} (timeout ${timeoutSeconds}s)...`, type: 'text' }],
      details: {},
    })

    const main = Effect.gen(function* () {
      const { finalUrl, meta, response } = yield* executeRequest(url, format)
      const body = yield* readCappedBody(response, meta)
      return yield* buildFetchResult({
        body,
        finalUrl,
        format,
        response,
        statusText: meta?.statusText ?? '',
        timeoutSeconds,
        url,
      })
    }).pipe(Effect.mapError(webfetchFailure))

    const withTimeout = main.pipe(
      Effect.timeout(Duration.seconds(timeoutSeconds)),
      Effect.catchTag('TimeoutError', () => ToolFailure.make({ message: `webfetch timed out after ${timeoutSeconds}s` }))
    )

    return yield* signal === undefined ? withTimeout : Effect.raceFirst(withTimeout, cancellationEffect(signal))
  })

export type WebfetchRunner = (
  params: WebfetchInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined
) => Promise<AgentToolResult<WebfetchDetails>>

export const makeWebfetchRunner =
  (runtime: AppRuntime): WebfetchRunner =>
  (params, signal, onUpdate) =>
    runtime.runPromise(
      Effect.suspend(() =>
        isTrue(signal?.aborted) ? Effect.fail(ToolFailure.make({ message: 'webfetch was cancelled' })) : fetchResult({ onUpdate, params, signal })
      )
    )

export const renderWebfetchResult = (result: AgentToolResult<unknown>, { expanded }: ToolRenderResultOptions, theme: Theme): Component => {
  const content = result.content.find((item) => item.type === 'text')
  const output = new Text(theme.fg('toolOutput', content?.text ?? ''), 0, 0)
  if (expanded) {
    return output
  }
  const hint = new Text(`${theme.fg('dim', '… ')}${keyText('app.tools.expand')} to expand`, 0, 0)
  return {
    invalidate() {
      output.invalidate()
      hint.invalidate()
    },
    render(width) {
      const lines = output.render(width)
      return lines.length > PREVIEW_LINES ? [...lines.slice(0, PREVIEW_LINES), ...hint.render(width)] : lines
    },
  }
}
