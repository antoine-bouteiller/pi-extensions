import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_MAX_BYTES } from '@earendil-works/pi-coding-agent'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { asError, asNarrowed } from '@tests/utils/casts.js'
import { Effect } from 'effect'

import { readonlyMcpPolicy } from '@/features/mcp/gateway.js'
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
  return { calls, manager }
}

const freePort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('missing address')
  }
  const { port } = address
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('MCP manager', () => {
  test('construction and status are metadata-only', () => {
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

  test('invalid config cannot connect and does not hide usable servers from search', async () => {
    const fixture = harness({
      config: {
        broken: { invalid: true },
        local: { command: 'fixture', type: 'stdio' },
      },
    })

    const invalidConnection = await fixture.manager.connect('broken').catch((error: unknown) => error)
    expect(asError(invalidConnection).message).toContain('invalid config')
    const tools = await fixture.manager.search('echo')
    expect(tools.map((tool) => tool.name)).toEqual(['local_echo'])
    const description = await fixture.manager.describe('echo')
    expect(description.name).toBe('local_echo')
    expect(fixture.calls.clients).toBe(1)
  })

  test('the first concurrent list shares one lazy stdio connection', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fixture = harness({ connect: async () => gate })

    const first = fixture.manager.list('local')
    const second = fixture.manager.list('local')
    await Promise.resolve()
    expect(fixture.calls.clients).toBe(1)
    release()

    const [one, two] = await Promise.all([first, second])
    expect(one).toEqual(two)
    expect(fixture.calls.connects).toEqual(['stdio'])
    expect(fixture.calls.lists).toEqual([undefined])
  })

  test('falls back from compatible Streamable HTTP failures only', async () => {
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
      await fixture.manager.list('remote')
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

  test('defers implicit OAuth until an HTTP 401 challenge', async () => {
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

    await fixture.manager.list('linear')
    expect(fixture.calls.connects).toEqual(['streamable-http', 'streamable-http'])
    expect(fixture.calls.keychainReads).toBe(1)
  })

  test('allows explicit authentication for a URL-only HTTP server', async () => {
    const fixture = harness({
      config: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
    })

    await fixture.manager.connect('linear')
    await fixture.manager.authenticate('linear')
    expect(fixture.manager.status()).toEqual([{ name: 'linear', status: 'connected' }])
  })

  test('does not infer OAuth when custom HTTP headers are configured', async () => {
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
    expect(fixture.manager.list('remote')).rejects.toThrow()
    expect(fixture.calls.connects).toEqual(['streamable-http'])
    expect(fixture.calls.keychainReads).toBe(0)
  })

  test('loads every page, sanitizes names, searches, describes, and calls scoped tools', async () => {
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

    const listed = await fixture.manager.list('my server')
    expect(listed.map((tool) => tool.name)).toEqual(['my_server_first_tool', 'my_server_second-tool'])
    expect(fixture.calls.lists).toEqual([undefined, 'two'])
    const searched = await fixture.manager.search('beta')
    expect(searched[0]?.name).toBe('my_server_second-tool')
    const described = await fixture.manager.describe('my_server_first_tool')
    expect(described.remoteName).toBe('first.tool')
    expect(described.annotations).toEqual({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
      title: 'First',
    })
    expect(listed[1]?.annotations).toEqual({ destructiveHint: true, readOnlyHint: false })

    const result = await fixture.manager.call('second-tool', { value: true }, { server: 'my server' })
    expect(fixture.calls.toolCalls).toEqual([{ arguments: { value: true }, name: 'second-tool' }])
    expect(result.content).toEqual([
      { text: 'hello', type: 'text' },
      { data: 'AA==', mimeType: 'image/png', type: 'image' },
      { text: 'embedded', type: 'text' },
      { text: '{\n  "answer": 42\n}', type: 'text' },
    ])
  })

  test('read-only policy filters annotated tools across discovery, description, and calls', async () => {
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

    const listed = await fixture.manager.list('linear')
    expect(listed.map((tool) => tool.remoteName)).toEqual(['get_issue'])
    const searched = await fixture.manager.search('', { server: 'linear' })
    expect(searched.map((tool) => tool.remoteName)).toEqual(['get_issue'])
    const described = await fixture.manager.describe('get_issue', { server: 'linear' })
    expect(described.annotations).toEqual({ destructiveHint: false, readOnlyHint: true })
    await fixture.manager.call('linear_get_issue', {})

    for (const denied of ['create_issue', 'dangerous_read', 'mystery']) {
      expect(fixture.manager.describe(denied, { server: 'linear' })).rejects.toThrow('read-only policy')
      expect(fixture.manager.call(denied, {}, { server: 'linear' })).rejects.toThrow(`MCP tool "${denied}" on server "linear"`)
    }
    expect(fixture.calls.toolCalls.map((call) => call.name)).toEqual(['get_issue'])
  })

  test('read-only policy allows only the four exact unannotated DBX metadata tools', async () => {
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

    const listed = await fixture.manager.list('dbx')
    expect(listed.map((tool) => tool.remoteName)).toEqual(allowed)
    const searched = await fixture.manager.search('dbx_', { server: 'dbx' })
    expect(searched.map((tool) => tool.remoteName)).toEqual([...allowed].toSorted())
    for (const tool of allowed) {
      const describedTool = await fixture.manager.describe(tool, { server: 'dbx' })
      expect(describedTool.remoteName).toBe(tool)
      await fixture.manager.call(tool, {}, { server: 'dbx' })
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
    expect(await impersonator.manager.list('other')).toEqual([])
    expect(impersonator.manager.call('other_dbx_list_tables', {})).rejects.toThrow('read-only policy')
  })

  test('passes the requested operation and canonical names to policy callbacks', async () => {
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

    await fixture.manager.list('local')
    await fixture.manager.search('echo', { server: 'local' })
    await fixture.manager.describe('echo', { server: 'local' })
    await fixture.manager.call('local_echo', {})

    expect(requests).toEqual(
      ['list', 'search', 'describe', 'call'].map((operation) => ({
        exposedName: 'local_echo',
        operation,
        remoteName: 'echo',
        server: 'local',
      }))
    )
  })

  test('reports sanitized collisions, repeated cursors, invalid regex, and MCP errors', async () => {
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
    try {
      await oversizedError.manager.call('local_echo', {})
      throw new Error('expected oversized MCP error')
    } catch (error) {
      const { message } = asError(error)
      expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
      expect(message).toContain('Full output saved to:')
    }
  })

  test('completes an explicit callback-driven OAuth flow and reconnects', async () => {
    const port = await freePort()
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
        void fetch(`http://localhost:${port}/callback?code=oauth-code&state=${state}`)
      },
    })

    await fixture.manager.authenticate('slack')
    expect(opened).toHaveLength(1)
    expect(fixture.manager.status()[0]?.status).toBe('connected')
    expect(fixture.calls.connects).toEqual(['streamable-http', 'streamable-http'])
  })

  test('keeps shared OAuth alive while another authentication waiter remains', async () => {
    const port = await freePort()
    let authorized = false
    let openedUrl = ''
    let signalBrowserOpened!: () => void
    const browserOpened = new Promise<void>((resolve) => {
      signalBrowserOpened = resolve
    })
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
        signalBrowserOpened()
      },
    })

    const firstController = new AbortController()
    const first = fixture.manager.authenticate('slack', { signal: firstController.signal }).then(
      () => undefined,
      (error: unknown) => error
    )
    await browserOpened
    const second = fixture.manager.authenticate('slack')
    firstController.abort()
    const state = new URL(openedUrl).searchParams.get('state')
    await fetch(`http://localhost:${port}/callback?code=oauth-code&state=${state}`)

    expect(await first).toBeInstanceOf(Error)
    await second
    expect(fixture.manager.status()[0]?.status).toBe('connected')
    expect(fixture.calls.connects).toEqual(['streamable-http', 'streamable-http'])
  })

  test('closes a directly authenticated connection when exposed names collide', async () => {
    const port = await freePort()
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
    await fixture.manager.connect('same.name')
    expect(fixture.manager.authenticate('same_name')).rejects.toThrow('collision')
    expect(fixture.manager.status().find((server) => server.name === 'same_name')?.status).toBe('failed')
    expect(fixture.calls.closes).toBe(1)
  })

  test('uses the real SDK over stdio and terminates the fixture on close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-mcp-manager-test-'))
    const marker = join(directory, 'pid')
    const fixturePath = fileURLToPath(new URL('fixtures/stdio_fixture.ts', import.meta.url))
    const manager = new McpManager(
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

    const tools = await manager.list('fixture')
    expect(tools.map((tool) => tool.name)).toEqual(['fixture_echo_fixture'])
    const result = await manager.call('fixture_echo_fixture', { value: 'hello' })
    expect(result.content[0]).toEqual({ text: 'fixture:hello', type: 'text' })
    const pid = Number(await readFile(marker, 'utf8'))

    await manager.close()
    await Bun.sleep(20)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test('redacts transport and SDK request errors from status and callers', async () => {
    const transport = harness({
      config: { remote: { type: 'http', url: 'https://example.test/mcp' } },
      connect: async () => {
        throw new StreamableHTTPError(500, 'response leaked bearer secret-token')
      },
    })
    expect(transport.manager.connect('remote')).rejects.not.toThrow('secret-token')
    expect(JSON.stringify(transport.manager.status())).not.toContain('secret-token')

    const request = harness({
      call: async () => {
        throw new Error('SDK failure leaked client_secret=secret-token')
      },
    })
    expect(request.manager.call('local_echo', {})).rejects.not.toThrow('secret-token')

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
    expect(keychain.manager.connect('remote')).rejects.toThrow('Ensure Keychain is available and unlocked')
  })

  test('cancelling the sole connection waiter aborts and closes the shared attempt', async () => {
    const fixture = harness({ connect: () => new Promise<void>(() => undefined) })
    const controller = new AbortController()
    const connecting = fixture.manager.connect('local', { signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    expect(connecting).rejects.toThrow()
    await Bun.sleep(0)
    expect(fixture.calls.closes).toBe(1)
  })

  test('close aborts and awaits an in-flight connection', async () => {
    const fixture = harness({ connect: () => new Promise<void>(() => undefined) })
    const connecting = fixture.manager.connect('local')
    await Promise.resolve()
    await fixture.manager.close()
    expect(connecting).rejects.toThrow()
    expect(fixture.calls.closes).toBe(1)
  })

  test('can be owned by an Effect Layer without connecting at construction', async () => {
    const statuses = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* McpManagerService
          return manager.status()
        }).pipe(Effect.provide(mcpManagerLayer({}, { openUrl: async () => undefined })))
      )
    )
    expect(statuses).toEqual([])
  })

  test('close is idempotent and closes connected clients', async () => {
    const fixture = harness()
    await fixture.manager.connect('local')
    await fixture.manager.close()
    await fixture.manager.close()
    expect(fixture.calls.closes).toBe(1)
    expect(fixture.manager.status()).toEqual([{ name: 'local', status: 'disconnected' }])
  })
})
