export interface FakeProvider {
  readonly close: () => void
  readonly url: string
}

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`

export const startFakeProvider = (text: string): FakeProvider => {
  const server = Bun.serve({
    fetch: (request) => {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions') {
        return new Response('not found', { status: 404 })
      }
      const body = [
        sse({
          choices: [{ delta: { content: text, role: 'assistant' }, finish_reason: undefined, index: 0 }],
          created: 0,
          id: 'fake-completion',
          model: 'fake-model',
          object: 'chat.completion.chunk',
        }),
        sse({
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
          created: 0,
          id: 'fake-completion',
          model: 'fake-model',
          object: 'chat.completion.chunk',
        }),
        'data: [DONE]\n\n',
      ].join('')
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  return { close: () => server.stop(true), url: `http://127.0.0.1:${server.port}` }
}
