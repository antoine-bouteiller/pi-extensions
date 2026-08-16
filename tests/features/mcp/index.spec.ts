import { type AgentToolResult } from '@earendil-works/pi-coding-agent'
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { afterEach } from 'vitest'

import {
  McpGateway,
  mcpPolicyFromEnvironment,
  readonlyMcpPolicy,
  unrestrictedMcpPolicy,
  type McpGatewayManager,
  type McpGatewayApi,
  type McpManagerCallbacks,
  type McpOperationOptions,
  type McpSearchOptions,
  type McpToolDescription,
} from '#features/mcp/gateway'
import { register } from '#features/mcp/index'
import { type McpServerMap } from '#features/mcp/types'
import { publishStatus } from '#shared/state/status_bar'
import { type JsonObject, parseJsonText } from '#shared/utils/json'
import { asCommand, asTool } from '#tests/utils/casts'
import { deferred } from '#tests/utils/deferred'
import { promiseFromEffect, describe, expect, it } from '#tests/utils/effect'
import { createFakePi } from '#tests/utils/fake_pi'
import { testRuntime } from '#tests/utils/runtime'

afterEach(() => publishStatus('mcp', undefined))
interface RecordedCall {
  method: string
  values: unknown[]
}

interface ExecuteInput {
  args?: unknown
  connect?: string
  describe?: string
  regex?: boolean
  search?: string
  server?: string
  tool?: string
}

const testConfig: McpServerMap = { alpha: { command: 'noop', type: 'stdio' } }

const createHarness = (overrides: Partial<McpGatewayManager> = {}, gateway: (manager: McpGatewayManager) => Partial<McpGatewayApi> = () => ({})) => {
  const calls: RecordedCall[] = []
  let callbacks: McpManagerCallbacks | undefined
  let loadCount = 0
  const callResult: AgentToolResult<unknown> = {
    content: [{ text: 'called', type: 'text' }],
    details: { from: 'manager' },
  }

  const manager: McpGatewayManager = {
    authenticate: (server: string, options?: McpOperationOptions) =>
      Effect.sync(() => {
        calls.push({ method: 'authenticate', values: [server, options] })
      }),
    call: (tool: string, args: JsonObject, options?: McpOperationOptions) =>
      Effect.sync(() => {
        calls.push({ method: 'call', values: [tool, args, options] })
        return callResult
      }),
    close: Effect.sync(() => {
      calls.push({ method: 'close', values: [] })
    }),
    connect: (server: string, options?: McpOperationOptions) =>
      Effect.sync(() => {
        calls.push({ method: 'connect', values: [server, options] })
      }),
    describe: (tool: string, options?: McpOperationOptions): Effect.Effect<McpToolDescription, Error> =>
      Effect.sync(() => {
        calls.push({ method: 'describe', values: [tool, options] })
        return {
          annotations: { destructiveHint: false, readOnlyHint: true },
          description: 'A useful tool',
          inputSchema: { type: 'object' },
          name: tool,
          server: options?.server ?? 'resolved',
        }
      }),
    list: (server: string, options?: McpOperationOptions) =>
      Effect.sync(() => {
        calls.push({ method: 'list', values: [server, options] })
        return [
          {
            annotations: { destructiveHint: true, readOnlyHint: false },
            description: 'Last',
            name: `${server}_z`,
          },
          {
            annotations: { destructiveHint: false, readOnlyHint: true },
            description: 'First',
            name: `${server}_a`,
          },
        ]
      }),
    oauthServers() {
      calls.push({ method: 'oauthServers', values: [] })
      return ['slack']
    },
    search: (query: string, options?: McpSearchOptions) =>
      Effect.sync(() => {
        calls.push({ method: 'search', values: [query, options] })
        return [
          {
            annotations: { destructiveHint: true, readOnlyHint: false },
            description: 'Last',
            name: 'z_tool',
          },
          {
            annotations: { destructiveHint: false, readOnlyHint: true },
            description: 'First',
            name: 'a_tool',
          },
        ]
      }),
    status() {
      calls.push({ method: 'status', values: [] })
      return [
        { name: 'zeta', status: 'disconnected' },
        { name: 'alpha', status: 'connected' },
      ]
    },
    ...overrides,
  }

  const gatewayLayer = Layer.succeed(McpGateway)({
    configPath: '/test-home/.config/mcp/mcp.json',
    createManager(config, { callbacks: managerCallbacks }) {
      expect(config).toBe(testConfig)
      callbacks = managerCallbacks
      return manager
    },
    loadConfig: Effect.sync(() => {
      loadCount += 1
      return testConfig
    }),
    policy: unrestrictedMcpPolicy,
    ...gateway(manager),
  })
  const fixture = createFakePi()
  register(fixture.pi, testRuntime(Layer.mergeAll(FetchHttpClient.layer, gatewayLayer)))

  const start = (): Promise<void> => promiseFromEffect(Effect.promise(() => fixture.emit('session_start', {}, context())).pipe(Effect.asVoid))

  const execute = (params: ExecuteInput, signal?: AbortSignal): Promise<AgentToolResult<unknown>> => {
    const tool = fixture.state.tools.get('mcp')
    expect(tool).toBeDefined()
    const executeTool = asTool<{
      execute: (id: string, input: ExecuteInput, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>
    }>(tool)
    return promiseFromEffect(Effect.promise(() => executeTool.execute('call-1', params, signal)))
  }

  const invokeCommand = (args = '', commandContext: unknown = context()): Promise<void> => {
    const command = fixture.state.commands.get('mcp-auth')
    expect(command).toBeDefined()
    const authCommand = asCommand<{ handler: (args: string, ctx: unknown) => Promise<void> }>(command)
    return promiseFromEffect(Effect.promise(() => authCommand.handler(args, commandContext)))
  }

  return {
    callResult,
    callbacks: () => callbacks,
    calls,
    execute,
    fixture,
    invokeCommand,
    loadCount: () => loadCount,
    manager,
    start,
  }
}

const context = (statuses?: { key: string; value: JsonObject[string] }[]) => ({
  hasUI: Boolean(statuses),
  ui: {
    setStatus(key: string, value: JsonObject[string]) {
      statuses?.push({ key, value })
    },
    theme: { fg: (_color: string, value: string) => value },
  },
})

const authContext = (notifications: { message: string; level: string }[], selected?: string) => ({
  hasUI: true,
  ui: {
    notify(message: string, level: string) {
      notifications.push({ level, message })
    },
    select: () => promiseFromEffect(Effect.succeed(selected)),
  },
})

const callsFor = (harness: ReturnType<typeof createHarness>, method: string): RecordedCall[] => harness.calls.filter((call) => call.method === method)

const signalOf = (value: unknown): unknown => (typeof value === 'object' && value !== null && 'signal' in value ? value.signal : undefined)

describe('MCP gateway policy selection', () => {
  it.effect('enables read-only policy only for PI_SUBAGENT_READONLY=1', () =>
    Effect.sync(() => {
      expect(mcpPolicyFromEnvironment({ PI_SUBAGENT_READONLY: '1' })).toBe(readonlyMcpPolicy)
      expect(mcpPolicyFromEnvironment({ PI_SUBAGENT_READONLY: '0' })).toBe(unrestrictedMcpPolicy)
      expect(mcpPolicyFromEnvironment({})).toBe(unrestrictedMcpPolicy)
      expect(mcpPolicyFromEnvironment({ PI_SUBAGENT_READONLY: 'true' })).toBe(unrestrictedMcpPolicy)
    })
  )

  it.effect('allows annotated safe reads and exact DBX exceptions only', () =>
    Effect.sync(() => {
      const request = {
        annotations: { destructiveHint: false, readOnlyHint: true },
        exposedName: 'linear_get_issue',
        operation: 'call' as const,
        remoteName: 'get_issue',
        server: 'linear',
      }
      expect(readonlyMcpPolicy.allows(request)).toBe(true)
      expect(
        readonlyMcpPolicy.allows({
          ...request,
          annotations: { destructiveHint: true, readOnlyHint: true },
        })
      ).toBe(false)
      expect(
        readonlyMcpPolicy.allows({
          ...request,
          annotations: {},
          remoteName: 'dbx_list_tables',
          server: 'dbx',
        })
      ).toBe(true)
      expect(
        readonlyMcpPolicy.allows({
          ...request,
          annotations: {},
          exposedName: 'dbx_list_tables',
          remoteName: 'list_tables',
          server: 'dbx',
        })
      ).toBe(false)
      expect(
        readonlyMcpPolicy.allows({
          ...request,
          annotations: {},
          remoteName: 'dbx_execute_sql',
          server: 'dbx',
        })
      ).toBe(false)
      expect(
        readonlyMcpPolicy.allows({
          ...request,
          annotations: { readOnlyHint: false },
          remoteName: 'dbx_list_tables',
          server: 'dbx',
        })
      ).toBe(false)
    })
  )
})

describe('MCP gateway registration and lifecycle', () => {
  it.effect('registers one gateway tool and the MCP auth command immediately', () =>
    Effect.sync(() => {
      const harness = createHarness()

      expect([...harness.fixture.state.tools.keys()]).toEqual(['mcp'])
      expect([...harness.fixture.state.commands.keys()]).toEqual(['mcp-auth'])
      expect(harness.fixture.state.handlers.has('session_start')).toBe(true)
      expect(harness.fixture.state.handlers.has('session_shutdown')).toBe(true)
      expect(harness.loadCount()).toBe(0)
      expect(harness.calls).toEqual([])
    })
  )

  it.effect('session_start publishes every server and eagerly connects disconnected ones', () =>
    Effect.gen(function* () {
      const statuses: { key: string; value: JsonObject[string] }[] = []
      const harness = createHarness()
      yield* Effect.promise(() => harness.fixture.emit('session_start', {}, context(statuses)))

      expect(harness.loadCount()).toBe(1)
      expect(harness.callbacks()).toBeDefined()
      expect(callsFor(harness, 'connect').map((call) => call.values[0])).toEqual(['zeta'])
      expect(statuses).toEqual([{ key: 'mcp', value: 'MCP alpha: connected\nMCP zeta: disconnected' }])
      expect([...harness.fixture.state.tools.keys()]).toEqual(['mcp'])
    })
  )

  it.effect('passes its configured policy into each process-local manager', () =>
    Effect.gen(function* () {
      let receivedPolicy: unknown
      const harness = createHarness({}, (manager) => ({
        createManager: (_config, { policy }) => {
          receivedPolicy = policy
          return manager
        },
        policy: readonlyMcpPolicy,
      }))

      yield* Effect.promise(() => harness.start())
      expect(receivedPolicy).toBe(readonlyMcpPolicy)
    })
  )

  it.effect('manager status callbacks show every server status', () =>
    Effect.gen(function* () {
      const statuses: { key: string; value: JsonObject[string] }[] = []
      const harness = createHarness()
      yield* Effect.promise(() => harness.fixture.emit('session_start', {}, context(statuses)))

      harness.callbacks()?.onStatusChange([
        { name: 'broken', status: 'invalid-config' },
        { name: 'one', status: 'connected' },
        { name: 'two', status: 'needs-auth' },
      ])
      harness.callbacks()?.onStatusChange(0)

      expect(statuses).toEqual([
        { key: 'mcp', value: 'MCP alpha: connected\nMCP zeta: disconnected' },
        { key: 'mcp', value: 'MCP broken: invalid config\nMCP one: connected\nMCP two: auth needed' },
        { key: 'mcp', value: undefined },
      ])
    })
  )

  it.effect('empty input is metadata-only status with sorted servers and config path', () =>
    Effect.gen(function* () {
      const harness = createHarness()
      yield* Effect.promise(() => harness.start())

      const result = yield* Effect.promise(() => harness.execute({}))

      expect(callsFor(harness, 'status')).toHaveLength(2)
      expect(callsFor(harness, 'connect')).toHaveLength(1)
      expect(result.content[0]).toEqual({
        text: expect.stringContaining('MCP config: /test-home/.config/mcp/mcp.json'),
        type: 'text',
      })
      const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
      expect(text.indexOf('alpha: connected')).toBeLessThan(text.indexOf('zeta: disconnected'))
    })
  )

  it.effect('metadata status renders invalid config without an error', () =>
    Effect.gen(function* () {
      const harness = createHarness({
        status: () => [{ name: 'broken', status: 'invalid-config' }],
      })
      yield* Effect.promise(() => harness.start())

      const result = yield* Effect.promise(() => harness.execute({}))

      expect(result.content[0]).toEqual({ text: expect.stringContaining('- broken: invalid config'), type: 'text' })
    })
  )

  it.effect('tool calls accept object args and preserve manager results', () =>
    Effect.gen(function* () {
      const harness = createHarness()
      yield* Effect.promise(() => harness.start())
      const forwardedSignal = AbortSignal.any([])

      const result = yield* Effect.promise(() => harness.execute({ args: { path: 'README.md' }, server: 'fff', tool: 'fff_read' }, forwardedSignal))

      expect(result).toBe(harness.callResult)
      expect(callsFor(harness, 'call')[0]?.values).toEqual(['fff_read', { path: 'README.md' }, { server: 'fff', signal: forwardedSignal }])
      expect(signalOf(callsFor(harness, 'call')[0]?.values[2])).toBe(forwardedSignal)
    })
  )

  it.effect('tool calls parse JSON object args and default omitted args', () =>
    Effect.gen(function* () {
      const harness = createHarness()
      yield* Effect.promise(() => harness.start())

      yield* Effect.promise(() => harness.execute({ args: '{"count":2}', tool: 'one' }))
      yield* Effect.promise(() => harness.execute({ tool: 'two' }))

      expect(callsFor(harness, 'call').map((call) => call.values[1])).toEqual([{ count: 2 }, {}])
    })
  )

  it.effect('connect delegates the requested server and signal', () =>
    Effect.gen(function* () {
      const harness = createHarness()
      yield* Effect.promise(() => harness.start())
      const forwardedSignal = AbortSignal.any([])

      const result = yield* Effect.promise(() => harness.execute({ connect: 'linear' }, forwardedSignal))

      expect(callsFor(harness, 'connect').at(-1)?.values).toEqual(['linear', { signal: forwardedSignal }])
      expect(signalOf(callsFor(harness, 'connect').at(-1)?.values[1])).toBe(forwardedSignal)
      expect(result.content[0]).toEqual({
        text: expect.stringContaining('mcp({ server: "linear" })'),
        type: 'text',
      })
    })
  )

  it.effect('describe delegates resolution scope and renders call syntax', () =>
    Effect.gen(function* () {
      const harness = createHarness()
      yield* Effect.promise(() => harness.start())
      const forwardedSignal = AbortSignal.any([])

      const result = yield* Effect.promise(() => harness.execute({ describe: 'find_issue', server: 'linear' }, forwardedSignal))

      expect(callsFor(harness, 'describe')[0]?.values).toEqual(['find_issue', { server: 'linear', signal: forwardedSignal }])
      expect(signalOf(callsFor(harness, 'describe')[0]?.values[1])).toBe(forwardedSignal)
      expect(result.content[0]).toEqual({
        text: expect.stringContaining('mcp({ tool: "find_issue", args: { ... } })'),
        type: 'text',
      })
      expect(result.content[0]).toEqual({
        text: expect.stringContaining('[read-only, non-destructive]'),
        type: 'text',
      })
      expect(result.details).toEqual(
        expect.objectContaining({
          annotations: { destructiveHint: false, readOnlyHint: true },
        })
      )
    })
  )

  it.effect('search delegates regex, scope, signal, and cap then sorts results', () =>
    Effect.gen(function* () {
      const harness = createHarness()
      yield* Effect.promise(() => harness.start())
      const forwardedSignal = AbortSignal.any([])

      const result = yield* Effect.promise(() => harness.execute({ regex: true, search: 'issue.*', server: 'linear' }, forwardedSignal))

      expect(callsFor(harness, 'search')[0]?.values).toEqual(['issue.*', { limit: 31, regex: true, server: 'linear', signal: forwardedSignal }])
      expect(signalOf(callsFor(harness, 'search')[0]?.values[1])).toBe(forwardedSignal)
      const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
      expect(text.indexOf('a_tool')).toBeLessThan(text.indexOf('z_tool'))
    })
  )

  it.effect('server-only input lists that server and sorts tools', () =>
    Effect.gen(function* () {
      const harness = createHarness()
      yield* Effect.promise(() => harness.start())
      const forwardedSignal = AbortSignal.any([])

      const result = yield* Effect.promise(() => harness.execute({ server: 'fff' }, forwardedSignal))

      expect(callsFor(harness, 'list')[0]?.values).toEqual(['fff', { signal: forwardedSignal }])
      expect(signalOf(callsFor(harness, 'list')[0]?.values[1])).toBe(forwardedSignal)
      const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
      expect(text.indexOf('fff_a')).toBeLessThan(text.indexOf('fff_z'))
    })
  )

  it.effect('mcp-auth authenticates an explicit server and infers the sole OAuth server', () =>
    Effect.gen(function* () {
      const harness = createHarness()
      const notifications: { message: string; level: string }[] = []
      yield* Effect.promise(() => harness.start())

      yield* Effect.promise(() => harness.invokeCommand(' slack ', authContext(notifications)))
      yield* Effect.promise(() => harness.invokeCommand('', authContext(notifications)))

      expect(callsFor(harness, 'authenticate').map((call) => call.values)).toEqual([
        ['slack', undefined],
        ['slack', undefined],
      ])
      expect(notifications).toEqual([
        { level: 'info', message: 'Authenticated and connected MCP server slack.' },
        { level: 'info', message: 'Authenticated and connected MCP server slack.' },
      ])
    })
  )

  it.effect('rejects ambiguous selectors with a tagged failure before delegation', () =>
    Effect.gen(function* () {
      const harness = createHarness()
      yield* Effect.promise(() => harness.start())

      const rejection = yield* Effect.promise(() =>
        harness.execute({ search: 'two', tool: 'one' }).then(
          () => undefined,
          (error: unknown) => error
        )
      )

      expect(rejection).toMatchObject({ _tag: 'ToolFailure', message: expect.stringContaining('Ambiguous mcp request') })
      yield* Effect.promise(() => expect(harness.execute({ connect: 'one', server: 'two' })).rejects.toThrow('connect already names the server'))
      yield* Effect.promise(() => expect(harness.execute({ args: {} })).rejects.toThrow('args can only be used with tool'))
      yield* Effect.promise(() => expect(harness.execute({ regex: true })).rejects.toThrow('regex can only be used with search'))
      expect(callsFor(harness, 'call')).toHaveLength(0)
      expect(callsFor(harness, 'search')).toHaveLength(0)
    })
  )

  it.effect('rejects malformed, scalar, array, and null string args', () =>
    Effect.gen(function* () {
      const harness = createHarness()
      yield* Effect.promise(() => harness.start())

      yield* Effect.promise(() => expect(harness.execute({ args: '{', tool: 'one' })).rejects.toThrow('valid JSON'))
      for (const args of ['null', '[]', '42', '"value"', parseJsonText('null'), [], 42]) {
        yield* Effect.promise(() => expect(harness.execute({ args, tool: 'one' })).rejects.toThrow('must be a JSON object'))
      }
      expect(callsFor(harness, 'call')).toHaveLength(0)
    })
  )

  it.effect('tags manager failures and preserves their cause', () =>
    Effect.gen(function* () {
      const cause = new Error('manager exploded')
      const harness = createHarness({ call: () => Effect.fail(cause) })
      yield* Effect.promise(() => harness.start())

      const rejection = yield* Effect.promise(() =>
        harness.execute({ tool: 'one' }).then(
          () => undefined,
          (error: unknown) => error
        )
      )

      expect(rejection).toMatchObject({ _tag: 'McpOperationError', cause, message: 'manager exploded' })
    })
  )

  it.effect('session_shutdown awaits in-flight initialization cleanup and clears UI', () =>
    Effect.gen(function* () {
      const creation = deferred<McpGatewayManager>()
      const closeStarted = deferred<void>()
      const permitClose = deferred<void>()
      const harness = createHarness(
        {
          close: Effect.gen(function* () {
            closeStarted.resolve()
            yield* Effect.promise(() => permitClose.promise)
          }),
        },
        () => ({ createManager: () => promiseFromEffect(Effect.promise(() => creation.promise)) })
      )
      const { fixture } = harness
      const statuses: { key: string; value: JsonObject[string] }[] = []

      const starting = fixture.emit('session_start', {}, context(statuses))
      yield* Effect.promise(() => Promise.resolve())
      const shuttingDown = fixture.emit('session_shutdown', {}, context(statuses))
      creation.resolve(harness.manager)
      yield* Effect.promise(() => closeStarted.promise)

      let shutdownFinished = false
      void shuttingDown.then(() => {
        shutdownFinished = true
      })
      yield* Effect.promise(() => Promise.resolve())
      expect(shutdownFinished).toBe(false)

      permitClose.resolve()
      yield* Effect.promise(() => Promise.all([starting, shuttingDown]))
      expect(statuses.at(-1)).toEqual({ key: 'mcp', value: undefined })
    })
  )
})
