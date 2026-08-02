import { StringEnum } from '@earendil-works/pi-ai'
import { type AgentToolResult, type ExtensionAPI, formatSize } from '@earendil-works/pi-coding-agent'
import { Clock, Duration, Effect, Layer, ManagedRuntime, Schema, Stream } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, type HttpClientResponse } from 'effect/unstable/http'
import TurndownService from 'turndown'
import { Type, type Static } from 'typebox'

import { ToolFailure } from '../effect/errors.js'
import { boundToolTextEffect, writePrivateTempFileEffect } from '../shared/tool_output.js'

const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 120
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024
const MAX_OUTPUT_BYTES = 50 * 1024
const MAX_OUTPUT_LINES = 2000

const WebfetchParams = Type.Object({
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

/** Kept for tests: the shape `HttpClientRequest.get`'s injected `Fetch` accepts. */
export type WebfetchFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface WebfetchDependencies {
  clock?: Clock.Clock
  httpClient: Layer.Layer<HttpClient.HttpClient>
  saveFullOutput: (content: string) => Effect.Effect<string, unknown>
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
    catch: (cause) => new ToolFailure({ message: cause instanceof Error ? cause.message : String(cause) }),
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
    if (match?.[1]) {
      return match[1]
    }
  }
  return html
}

const pageTitle = (html: string): string | undefined => {
  const match = /<title\b[^>]*>(?<title>[\s\S]*?)<\/title>/i.exec(html)
  const captured = match?.groups?.title
  if (!captured) {
    return undefined
  }
  const title = turndown().turndown(captured).replaceAll(/\s+/g, ' ').trim()
  return title || undefined
}

const htmlToMarkdown = (html: string): string => {
  const title = pageTitle(html)
  const content = turndown()
    .turndown(articleHtml(html))
    .replaceAll(/[ \t]+$/gm, '')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()

  if (!title) {
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

const requestHeaders = (format: WebfetchFormat): Record<string, string> => ({
  accept:
    format === 'html'
      ? 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'
      : 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
  'user-agent': 'pi-webfetch/1.0',
})

/**
 * `HttpClientResponse` never exposes `statusText` or the post-redirect `url` (effect v4
 * beta.102 has no client-side accessor for either). `FetchHttpClient.Fetch` runs exactly
 * once per request (no retry), so wrapping it here to capture the raw values alongside the
 * real fetch call is safe and does not change what is sent over the wire.
 */
interface RawResponseMeta {
  readonly statusText: string
  readonly url: string
}

const capturingFetch = (raw: typeof fetch, box: { current?: RawResponseMeta }): typeof fetch => {
  const wrapped = async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
    const response = await raw(input, init)
    box.current = { statusText: response.statusText, url: response.url }
    return response
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a plain wrapper function has no `.preconnect`; only ever invoked as a callable, never as `fetch.preconnect`.
  return wrapped as typeof fetch
}

const executeRequest = (
  request: HttpClientRequest.HttpClientRequest
): Effect.Effect<
  { meta: RawResponseMeta | undefined; response: HttpClientResponse.HttpClientResponse },
  HttpClientError.HttpClientError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const rawFetch = yield* FetchHttpClient.Fetch
    const box: { current?: RawResponseMeta } = {}
    const response = yield* client.execute(request).pipe(Effect.provideService(FetchHttpClient.Fetch, capturingFetch(rawFetch, box)))
    return { meta: box.current, response }
  })

const isEmptyBodyError = (error: unknown): error is HttpClientError.HttpClientError =>
  HttpClientError.isHttpClientError(error) && error.reason._tag === 'EmptyBodyError'

const readCappedBody = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<Uint8Array, ToolFailure | HttpClientError.HttpClientError> =>
  Effect.gen(function* () {
    const declaredLength = Number(response.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
      return yield* Effect.fail(
        new ToolFailure({
          message: `Response is too large: ${formatSize(declaredLength)} exceeds the ${formatSize(MAX_DOWNLOAD_BYTES)} download limit`,
        })
      )
    }

    const chunks: Uint8Array[] = []
    let size = 0
    yield* response.stream.pipe(
      Stream.runForEach((chunk) => {
        size += chunk.byteLength
        if (size > MAX_DOWNLOAD_BYTES) {
          return Effect.fail(new ToolFailure({ message: `Response is too large: it exceeds the ${formatSize(MAX_DOWNLOAD_BYTES)} download limit` }))
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

interface BuildFetchResultOptions {
  readonly body: Uint8Array
  readonly dependencies: WebfetchDependencies
  readonly finalUrl: string
  readonly format: WebfetchFormat
  readonly response: HttpClientResponse.HttpClientResponse
  readonly statusText: string
  readonly timeoutSeconds: number
  readonly url: URL
}

const buildFetchResult = ({
  body,
  dependencies,
  finalUrl,
  format,
  response,
  statusText,
  timeoutSeconds,
  url,
}: BuildFetchResultOptions): Effect.Effect<AgentToolResult<WebfetchDetails>, unknown> =>
  Effect.gen(function* () {
    const decoded = new TextDecoder().decode(body)
    const contentType = response.headers['content-type'] ?? ''
    const converted = isHtml(contentType) && format !== 'html'
    const completeOutput = isHtml(contentType) ? yield* Effect.sync(() => convertHtml(decoded, format)) : decoded
    const bounded = yield* boundToolTextEffect(completeOutput, {
      maxBytes: MAX_OUTPUT_BYTES,
      maxLines: MAX_OUTPUT_LINES,
      saveFullOutput: dependencies.saveFullOutput,
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
      ...(fullOutputPath ? { fullOutputPath } : {}),
    }
    return { content: [{ text: bounded.text, type: 'text' }], details }
  })

const isTimeoutError = (error: unknown): error is { readonly _tag: 'TimeoutError' } =>
  typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'TimeoutError'

const cancellationEffect = (signal: AbortSignal): Effect.Effect<never, ToolFailure> =>
  Effect.callback<never, ToolFailure>((resume) => {
    const cancel = () => resume(Effect.fail(new ToolFailure({ message: 'webfetch was cancelled' })))
    if (signal.aborted) {
      cancel()
      return undefined
    }
    signal.addEventListener('abort', cancel, { once: true })
    return Effect.sync(() => signal.removeEventListener('abort', cancel))
  })

interface FetchResultOptions {
  readonly dependencies: WebfetchDependencies
  readonly onUpdate: ((result: AgentToolResult<unknown>) => void) | undefined
  readonly params: WebfetchInput
  readonly signal: AbortSignal | undefined
}

const fetchResult = ({
  dependencies,
  onUpdate,
  params,
  signal,
}: FetchResultOptions): Effect.Effect<AgentToolResult<WebfetchDetails>, unknown, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = yield* parseUrlEffect(params.url)
    const format = resolveFormat(params.format)
    const timeoutSeconds = normalizeTimeout(params.timeout)

    onUpdate?.({
      content: [{ text: `Fetching ${url.href} as ${format} (timeout ${timeoutSeconds}s)...`, type: 'text' }],
      details: {},
    })

    const request = HttpClientRequest.get(url, { headers: requestHeaders(format) })

    const main = Effect.gen(function* () {
      const { meta, response } = yield* executeRequest(request)
      const body = yield* readCappedBody(response)
      return yield* buildFetchResult({
        body,
        dependencies,
        finalUrl: meta?.url || url.href,
        format,
        response,
        statusText: meta?.statusText ?? '',
        timeoutSeconds,
        url,
      })
    })

    const withTimeout = main.pipe(
      Effect.timeout(Duration.seconds(timeoutSeconds)),
      Effect.catch((error) =>
        isTimeoutError(error) ? Effect.fail(new ToolFailure({ message: `webfetch timed out after ${timeoutSeconds}s` })) : Effect.fail(error)
      )
    )

    return yield* signal ? Effect.raceFirst(withTimeout, cancellationEffect(signal)) : withTimeout
  })

const toRejection = (failure: unknown): Error => {
  if (failure instanceof ToolFailure) {
    return new Error(failure.message)
  }
  if (HttpClientError.isHttpClientError(failure)) {
    const { reason } = failure
    if (reason._tag === 'TransportError' && reason.cause instanceof Error) {
      return reason.cause
    }
    return new Error(failure.message)
  }
  if (failure instanceof Error) {
    return failure
  }
  return new Error(String(failure))
}

export const createWebfetchExtension = (overrides: Partial<WebfetchDependencies> = {}): ((pi: ExtensionAPI) => void) => {
  const dependencies: WebfetchDependencies = {
    ...(overrides.clock ? { clock: overrides.clock } : {}),
    httpClient: overrides.httpClient ?? FetchHttpClient.layer,
    saveFullOutput: overrides.saveFullOutput ?? ((content) => writePrivateTempFileEffect(content, { prefix: 'pi-webfetch-' })),
  }

  return function webfetchExtension(pi: ExtensionAPI): void {
    const runtime = ManagedRuntime.make(
      dependencies.clock ? Layer.mergeAll(dependencies.httpClient, Layer.succeed(Clock.Clock)(dependencies.clock)) : dependencies.httpClient
    )

    pi.registerTool({
      description: `Fetch an HTTP(S) URL and return its content as markdown, plain text, or raw HTML. HTML defaults to markdown. Downloads are limited to ${formatSize(MAX_DOWNLOAD_BYTES)}; output is truncated to ${MAX_OUTPUT_LINES} lines or ${formatSize(MAX_OUTPUT_BYTES)} and saved to a temporary file when larger.`,
      async execute(_toolCallId, params, signal, onUpdate) {
        return await runtime.runPromise(
          Effect.suspend(() =>
            signal?.aborted
              ? Effect.fail(new ToolFailure({ message: 'webfetch was cancelled' }))
              : fetchResult({ dependencies, onUpdate, params, signal })
          ).pipe(Effect.catch((error) => Effect.fail(toRejection(error))))
        )
      },
      label: 'Web Fetch',
      name: 'webfetch',
      parameters: WebfetchParams,
      promptGuidelines: [
        'Use webfetch to read a known static web page or HTTP endpoint. Use agent-browser instead when the task requires interaction, authentication, screenshots, or JavaScript-rendered content.',
      ],
      promptSnippet: 'Fetch and read static web pages or HTTP endpoints',
    })
  }
}

export default createWebfetchExtension()
