import { type AgentToolResult, type Theme } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asError, asNarrowed, asTheme, asTool } from '@tests/utils/casts.js'
import { deferred } from '@tests/utils/deferred.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { type Clock, Data, Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http'

import { type WebfetchDetails, type WebfetchFetch, type WebfetchInput } from '@/features/webfetch/fetch.js'
import { createWebfetchExtension } from '@/features/webfetch/index.js'
import { isTrue } from '@/shared/utils/predicates.js'

const stubHttpClient = (fetchImpl: WebfetchFetch): Layer.Layer<HttpClient.HttpClient> =>
  Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch)(asNarrowed<typeof fetch, WebfetchFetch>(fetchImpl)))

class StubFetchError extends Data.TaggedError('StubFetchError')<{ readonly cause: unknown }> {}

const pendingFetch = (signal: AbortSignal | null | undefined, onStart?: () => void): Promise<Response> =>
  Effect.runPromise(
    Effect.callback<Response, StubFetchError>((resume) => {
      onStart?.()
      signal?.addEventListener('abort', () => resume(Effect.fail(new StubFetchError({ cause: signal.reason }))), { once: true })
    })
  )

const createHarness = (fetchImpl: WebfetchFetch, saveFullOutput?: (content: string) => Effect.Effect<string>, clock?: Clock.Clock) => {
  const fixture = createFakePi()
  createWebfetchExtension({ clock, httpClient: stubHttpClient(fetchImpl), saveFullOutput }, runtime)(fixture.pi)
  const tool = fixture.state.tools.get('webfetch')

  const execute = async (
    params: WebfetchInput,
    signal?: AbortSignal,
    onUpdate?: (result: AgentToolResult<unknown>) => void
  ): Promise<AgentToolResult<WebfetchDetails>> => {
    expect(tool).toBeDefined()
    const run = asTool<{
      execute: (
        id: string,
        input: WebfetchInput,
        signal?: AbortSignal,
        onUpdate?: (result: AgentToolResult<unknown>) => void
      ) => Promise<AgentToolResult<WebfetchDetails>>
    }>(tool)
    return await run.execute('call-1', params, signal, onUpdate)
  }

  return { execute, fixture, tool }
}

const text = (result: AgentToolResult<unknown>): string => {
  const [content] = result.content
  return content?.type === 'text' ? content.text : ''
}

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
    throw new Error('Expected promise to reject')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** A `ReadableStream` body has no `Content-Length`, unlike the string-body doubles above. */
const streamedResponse = (chunkBytes: number, chunkCount: number, init: ResponseInit = {}): Response => {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close()
        return
      }
      sent += 1
      controller.enqueue(new Uint8Array(chunkBytes))
    },
  })
  return new Response(stream, init)
}

describe('webfetch', () => {
  it.effect('registers the tool with static-web guidance', () => {
    const harness = createHarness(async () => new Response('ok'))

    expect([...harness.fixture.state.tools.keys()]).toEqual(['webfetch'])
    expect(harness.tool?.label).toBe('Web Fetch')
    expect(harness.tool?.promptSnippet).toContain('static web pages')
  })

  it.effect('shows a short preview until tool output is expanded', async () => {
    const complete = Array.from({ length: 25 }, (_value, index) => `line ${index + 1}`).join('\n')
    const harness = createHarness(async () => new Response(complete, { headers: { 'content-type': 'text/plain' } }))
    const result = await harness.execute({ url: 'https://example.com/preview.txt' })
    const tool = asTool<{
      renderResult: (
        result: AgentToolResult<WebfetchDetails>,
        options: { expanded: boolean; isPartial: boolean },
        theme: Theme
      ) => { render: (width: number) => string[] }
    }>(harness.tool)
    const theme = asTheme({ fg: (_color: string, value: string) => value })

    const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme).render(120).join('\n')
    const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme).render(120).join('\n')

    expect(collapsed).toContain('line 20')
    expect(collapsed).not.toContain('line 21')
    expect(collapsed).toContain('to expand')
    expect(expanded).toContain('line 25')
  })

  it.effect('fetches HTML, extracts article content, and converts it to markdown', async () => {
    const updates: string[] = []
    const html = `<!doctype html>
      <html>
        <head><title>Example page</title><style>.hidden { display: none }</style></head>
        <body>
          <nav>Navigation that should not be selected</nav>
          <article><h2>Story</h2><p>Hello <a href="https://example.com/more">world</a>.</p><script>bad()</script></article>
        </body>
      </html>`
    const harness = createHarness(
      async () =>
        new Response(html, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
          status: 200,
        })
    )

    const result = await harness.execute({ url: 'https://example.com/post' }, undefined, (update) => {
      updates.push(text(update))
    })

    expect(text(result)).toBe('# Example page\n\n## Story\n\nHello [world](https://example.com/more).')
    expect(text(result)).not.toContain('Navigation')
    expect(text(result)).not.toContain('bad()')
    expect(updates).toEqual(['Fetching https://example.com/post as markdown (timeout 30s)...'])
    expect(result.details).toMatchObject({
      contentType: 'text/html; charset=utf-8',
      converted: true,
      finalUrl: 'https://example.com/post',
      format: 'markdown',
      outputTruncated: false,
      status: 200,
      timeoutSeconds: 30,
      url: 'https://example.com/post',
    })
  })

  it.effect('tags transport failures while preserving their cause and message', async () => {
    const cause = new Error('socket exploded')
    const harness = createHarness(() => Promise.reject(cause))

    const rejection = await harness.execute({ url: 'https://example.com/failure' }).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(rejection).toMatchObject({ _tag: 'ToolFailure', cause, message: 'socket exploded' })
  })

  it.effect('supports plain text and raw HTML output', async () => {
    const html =
      "<html><head><title>Title</title></head><body><main><h1>Heading</h1><p>A <strong>bold</strong> link to <a href='https://example.com'>home</a>.</p></main></body></html>"
    const harness = createHarness(async () => new Response(html, { headers: { 'content-type': 'text/html' } }))

    const plain = await harness.execute({
      format: 'text',
      timeout: 4.2,
      url: 'https://example.com',
    })
    const raw = await harness.execute({ format: 'html', url: 'https://example.com' })

    expect(text(plain)).toBe('Title\n\nHeading\n\nA bold link to home.')
    expect(plain.details?.timeoutSeconds).toBe(5)
    expect(plain.details?.converted).toBeTrue()
    expect(text(raw)).toBe(html)
    expect(raw.details?.converted).toBeFalse()
  })

  it.effect('returns non-HTML responses unchanged and preserves non-success status metadata', async () => {
    const harness = createHarness(
      async () =>
        new Response('{"error":"missing"}', {
          headers: { 'content-type': 'application/json' },
          status: 404,
          statusText: 'Not Found',
        })
    )

    const result = await harness.execute({
      format: 'markdown',
      timeout: 500,
      url: 'https://example.com/missing',
    })

    expect(text(result)).toBe('{"error":"missing"}')
    expect(result.details).toMatchObject({
      contentType: 'application/json',
      converted: false,
      status: 404,
      statusText: 'Not Found',
      timeoutSeconds: 120,
    })
  })

  it.effect('rejects unsupported protocols before making a request', async () => {
    let calls = 0
    const harness = createHarness(async () => {
      calls += 1
      return new Response('unexpected')
    })

    expect(await rejectionMessage(harness.execute({ url: 'file:///etc/passwd' }))).toContain('only supports HTTP and HTTPS')
    expect(await rejectionMessage(harness.execute({ url: 'not a url' }))).toContain('Invalid URL')
    expect(calls).toBe(0)
  })

  it.effect('rejects responses larger than the download limit declared up front', async () => {
    const harness = createHarness(
      async () =>
        new Response('ignored', {
          headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
        })
    )

    expect(await rejectionMessage(harness.execute({ url: 'https://example.com/large' }))).toContain('download limit')
  })

  it.effect('cancels a no-Content-Length stream once it crosses the download limit mid-stream', async () => {
    let cancelledAfterChunks = -1
    let fetchAborted = false
    const harness = createHarness(async (_url, init) => {
      init?.signal?.addEventListener('abort', () => {
        fetchAborted = true
      })
      let sent = 0
      const total = 100
      const chunkBytes = 100 * 1024
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          cancelledAfterChunks = sent
        },
        pull(controller) {
          if (sent >= total || isTrue(init?.signal?.aborted)) {
            controller.close()
            return
          }
          sent += 1
          controller.enqueue(new Uint8Array(chunkBytes))
        },
      })
      return new Response(stream)
    })

    const rejection = await harness.execute({ url: 'https://example.com/huge' }).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(asError(rejection).message).toContain('download limit')
    // 5 MiB / 100 KiB chunks = chunk 53 is where the running total first exceeds the cap (Bun's
    // ReadableStream pulls one chunk ahead of what `Stream.runForEach` has consumed).
    expect(cancelledAfterChunks).toBe(53)
    expect(fetchAborted).toBeTrue()
  })

  it.effect('rejects with an exact message when the request exceeds its timeout', async () => {
    const rejection = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          const started = deferred<void>()
          const harness = createHarness((_url, init) => pendingFetch(init?.signal, () => started.resolve(undefined)), undefined, clock)
          const pending = harness.execute({ timeout: 0.05, url: 'https://example.com/slow' }).then(
            () => undefined,
            (error: unknown) => error
          )

          yield* Effect.promise(() => started.promise)
          yield* clock.adjust('1 second')
          return yield* Effect.promise(() => pending)
        })
      )
    )

    expect(asError(rejection).message).toBe('webfetch timed out after 1s')
  })

  it.effect('truncates large model output and saves the complete text', async () => {
    const complete = `${'a'.repeat(60 * 1024)}\nlast line`
    let saved = ''
    const harness = createHarness(
      async () => new Response(complete, { headers: { 'content-type': 'text/plain' } }),
      (content) =>
        Effect.sync(() => {
          saved = content
          return '/tmp/pi-webfetch-test/output.txt'
        })
    )

    const result = await harness.execute({ url: 'https://example.com/large.txt' })

    expect(saved).toBe(complete)
    expect(text(result)).toContain('[Output truncated:')
    expect(text(result)).toContain('/tmp/pi-webfetch-test/output.txt')
    expect(result.details).toMatchObject({
      fullOutputPath: '/tmp/pi-webfetch-test/output.txt',
      outputTruncated: true,
    })
  })

  it.effect('does not issue a request when cancellation happened before dispatch', async () => {
    let requests = 0
    const harness = createHarness(async () => {
      requests += 1
      return new Response('unexpected')
    })
    const controller = new AbortController()
    controller.abort()

    const rejection = await harness.execute({ url: 'https://example.com/cancelled' }, controller.signal).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(rejection).toMatchObject({ _tag: 'ToolFailure', message: 'webfetch was cancelled' })
    expect(requests).toBe(0)
  })

  it.effect('propagates cancellation as a concise, exact tool error, distinct from a timeout', async () => {
    const harness = createHarness((_url, init) => pendingFetch(init?.signal))
    const controller = new AbortController()
    const pending = harness.execute({ url: 'https://example.com/slow' }, controller.signal)

    controller.abort()

    const rejection = await pending.then(
      () => undefined,
      (error: unknown) => error
    )

    expect(asError(rejection).message).toBe('webfetch was cancelled')
  })
})

describe('webfetch streaming (unbounded)', () => {
  it.effect('accepts a no-Content-Length stream that stays under the download limit', async () => {
    const harness = createHarness(async () => streamedResponse(1024, 10, { headers: { 'content-type': 'text/plain' } }))

    const result = await harness.execute({ url: 'https://example.com/ok' })

    expect(result.details.downloadedBytes).toBe(1024 * 10)
  })
})
