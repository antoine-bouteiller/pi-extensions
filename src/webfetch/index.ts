import { StringEnum } from '@earendil-works/pi-ai'
import { type AgentToolResult, type ExtensionAPI, formatSize } from '@earendil-works/pi-coding-agent'
import TurndownService from 'turndown'
import { Type, type Static } from 'typebox'

import { boundToolText, writePrivateTempFile } from '../shared/tool_output'

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
type WebfetchFormat = NonNullable<WebfetchInput['format']>

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

export type WebfetchFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface WebfetchDependencies {
  fetch: WebfetchFetch
  saveFullOutput: (content: string) => Promise<string>
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
    const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
    if (match?.[1]) {
      return match[1]
    }
  }
  return html
}

const pageTitle = (html: string): string | undefined => {
  const match = html.match(/<title\b[^>]*>(?<title>[\s\S]*?)<\/title>/i)
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

const readLimitedBody = async (response: Response, signal: AbortSignal): Promise<Uint8Array> => {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Response is too large: ${formatSize(declaredLength)} exceeds the ${formatSize(MAX_DOWNLOAD_BYTES)} download limit`)
  }
  if (!response.body) {
    return new Uint8Array()
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      if (signal.aborted) {
        throw signal.reason ?? new Error('webfetch was cancelled')
      }
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > MAX_DOWNLOAD_BYTES) {
        await reader.cancel()
        throw new Error(`Response is too large: it exceeds the ${formatSize(MAX_DOWNLOAD_BYTES)} download limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

const defaultSaveFullOutput = (content: string): Promise<string> => writePrivateTempFile(content, { prefix: 'pi-webfetch-' })

interface FetchResultOptions {
  params: WebfetchInput
  externalSignal: AbortSignal | undefined
  onUpdate: ((result: AgentToolResult<unknown>) => void) | undefined
  dependencies: WebfetchDependencies
}

interface DecodedResponseOptions {
  body: Uint8Array
  dependencies: WebfetchDependencies
  format: WebfetchFormat
  timeoutSeconds: number
  url: URL
}

const buildFetchResult = async (
  response: Response,
  { body, dependencies, format, timeoutSeconds, url }: DecodedResponseOptions
): Promise<AgentToolResult<WebfetchDetails>> => {
  const decoded = new TextDecoder().decode(body)
  const contentType = response.headers.get('content-type') ?? ''
  const converted = isHtml(contentType) && format !== 'html'
  const completeOutput = isHtml(contentType) ? convertHtml(decoded, format) : decoded
  const bounded = await boundToolText(completeOutput, {
    maxBytes: MAX_OUTPUT_BYTES,
    maxLines: MAX_OUTPUT_LINES,
    saveFullOutput: dependencies.saveFullOutput,
  })
  const output = bounded.text
  const { fullOutputPath, truncation } = bounded

  const details: WebfetchDetails = {
    contentType,
    converted,
    downloadedBytes: body.byteLength,
    finalUrl: response.url || url.href,
    format,
    outputBytes: truncation.outputBytes,
    outputTruncated: truncation.truncated,
    status: response.status,
    statusText: response.statusText,
    timeoutSeconds,
    url: url.href,
    ...(fullOutputPath ? { fullOutputPath } : {}),
  }
  return { content: [{ text: output, type: 'text' }], details }
}

const fetchResult = async ({ dependencies, externalSignal, onUpdate, params }: FetchResultOptions): Promise<AgentToolResult<WebfetchDetails>> => {
  const url = parseUrl(params.url)
  const format = params.format ?? 'markdown'
  const timeoutSeconds = normalizeTimeout(params.timeout)
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort(externalSignal?.reason ?? new Error('webfetch was cancelled'))
  externalSignal?.addEventListener('abort', cancel, { once: true })
  if (externalSignal?.aborted) {
    cancel()
  }
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`webfetch timed out after ${timeoutSeconds}s`))
  }, timeoutSeconds * 1000)

  onUpdate?.({
    content: [
      {
        text: `Fetching ${url.href} as ${format} (timeout ${timeoutSeconds}s)...`,
        type: 'text',
      },
    ],
    details: {},
  })

  try {
    const response = await dependencies.fetch(url, {
      headers: {
        accept:
          format === 'html'
            ? 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'
            : 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
        'user-agent': 'pi-webfetch/1.0',
      },
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    })
    const body = await readLimitedBody(response, controller.signal)
    return await buildFetchResult(response, {
      body,
      dependencies,
      format,
      timeoutSeconds,
      url,
    })
  } catch (error) {
    if (timedOut) {
      throw new Error(`webfetch timed out after ${timeoutSeconds}s`, { cause: error })
    }
    if (externalSignal?.aborted) {
      throw new Error('webfetch was cancelled', { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', cancel)
  }
}

export const createWebfetchExtension = (overrides: Partial<WebfetchDependencies> = {}): ((pi: ExtensionAPI) => void) => {
  const dependencies: WebfetchDependencies = {
    fetch: overrides.fetch ?? globalThis.fetch.bind(globalThis),
    saveFullOutput: overrides.saveFullOutput ?? defaultSaveFullOutput,
  }

  return function webfetchExtension(pi: ExtensionAPI): void {
    pi.registerTool({
      description: `Fetch an HTTP(S) URL and return its content as markdown, plain text, or raw HTML. HTML defaults to markdown. Downloads are limited to ${formatSize(MAX_DOWNLOAD_BYTES)}; output is truncated to ${MAX_OUTPUT_LINES} lines or ${formatSize(MAX_OUTPUT_BYTES)} and saved to a temporary file when larger.`,
      async execute(_toolCallId, params, signal, onUpdate) {
        return await fetchResult({ dependencies, externalSignal: signal, onUpdate, params })
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
