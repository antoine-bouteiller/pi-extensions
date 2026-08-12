// oxlint-disable-next-line effecttsgo/node-builtin-import -- The spec reserves a real loopback listener to verify ephemeral-port release; an HTTP client cannot create that server.
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

import { DEFAULT_MAX_BYTES } from '@earendil-works/pi-coding-agent'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asError, asNarrowed } from '@tests/utils/casts.js'
import { deferred } from '@tests/utils/deferred.js'
import { httpGet } from '@tests/utils/http.js'
import { Effect, FileSystem, Path } from 'effect'

import { readonlyMcpPolicy, type McpOperationOptions, type McpSearchOptions } from '@/features/mcp/gateway.js'
import { KeychainCredentialError, type CredentialStore } from '@/features/mcp/keychain.js'
import { McpManager, McpManagerService, mcpManagerLayer } from '@/features/mcp/manager.js'
import { type McpGatewayPolicy, type McpServerMap } from '@/features/mcp/types.js'

class FakeTransport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  closed = 0
  readonly kind: 'stdio' | 'streamable-http' | 'sse'
  readonly provider?: OAuthClientProvider
  finish?: (code: string) => void

  constructor(kind: 'stdio' | 'streamable-http' | 'sse', provider?: OAuthClientProvider, finish?: (code: string) => void) {
    this.kind = kind
    this.provider = provider
    this.finish = finish
  }
  async start() {
    /* Empty */
  }
  async send(_message: JSONRPCMessage) {
    /* Empty */
  }
  async close() {
    this.closed += 1
  }
  async finishAuth(code: string) {
    this.finish?.(code)
  }
}

interface FakePage {
  tools: {
    name: string
    description?: string
    inputSchema: Record<string, unknown>
    annotations?: {
      title?: unknown
      readOnlyHint?: unknown
      destructiveHint?: unknown
      idempotentHint?: unknown
      openWorldHint?: unknown
    }
  }[]
  nextCursor?: string
}

const harness = (
  options: {
    config?: McpServerMap
    pages?: Record<string, FakePage>
    connect?: (transport: FakeTransport, provider?: OAuthClientProvider) => Promise<void>
    call?: (params: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>
    callResult?: unknown
    openUrl?: (url: string, signal?: AbortSignal) => Promise<void>
    credentialStore?: CredentialStore
    policy?: McpGatewayPolicy
  } = {}
) => {
  const calls = {
    clients: 0,
    closes: 0,
    connects: [] as string[],
    keychainReads: 0,
    lists: [] as (string | undefined)[],
    toolCalls: [] as { name: string; arguments: Record<string, unknown> }[],
    transports: [] as FakeTransport[],
  }
  const pages = options.pages ?? {
    root: {
      tools: [
        {
          description: 'Echo text',
          inputSchema: { properties: { text: { type: 'string' } }, type: 'object' },
          name: 'echo',
        },
      ],
    },
  }

  const manager = new McpManager(options.config ?? { local: { command: 'fixture', type: 'stdio' } }, {
    createClient() {
      calls.clients += 1
      return {
        async callTool(params: { name: string; arguments: Record<string, unknown> }) {
          calls.toolCalls.push(params)
          if (options.call !== undefined) {
            return options.call(params)
          }
          return options.callResult ?? { content: [{ text: 'ok', type: 'text' }] }
        },
        async close() {
          calls.closes += 1
        },
        async connect(transport: Transport) {
          const fake = asNarrowed<FakeTransport, Transport>(transport)
          calls.connects.push(fake.kind)
          await options.connect?.(fake, fake.provider)
        },
        getInstructions() {
          return 'fixture instructions'
        },
        async listTools(params?: { cursor?: string }) {
          calls.lists.push(params?.cursor)
          const page = pages[params?.cursor ?? 'root']
          if (page === undefined) {
            throw new Error('missing fixture page')
          }
          return page
        },
      }
    },
    createTransport(_name, _config, { authProvider, kind }) {
      const transport = new FakeTransport(kind, authProvider)
      calls.transports.push(transport)
      return transport
    },
    credentialStore: options.credentialStore ?? {
      async delete() {
        /* Empty: never invoked when tests provide credentials explicitly. */
      },
      async get() {
        calls.keychainReads += 1
        return undefined
      },
      async set() {
        /* Empty: writes are only asserted through calls.keychainReads. */
      },
    },
    openUrl: options.openUrl ?? (async () => undefined),
    policy: options.policy,
  })
  return { calls, manager: promised(manager) }
}

/** The manager is Effect-native; these behavioural tests drive it through one promise facade. */
const promised = (manager: McpManager) => ({
  authenticate: (server: string, options?: McpOperationOptions) => Effect.runPromise(manager.authenticate(server, options)),
  call: (tool: string, args: Record<string, unknown>, options?: McpOperationOptions) => Effect.runPromise(manager.call(tool, args, options)),
  close: () => Effect.runPromise(manager.close),
  connect: (server: string, options?: McpOperationOptions) => Effect.runPromise(manager.connect(server, options)),
  describe: (tool: string, options?: McpOperationOptions) => Effect.runPromise(manager.describe(tool, options)),
  list: (server: string, options?: McpOperationOptions) => Effect.runPromise(manager.list(server, options)),
  oauthServers: () => manager.oauthServers(),
  search: (query: string, options?: McpSearchOptions) => Effect.runPromise(manager.search(query, options)),
  status: () => manager.status(),
})

const freePort = async (): Promise<number> => {
  const server = createServer()
  await Effect.runPromise(
    Effect.callback<void>((resume) => {
      const onError = (error: Error) => resume(Effect.die(error))
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError)
        resume(Effect.void)
      })
      return Effect.sync(() => {
        server.close()
      })
    })
  )
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('missing address')
  }
  const { port } = address
  await Effect.runPromise(
    Effect.callback<void>((resume) => {
      server.close((error) => resume(error === undefined ? Effect.void : Effect.die(error)))
    })
  )
  return port
}

describe('MCP manager', () => {
  it.effect('construction and status are metadata-only', () =>
    Effect.sync(() => {
      const fixture = harness({
        config: {
          broken: { invalid: true },
          explicit: {
            headers: { 'X-Tenant': 'one' },
            oauth: {},
            type: 'http',
            url: 'https://example.test/mcp',
          },
          headers: {
            headers: { Authorization: 'Bearer token' },
            type: 'http',
            url: 'https://example.test/mcp',
          },
          linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
          local: { command: 'fixture', type: 'stdio' },
          off: { disabled: true },
        },
      })

      expect(fixture.manager.status().find((server) => server.name === 'broken')).toEqual({ name: 'broken', status: 'invalid-config' })
      expect(fixture.manager.oauthServers()).toEqual(['explicit', 'linear'])
      expect(fixture.calls.clients).toBe(0)
      expect(fixture.calls.connects).toEqual([])
      expect(fixture.calls.keychainReads).toBe(0)
    })
  )

  it.effect('invalid config cannot connect and does not hide usable servers from search', () =>
    Effect.gen(function* () {
      const fixture = harness({
        config: {
          broken: { invalid: true },
          local: { command: 'fixture', type: 'stdio' },
        },
      })

      const invalidConnection = yield* Effect.promise(() => fixture.manager.connect('broken').catch((error: unknown) => error))
      expect(asError(invalidConnection).message).toContain('invalid config')
      const tools = yield* Effect.promise(() => fixture.manager.search('echo'))
      expect(tools.map((tool) => tool.name)).toEqual(['local_echo'])
      const description = yield* Effect.promise(() => fixture.manager.describe('echo'))
      expect(description.name).toBe('local_echo')
      expect(fixture.calls.clients).toBe(1)
    })
  )

  it.effect('the first concurrent list shares one lazy stdio connection', () =>
    Effect.gen(function* () {
      const gate = deferred<void>()
      const fixture = harness({ connect: async () => gate.promise })

      const first = fixture.manager.list('local')
      const second = fixture.manager.list('local')
      yield* Effect.promise(() => Promise.resolve())
      expect(fixture.calls.clients).toBe(1)
      gate.resolve(undefined)

      const [one, two] = yield* Effect.promise(() => Promise.all([first, second]))
      expect(one).toEqual(two)
      expect(fixture.calls.connects).toEqual(['stdio'])
      expect(fixture.calls.lists).toEqual([undefined])
    })
  )

  it.effect('falls back from compatible Streamable HTTP failures only', () =>
    Effect.gen(function* () {
      for (const fallbackError of [
        new StreamableHTTPError(405, 'method not allowed'),
        new StreamableHTTPError(-1, 'Unexpected content type: text/event-stream'),
      ]) {
        const fixture = harness({
          config: { remote: { type: 'http', url: 'https://example.test/mcp' } },
          connect: async (transport) => {
            if (transport.kind === 'streamable-http') {
              throw fallbackError
            }
          },
        })
        yield* Effect.promise(() => fixture.manager.list('remote'))
        expect(fixture.calls.connects).toEqual(['streamable-http', 'sse'])
      }

      const unauthorized = harness({
        config: { remote: { type: 'http', url: 'https://example.test/mcp' } },
        connect: async () => {
          throw new UnauthorizedError()
        },
      })
      expect(unauthorized.manager.list('remote')).rejects.toThrow()
      expect(unauthorized.calls.connects).toEqual(['streamable-http', 'streamable-http'])

      const broken = harness({
        config: { remote: { type: 'http', url: 'https://example.test/mcp' } },
        connect: async () => {
          throw new StreamableHTTPError(500, 'broken')
        },
      })
      expect(broken.manager.list('remote')).rejects.toThrow()
      expect(broken.calls.connects).toEqual(['streamable-http'])
    })
  )

  it.effect('defers implicit OAuth until an HTTP 401 challenge', () =>
    Effect.gen(function* () {
      let attempts = 0
      const fixture = harness({
        config: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
        connect: async (_transport, provider) => {
          attempts += 1
          if (attempts === 1) {
            expect(provider).toBeUndefined()
            expect(fixture.calls.keychainReads).toBe(0)
            throw new StreamableHTTPError(401, 'OAuth required')
          }
          expect(provider).toBeDefined()
          expect(fixture.calls.keychainReads).toBe(0)
          await provider?.tokens()
        },
      })

      yield* Effect.promise(() => fixture.manager.list('linear'))
      expect(fixture.calls.connects).toEqual(['streamable-http', 'streamable-http'])
      expect(fixture.calls.keychainReads).toBe(1)
    })
  )

  it.effect('allows explicit authentication for a URL-only HTTP server', () =>
    Effect.gen(function* () {
      const fixture = harness({
        config: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
      })

      yield* Effect.promise(() => fixture.manager.connect('linear'))
      yield* Effect.promise(() => fixture.manager.authenticate('linear'))
      expect(fixture.manager.status()).toEqual([{ name: 'linear', status: 'connected' }])
    })
  )

  it.effect('does not infer OAuth when custom HTTP headers are configured', () =>
    Effect.gen(function* () {
      const fixture = harness({
        config: {
          remote: {
            headers: { Authorization: 'Bearer token' },
            type: 'http',
            url: 'https://example.test/mcp',
          },
        },
        connect: async () => {
          throw new StreamableHTTPError(401, 'invalid token')
        },
      })

      expect(fixture.manager.oauthServers()).toEqual([])
      yield* Effect.promise(() =>
        fixture.manager.list('remote').then(
          () => {
            throw new Error('expected connection failure')
          },
          (error: unknown) => expect(error).toBeDefined()
        )
      )
      expect(fixture.calls.connects).toEqual(['streamable-http'])
      expect(fixture.calls.keychainReads).toBe(0)
    })
  )

  it.effect('loads every page, sanitizes names, searches, describes, and calls scoped tools', () =>
    Effect.gen(function* () {
      const fixture = harness({
        callResult: {
          content: [
            { text: 'hello', type: 'text' },
            { data: 'AA==', mimeType: 'image/png', type: 'image' },
            { resource: { text: 'embedded', uri: 'x://one' }, type: 'resource' },
          ],
          structuredContent: { answer: 42 },
        },
        config: { 'my server': { command: 'fixture', type: 'stdio' } },
        pages: {
          root: {
            nextCursor: 'two',
            tools: [
              {
                annotations: {
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: false,
                  readOnlyHint: true,
                  title: 'First',
                },
                description: 'Alpha',
                inputSchema: { type: 'object' },
                name: 'first.tool',
              },
            ],
          },
          two: {
            tools: [
              {
                annotations: { destructiveHint: true, readOnlyHint: false },
                description: 'Beta',
                inputSchema: { type: 'object' },
                name: 'second-tool',
              },
            ],
          },
        },
      })

      const listed = yield* Effect.promise(() => fixture.manager.list('my server'))
      expect(listed.map((tool) => tool.name)).toEqual(['my_server_first_tool', 'my_server_second-tool'])
      expect(fixture.calls.lists).toEqual([undefined, 'two'])
      const searched = yield* Effect.promise(() => fixture.manager.search('beta'))
      expect(searched[0]?.name).toBe('my_server_second-tool')
      const described = yield* Effect.promise(() => fixture.manager.describe('my_server_first_tool'))
      expect(described.remoteName).toBe('first.tool')
      expect(described.annotations).toEqual({
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
        title: 'First',
      })
      expect(listed[1]?.annotations).toEqual({ destructiveHint: true, readOnlyHint: false })

      const result = yield* Effect.promise(() => fixture.manager.call('second-tool', { value: true }, { server: 'my server' }))
      expect(fixture.calls.toolCalls).toEqual([{ arguments: { value: true }, name: 'second-tool' }])
      expect(result.content).toEqual([
        { text: 'hello', type: 'text' },
        { data: 'AA==', mimeType: 'image/png', type: 'image' },
        { text: 'embedded', type: 'text' },
        { text: '{\n  "answer": 42\n}', type: 'text' },
      ])
    })
  )

  it.effect('read-only policy filters annotated tools across discovery, description, and calls', () =>
    Effect.gen(function* () {
      const fixture = harness({
        config: { linear: { command: 'fixture', type: 'stdio' } },
        pages: {
          root: {
            tools: [
              {
                annotations: { destructiveHint: false, readOnlyHint: true },
                inputSchema: { type: 'object' },
                name: 'get_issue',
              },
              {
                annotations: { destructiveHint: false, readOnlyHint: false },
                inputSchema: { type: 'object' },
                name: 'create_issue',
              },
              {
                annotations: { destructiveHint: true, readOnlyHint: true },
                inputSchema: { type: 'object' },
                name: 'dangerous_read',
              },
              { inputSchema: { type: 'object' }, name: 'mystery' },
            ],
          },
        },
        policy: readonlyMcpPolicy,
      })

      const listed = yield* Effect.promise(() => fixture.manager.list('linear'))
      expect(listed.map((tool) => tool.remoteName)).toEqual(['get_issue'])
      const searched = yield* Effect.promise(() => fixture.manager.search('', { server: 'linear' }))
      expect(searched.map((tool) => tool.remoteName)).toEqual(['get_issue'])
      const described = yield* Effect.promise(() => fixture.manager.describe('get_issue', { server: 'linear' }))
      expect(described.annotations).toEqual({ destructiveHint: false, readOnlyHint: true })
      yield* Effect.promise(() => fixture.manager.call('linear_get_issue', {}))

      for (const denied of ['create_issue', 'dangerous_read', 'mystery']) {
        expect(fixture.manager.describe(denied, { server: 'linear' })).rejects.toThrow('read-only policy')
        expect(fixture.manager.call(denied, {}, { server: 'linear' })).rejects.toThrow(`MCP tool "${denied}" on server "linear"`)
      }
      expect(fixture.calls.toolCalls.map((call) => call.name)).toEqual(['get_issue'])
    })
  )

  it.effect('read-only policy allows only the four exact unannotated DBX metadata tools', () =>
    Effect.gen(function* () {
      const allowed = ['dbx_list_connections', 'dbx_list_tables', 'dbx_describe_table', 'dbx_get_schema_context']
      const denied = ['dbx_execute_sql', 'dbx_execute_redis', 'dbx_open_ui', 'dbx_add_connection', 'dbx_remove_connection']
      const fixture = harness({
        config: { dbx: { command: 'fixture', type: 'stdio' } },
        pages: {
          root: {
            tools: [...allowed, ...denied].map((name) => ({
              inputSchema: { type: 'object' },
              name,
            })),
          },
        },
        policy: readonlyMcpPolicy,
      })

      const listed = yield* Effect.promise(() => fixture.manager.list('dbx'))
      expect(listed.map((tool) => tool.remoteName)).toEqual(allowed)
      const searched = yield* Effect.promise(() => fixture.manager.search('dbx_', { server: 'dbx' }))
      expect(searched.map((tool) => tool.remoteName)).toEqual([...allowed].toSorted())
      for (const tool of allowed) {
        const describedTool = yield* Effect.promise(() => fixture.manager.describe(tool, { server: 'dbx' }))
        expect(describedTool.remoteName).toBe(tool)
        yield* Effect.promise(() => fixture.manager.call(tool, {}, { server: 'dbx' }))
      }
      for (const tool of denied) {
        expect(fixture.manager.describe(tool, { server: 'dbx' })).rejects.toThrow('read-only policy')
        expect(fixture.manager.call(tool, {}, { server: 'dbx' })).rejects.toThrow('read-only policy')
      }
      expect(fixture.calls.toolCalls.map((call) => call.name)).toEqual(allowed)

      const impersonator = harness({
        config: { other: { command: 'fixture', type: 'stdio' } },
        pages: {
          root: {
            tools: [{ inputSchema: { type: 'object' }, name: 'dbx_list_tables' }],
          },
        },
        policy: readonlyMcpPolicy,
      })
      expect(yield* Effect.promise(() => impersonator.manager.list('other'))).toEqual([])
      expect(impersonator.manager.call('other_dbx_list_tables', {})).rejects.toThrow('read-only policy')
    })
  )

  it.effect('passes the requested operation and canonical names to policy callbacks', () =>
    Effect.gen(function* () {
      const requests: {
        operation: string
        server: string
        remoteName: string
        exposedName: string
      }[] = []
      const fixture = harness({
        policy: {
          allows(request) {
            requests.push({
              exposedName: request.exposedName,
              operation: request.operation,
              remoteName: request.remoteName,
              server: request.server,
            })
            return true
          },
          name: 'recording',
        },
      })

      yield* Effect.promise(() => fixture.manager.list('local'))
      yield* Effect.promise(() => fixture.manager.search('echo', { server: 'local' }))
      yield* Effect.promise(() => fixture.manager.describe('echo', { server: 'local' }))
      yield* Effect.promise(() => fixture.manager.call('local_echo', {}))

      expect(requests).toEqual(
        ['list', 'search', 'describe', 'call'].map((operation) => ({
          exposedName: 'local_echo',
          operation,
          remoteName: 'echo',
          server: 'local',
        }))
      )
    })
  )

  it.effect('reports sanitized collisions, repeated cursors, invalid regex, and MCP errors', () =>
    Effect.gen(function* () {
      const collision = harness({
        pages: {
          root: {
            tools: [
              { inputSchema: { type: 'object' }, name: 'a.b' },
              { inputSchema: { type: 'object' }, name: 'a_b' },
            ],
          },
        },
      })
      expect(collision.manager.list('local')).rejects.toThrow('collision')

      const cursor = harness({
        pages: {
          again: { nextCursor: 'again', tools: [] },
          root: { nextCursor: 'again', tools: [] },
        },
      })
      expect(cursor.manager.list('local')).rejects.toThrow('repeated a tools cursor')

      const regex = harness()
      for (const unsafe of ['[', 'a*a*a*a*a*a*a*a*b', '(a+)+$']) {
        expect(regex.manager.search(unsafe, { regex: true })).rejects.toThrow('regular expression')
      }

      const toolError = harness({
        callResult: { content: [{ text: 'remote failed', type: 'text' }], isError: true },
      })
      expect(toolError.manager.call('local_echo', {})).rejects.toThrow('remote failed')

      const oversizedError = harness({
        callResult: {
          content: [{ text: 'x'.repeat(DEFAULT_MAX_BYTES * 2), type: 'text' }],
          isError: true,
        },
      })
      const failure = yield* Effect.promise(() =>
        oversizedError.manager.call('local_echo', {}).then(
          () => new Error('expected oversized MCP error'),
          (error: unknown) => asError(error)
        )
      )
      expect(Buffer.byteLength(failure.message, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
      expect(failure.message).toContain('Full output saved to:')
    })
  )

  it.effect('completes an explicit callback-driven OAuth flow and reconnects', () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => freePort())
      let authorized = false
      const opened: string[] = []
      const fixture = harness({
        config: {
          slack: {
            oauth: { callbackPort: port, clientId: 'client' },
            type: 'http',
            url: 'https://mcp.slack.test/mcp',
          },
        },
        connect: async (transport, provider) => {
          if (authorized) {
            return
          }
          if (provider === undefined) {
            throw new Error('provider missing')
          }
          await provider.saveCodeVerifier('verifier')
          const state = await provider.state?.()
          await provider.redirectToAuthorization(new URL(`https://auth.test/start?state=${encodeURIComponent(state ?? '')}`))
          transport.finish = (code: string) => {
            expect(code).toBe('oauth-code')
            authorized = true
          }
          throw new UnauthorizedError()
        },
        openUrl: async (authorizationUrl) => {
          opened.push(authorizationUrl)
          const state = new URL(authorizationUrl).searchParams.get('state')
          void httpGet(`http://localhost:${port}/callback?code=oauth-code&state=${state}`)
        },
      })

      yield* Effect.promise(() => fixture.manager.authenticate('slack'))
      expect(opened).toHaveLength(1)
      expect(fixture.manager.status()[0]?.status).toBe('connected')
      expect(fixture.calls.connects).toEqual(['streamable-http', 'streamable-http'])
    })
  )

  it.effect('keeps shared OAuth alive while another authentication waiter remains', () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => freePort())
      let authorized = false
      let openedUrl = ''
      const browserOpened = deferred<void>()
      const fixture = harness({
        config: {
          slack: {
            oauth: { callbackPort: port, clientId: 'client' },
            type: 'http',
            url: 'https://mcp.slack.test/mcp',
          },
        },
        connect: async (transport, provider) => {
          if (authorized) {
            return
          }
          const state = await provider?.state?.()
          await provider?.redirectToAuthorization(new URL(`https://auth.test/start?state=${encodeURIComponent(state ?? '')}`))
          transport.finish = () => {
            authorized = true
          }
          throw new UnauthorizedError()
        },
        openUrl: async (authorizationUrl) => {
          openedUrl = authorizationUrl
          browserOpened.resolve(undefined)
        },
      })

      // oxlint-disable-next-line effecttsgo/abort-controller-in-effect -- This test must control the exact external AbortSignal and its timing.
      const firstController = new AbortController()
      const first = fixture.manager.authenticate('slack', { signal: firstController.signal }).then(
        () => undefined,
        (error: unknown) => error
      )
      yield* Effect.promise(() => browserOpened.promise)
      const second = fixture.manager.authenticate('slack')
      firstController.abort()
      const state = new URL(openedUrl).searchParams.get('state')
      yield* Effect.promise(() => httpGet(`http://localhost:${port}/callback?code=oauth-code&state=${state}`))

      expect(yield* Effect.promise(() => first)).toBeInstanceOf(Error)
      yield* Effect.promise(() => second)
      expect(fixture.manager.status()[0]?.status).toBe('connected')
      expect(fixture.calls.connects).toEqual(['streamable-http', 'streamable-http'])
    })
  )

  it.effect('closes a directly authenticated connection when exposed names collide', () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => freePort())
      const fixture = harness({
        config: {
          'same.name': { command: 'fixture', type: 'stdio' },
          same_name: {
            oauth: { callbackPort: port, clientId: 'client' },
            type: 'http',
            url: 'https://mcp.example.test/mcp',
          },
        },
      })
      yield* Effect.promise(() => fixture.manager.connect('same.name'))
      expect(fixture.manager.authenticate('same_name')).rejects.toThrow('collision')
      expect(fixture.manager.status().find((server) => server.name === 'same_name')?.status).toBe('failed')
      expect(fixture.calls.closes).toBe(1)
    })
  )

  it.effect('uses the real SDK over stdio and terminates the fixture on close', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'pi-mcp-manager-test-' })
        const marker = path.join(directory, 'pid')
        const fixturePath = fileURLToPath(new URL('fixtures/stdio_fixture.ts', import.meta.url))
        const manager = yield* Effect.acquireRelease(
          Effect.sync(() =>
            promised(
              new McpManager(
                {
                  fixture: {
                    args: [fixturePath],
                    command: process.execPath,
                    env: { PI_MCP_FIXTURE_PID: marker },
                    type: 'stdio',
                  },
                },
                { openUrl: async () => undefined }
              )
            )
          ),
          (resource) => Effect.promise(() => resource.close())
        )

        const tools = yield* Effect.promise(() => manager.list('fixture'))
        expect(tools.map((tool) => tool.name)).toEqual(['fixture_echo_fixture'])
        const result = yield* Effect.promise(() => manager.call('fixture_echo_fixture', { value: 'hello' }))
        expect(result.content[0]).toEqual({ text: 'fixture:hello', type: 'text' })
        const pid = Number(yield* fs.readFileString(marker))

        yield* Effect.promise(() => manager.close())
        yield* Effect.promise(() => Bun.sleep(20))
        expect(() => process.kill(pid, 0)).toThrow()
      })
    )
  )

  it.effect('redacts transport and SDK request errors from status and callers', () =>
    Effect.gen(function* () {
      const transport = harness({
        config: { remote: { type: 'http', url: 'https://example.test/mcp' } },
        connect: async () => {
          throw new StreamableHTTPError(500, 'response leaked bearer secret-token')
        },
      })
      yield* Effect.promise(() =>
        transport.manager.connect('remote').then(undefined, (error: unknown) => {
          expect(asError(error).message).not.toContain('secret-token')
        })
      )
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This test exercises native JSON fixture or process behavior; schema decoding would change the boundary under test.
      expect(JSON.stringify(transport.manager.status())).not.toContain('secret-token')

      const request = harness({
        call: async () => {
          throw new Error('SDK failure leaked client_secret=secret-token')
        },
      })
      yield* Effect.promise(() =>
        request.manager.call('local_echo', {}).then(undefined, (error: unknown) => {
          expect(asError(error).message).not.toContain('secret-token')
        })
      )

      const keychain = harness({
        config: {
          remote: { oauth: {}, type: 'http', url: 'https://example.test/mcp' },
        },
        connect: async (_transport, provider) => {
          await provider?.tokens()
        },
        credentialStore: {
          async delete() {
            /* Empty: this failure test never deletes a credential. */
          },
          async get() {
            throw KeychainCredentialError.make({ message: 'macOS Keychain lookup failed. Ensure Keychain is available and unlocked, then retry.' })
          },
          async set() {
            /* Empty: this failure test never writes a credential. */
          },
        },
      })
      yield* Effect.promise(() =>
        keychain.manager.connect('remote').then(
          () => {
            throw new Error('expected Keychain failure')
          },
          (error: unknown) => {
            expect(asError(error).message).toContain('Ensure Keychain is available and unlocked')
          }
        )
      )
    })
  )

  it.effect('cancelling the sole connection waiter aborts and closes the shared attempt', () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- This Promise-shaped fake or managed runtime intentionally runs outside the ambient test Effect.
      const fixture = harness({ connect: () => Effect.runPromise(Effect.never) })
      // oxlint-disable-next-line effecttsgo/abort-controller-in-effect -- This test must control the exact external AbortSignal and its timing.
      const controller = new AbortController()
      const connecting = fixture.manager.connect('local', { signal: controller.signal })
      yield* Effect.promise(() => Promise.resolve())
      controller.abort()
      expect(connecting).rejects.toThrow()
      yield* Effect.promise(() => Bun.sleep(0))
      expect(fixture.calls.closes).toBe(1)
    })
  )

  it.effect('close aborts and awaits an in-flight connection', () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- This Promise-shaped fake or managed runtime intentionally runs outside the ambient test Effect.
      const fixture = harness({ connect: () => Effect.runPromise(Effect.never) })
      const connecting = fixture.manager.connect('local')
      yield* Effect.promise(() => Promise.resolve())
      yield* Effect.promise(() => fixture.manager.close())
      expect(connecting).rejects.toThrow()
      expect(fixture.calls.closes).toBe(1)
    })
  )

  it.effect('can be owned by an Effect Layer without connecting at construction', () =>
    Effect.gen(function* () {
      const statuses = yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* McpManagerService
          return manager.status()
        }).pipe(Effect.provide(mcpManagerLayer({}, { openUrl: async () => undefined })))
      )
      expect(statuses).toEqual([])
    })
  )

  it.effect('close is idempotent and closes connected clients', () =>
    Effect.gen(function* () {
      const fixture = harness()
      yield* Effect.promise(() => fixture.manager.connect('local'))
      yield* Effect.promise(() => fixture.manager.close())
      yield* Effect.promise(() => fixture.manager.close())
      expect(fixture.calls.closes).toBe(1)
      expect(fixture.manager.status()).toEqual([{ name: 'local', status: 'disconnected' }])
    })
  )
})
