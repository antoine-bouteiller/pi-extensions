import { describe, expect, test } from 'bun:test'

import { type AgentToolResult } from '@earendil-works/pi-coding-agent'

import { asTool } from '#test-utils/casts'
import { createFakePi } from '#test-utils/fake_pi'

import { createWebfetchExtension, type WebfetchDetails, type WebfetchFetch, type WebfetchInput } from '../index.js'

const createHarness = (fetch: WebfetchFetch, saveFullOutput?: (content: string) => Promise<string>) => {
  const fixture = createFakePi()
  createWebfetchExtension({ fetch, saveFullOutput })(fixture.pi)
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

describe('webfetch', () => {
  test('registers the tool with static-web guidance', () => {
    const harness = createHarness(async () => new Response('ok'))

    expect([...harness.fixture.state.tools.keys()]).toEqual(['webfetch'])
    expect(harness.tool?.label).toBe('Web Fetch')
    expect(harness.tool?.promptSnippet).toContain('static web pages')
  })

  test('fetches HTML, extracts article content, and converts it to markdown', async () => {
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

  test('supports plain text and raw HTML output', async () => {
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

  test('returns non-HTML responses unchanged and preserves non-success status metadata', async () => {
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

  test('rejects unsupported protocols before making a request', async () => {
    let calls = 0
    const harness = createHarness(async () => {
      calls += 1
      return new Response('unexpected')
    })

    expect(harness.execute({ url: 'file:///etc/passwd' })).rejects.toThrow('only supports HTTP and HTTPS')
    expect(harness.execute({ url: 'not a url' })).rejects.toThrow('Invalid URL')
    expect(calls).toBe(0)
  })

  test('rejects responses larger than the download limit', async () => {
    const harness = createHarness(
      async () =>
        new Response('ignored', {
          headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
        })
    )

    expect(harness.execute({ url: 'https://example.com/large' })).rejects.toThrow('download limit')
  })

  test('truncates large model output and saves the complete text', async () => {
    const complete = `${'a'.repeat(60 * 1024)}\nlast line`
    let saved = ''
    const harness = createHarness(
      async () => new Response(complete, { headers: { 'content-type': 'text/plain' } }),
      async (content) => {
        saved = content
        return '/tmp/pi-webfetch-test/output.txt'
      }
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

  test('propagates cancellation as a concise tool error', async () => {
    const harness = createHarness(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          })
        })
    )
    const controller = new AbortController()
    const pending = harness.execute({ url: 'https://example.com/slow' }, controller.signal)

    controller.abort()

    expect(pending).rejects.toThrow('webfetch was cancelled')
  })
})
