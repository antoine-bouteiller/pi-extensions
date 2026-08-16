import { type AgentToolResult } from '@earendil-works/pi-coding-agent'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Context, Data, Deferred, Effect, Fiber, Layer, Result, Schema } from 'effect'

import { type JsonObject } from '@/shared/utils/json.js'
import { isEmptyString, isNotEmptyString, isNotNullOrUndefined, isTrue } from '@/shared/utils/predicates.js'
import { isRecord } from '@/shared/utils/records.js'

import { KeychainCredentialError, createKeychainCredentialStore, type CredentialStore } from './keychain.js'
import { KeychainOAuthProvider, createOAuthState, oauthCallbackPort, startOAuthCallback, type OAuthCallback, type OpenUrl } from './oauth.js'
import { boundGatewayOutput, type GatewayContent } from './output.js'
import {
  McpError,
  type McpGatewayPolicy,
  type McpPolicyOperation,
  type McpServerMap,
  type McpServerStatus,
  type McpToolAnnotations,
  type OAuthConfig,
  type ServerConfig,
} from './types.js'

const CONNECT_TIMEOUT_MS = 30_000
/** Caps the `tools/list` fan-out so a large configuration cannot open every server at once. */
const DISCOVERY_CONCURRENCY = 8
const MAX_TOOL_DISCOVERY_MS = 120_000
const MAX_TOOL_PAGES = 100
const MAX_TOOLS_PER_SERVER = 2000
const REQUEST_TIMEOUT_MS = 60_000

interface TransportOptions {
  kind: 'stdio' | 'streamable-http' | 'sse'
  authProvider?: OAuthClientProvider
}

interface ToolMetadata {
  name: string
  server: string
  remoteName: string
  description?: string
  inputSchema: JsonObject
  annotations: McpToolAnnotations
}

interface ClientTool {
  name: string
  description?: string
  inputSchema: JsonObject
  annotations?: {
    title?: unknown
    readOnlyHint?: unknown
    destructiveHint?: unknown
    idempotentHint?: unknown
    openWorldHint?: unknown
  }
}

interface ClientLike {
  connect: (transport: Transport, options?: { signal?: AbortSignal; timeout?: number }) => Promise<void>
  close: () => Promise<void>
  getInstructions: () => string | undefined
  listTools: (
    params?: { cursor?: string },
    options?: { signal?: AbortSignal; timeout?: number }
  ) => Promise<{ tools: ClientTool[]; nextCursor?: string }>
  callTool: (
    params: { name: string; arguments: JsonObject },
    schema: undefined,
    options?: { signal?: AbortSignal; timeout?: number }
  ) => Promise<unknown>
}

interface ServerStatus {
  name: string
  status: McpServerStatus
  error?: string
}

interface ConnectedServer {
  client: ClientLike
  transport: Transport
  tools: ToolMetadata[]
  instructions?: string
}

interface AuthenticationRuntime {
  fiber?: Fiber.Fiber<void, McpFailure>
  controller: AbortController
  waiters: number
}

interface ServerRuntime {
  name: string
  config: ServerConfig
  status: McpServerStatus
  error?: string
  connection?: ConnectedServer
  connecting?: Fiber.Fiber<ConnectedServer, McpFailure>
  connectingController?: AbortController
  connectWaiters: number
}

export interface McpManagerOptions {
  onStatusChange?: (statuses: readonly { name: string; status: McpServerStatus; error?: string }[]) => void
  openUrl: OpenUrl
  credentialStore?: CredentialStore
  createClient?: (serverName: string) => ClientLike
  createTransport?: (serverName: string, config: Exclude<ServerConfig, { type?: undefined }>, options: TransportOptions) => Transport
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  policy?: McpGatewayPolicy
}

class PendingAuthorization extends Data.TaggedError('PendingAuthorization')<{
  readonly client: ClientLike
  readonly transport: Transport & { finishAuth?: (code: string) => Promise<void> }
}> {}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

type McpFailure = McpError | KeychainCredentialError | PendingAuthorization

const asError = (cause: unknown): McpError => (cause instanceof McpError ? cause : new McpError({ cause, message: errorMessage(cause) }))

/** The SDK error a failure was built from, so transport and authorization predicates keep working. */
const underlying = (error: unknown): unknown => (error instanceof McpError && error.cause !== undefined ? error.cause : error)

const quoted = (value: string): string => JSON.stringify(value)

const safeOperationError = (error: unknown, operation: string, server: string): McpError | KeychainCredentialError => {
  if (isAbort(error)) {
    const cancelled = new McpError({ message: `MCP ${operation} was cancelled` })
    cancelled.name = 'AbortError'
    return cancelled
  }
  const raw = underlying(error)
  if (Schema.is(KeychainCredentialError)(raw)) {
    return KeychainCredentialError.make({ message: raw.message.slice(0, 500) })
  }
  if (isAuthorizationFailure(error)) {
    return new McpError({ message: `Authentication is required for MCP server ${quoted(server)}; run /mcp-auth ${server}.` })
  }
  const message = errorMessage(raw)
  if (
    /^(?:MCP tool-name collision|MCP server-name collision|MCP server .* repeated a tools cursor|OAuth callback|Could not start the OAuth callback|The MCP HTTP transport cannot|Invalid MCP search)/.test(
      message
    )
  ) {
    return new McpError({ message: message.slice(0, 500) })
  }
  return new McpError({ message: `MCP ${operation} failed for server ${quoted(server)}` })
}

const isSafeSearchRegex = (pattern: string): boolean => {
  if (isEmptyString(pattern) || pattern.length > 128 || /\\[1-9]/.test(pattern)) {
    return false
  }
  // Accept only a fixed-width subset plus one `.*` wildcard. Excluding groups,
  // Alternation, and other repetition keeps evaluation linear in candidate size.
  const remainder = pattern.replaceAll(/\\./g, '').replaceAll(/\[(?:\\.|[^\]\\])*\]/g, '')
  const wildcards = remainder.match(/\.\*/g)?.length ?? 0
  return wildcards <= 1 && !/(?:[+*?{}()|]|\[|\])/.test(remainder.replace('.*', ''))
}

const isAbort = (error: unknown, signal?: AbortSignal): boolean => {
  const raw = underlying(error)
  return signal?.aborted || (raw instanceof Error && (raw.name === 'AbortError' || /cancelled|aborted/i.test(raw.message)))
}

const isAuthorizationFailure = (error: unknown): boolean => {
  const raw = underlying(error)
  return (
    raw instanceof UnauthorizedError ||
    (raw instanceof StreamableHTTPError && (raw.code === 401 || raw.code === 403)) ||
    (raw instanceof Error && /unauthori[sz]ed|mcp-auth|authentication is required/i.test(raw.message))
  )
}

const isOAuthChallenge = (error: unknown): boolean => {
  const raw = underlying(error)
  return raw instanceof UnauthorizedError || (raw instanceof StreamableHTTPError && raw.code === 401)
}

/**
 * URL-only HTTP servers may advertise OAuth through their 401 challenge. Custom
 * headers opt out of implicit discovery, while an explicit oauth block always wins.
 */
const oauthConfigFor = (config: ServerConfig): OAuthConfig | undefined => {
  if (config.type !== 'http') {
    return undefined
  }
  if (config.oauth !== undefined) {
    return config.oauth
  }
  if (config.headers !== undefined && Object.keys(config.headers).length > 0) {
    return undefined
  }
  return {}
}

const initialStatus = (config: ServerConfig): McpServerStatus => {
  if ('invalid' in config) {
    return 'invalid-config'
  }
  return isTrue(config.disabled) ? 'disabled' : 'disconnected'
}

const isUsableRuntime = (runtime: ServerRuntime): boolean => runtime.status !== 'disabled' && runtime.status !== 'invalid-config'

const isLegacyTransportCandidate = (error: unknown): boolean => {
  const raw = underlying(error)
  return (
    raw instanceof StreamableHTTPError &&
    ((raw.code !== undefined && [400, 404, 405, 406, 415].includes(raw.code)) || (raw.code === -1 && /unexpected content type/i.test(raw.message)))
  )
}

const sanitizeToolPart = (value: string): string => {
  const sanitized = value.replaceAll(/[^A-Za-z0-9_-]/g, '_')
  return sanitized || '_'
}

const normalizeAnnotations = (
  value:
    | {
        title?: unknown
        readOnlyHint?: unknown
        destructiveHint?: unknown
        idempotentHint?: unknown
        openWorldHint?: unknown
      }
    | undefined
): McpToolAnnotations => {
  if (value === undefined) {
    return {}
  }
  const annotations: McpToolAnnotations = {}
  if (typeof value.title === 'string') {
    annotations.title = value.title
  }
  if (typeof value.readOnlyHint === 'boolean') {
    annotations.readOnlyHint = value.readOnlyHint
  }
  if (typeof value.destructiveHint === 'boolean') {
    annotations.destructiveHint = value.destructiveHint
  }
  if (typeof value.idempotentHint === 'boolean') {
    annotations.idempotentHint = value.idempotentHint
  }
  if (typeof value.openWorldHint === 'boolean') {
    annotations.openWorldHint = value.openWorldHint
  }
  return annotations
}

type Environment = Record<string, string>

const inheritedEnvironment = (configured: Environment | undefined) => {
  const inherited: Environment = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      inherited[name] = value
    }
  }
  return { ...inherited, ...configured }
}

const makeAbortController = (): AbortController => new AbortController()

const combineSignals = (...signals: (AbortSignal | undefined)[]): AbortSignal => {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  const [only] = present
  if (present.length === 0) {
    return makeAbortController().signal
  }
  if (present.length === 1 && only !== undefined) {
    return only
  }
  return AbortSignal.any(present)
}

const abortFailure = (signal: AbortSignal): Effect.Effect<never, McpFailure> =>
  Effect.callback<never, McpFailure>((resume) => {
    const abort = () =>
      resume(Effect.fail(new McpError({ cause: new DOMException('The operation was aborted', 'AbortError'), message: 'The operation was aborted' })))
    if (signal.aborted) {
      abort()
      return Effect.void
    }
    signal.addEventListener('abort', abort, { once: true })
    return Effect.sync(() => signal.removeEventListener('abort', abort))
  })

/**
 * Detaches this caller when its own signal fires. The shared attempt keeps running for the other
 * waiters; only the last waiter to leave aborts it.
 */
const waitWithSignal = <Value>(effect: Effect.Effect<Value, McpFailure>, signal?: AbortSignal): Effect.Effect<Value, McpFailure> =>
  signal === undefined ? effect : Effect.raceFirst(effect, abortFailure(signal))

/**
 * An SDK `close()` that never settles must not hold shutdown open, so it is bounded as well as
 * ignored. Teardown cannot surface a failure, but it can refuse to wait forever for one.
 */
const CLIENT_CLOSE_TIMEOUT_MS = 5000

const closeQuietly = (client: ClientLike): Effect.Effect<void> =>
  Effect.tryPromise(() => client.close()).pipe(Effect.timeoutOrElse({ duration: CLIENT_CLOSE_TIMEOUT_MS, orElse: () => Effect.void }), Effect.ignore)

const convertContentBlock = (item: unknown): GatewayContent | undefined => {
  if (typeof item !== 'object' || item === null || !('type' in item)) {
    return undefined
  }
  if (!isRecord(item)) {
    return undefined
  }
  const block = item
  if (block.type === 'text' && typeof block.text === 'string') {
    return { text: block.text, type: 'text' }
  }
  if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
    return { data: block.data, mimeType: block.mimeType, type: 'image' }
  }
  if (block.type === 'resource' && isRecord(block.resource)) {
    const { resource } = block
    if (typeof resource.text === 'string') {
      return { text: resource.text, type: 'text' }
    }
  }
  return undefined
}

interface ConvertedToolResult {
  content: GatewayContent[]
  isError: boolean
}

const convertToolResult = (result: unknown): ConvertedToolResult => {
  if (typeof result !== 'object' || result === null) {
    return { content: [{ text: JSON.stringify(result), type: 'text' }], isError: false }
  }
  if (!isRecord(result)) {
    return { content: [{ text: JSON.stringify(result), type: 'text' }], isError: false }
  }
  const value = result
  if ('toolResult' in value && value.content === undefined) {
    return {
      content: [{ text: JSON.stringify(value.toolResult, undefined, 2), type: 'text' }],
      isError: false,
    }
  }

  const content = Array.isArray(value.content) ? value.content : []
  const converted = content.map((item) => convertContentBlock(item)).filter((block): block is GatewayContent => block !== undefined)
  if (value.structuredContent !== undefined) {
    converted.push({ text: JSON.stringify(value.structuredContent, undefined, 2), type: 'text' })
  }
  return {
    content: converted.length > 0 ? converted : [{ text: '(MCP tool returned no supported content)', type: 'text' }],
    isError: value.isError === true,
  }
}

export class McpManager {
  private readonly runtimes = new Map<string, ServerRuntime>()
  private readonly lifecycle = makeAbortController()
  private readonly credentialStore: CredentialStore
  private readonly createClient: (serverName: string) => ClientLike
  private readonly createTransport: NonNullable<McpManagerOptions['createTransport']>
  private readonly connectTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly authentications = new Set<AuthenticationRuntime>()
  private readonly authenticationByServer = new Map<string, AuthenticationRuntime>()
  private readonly options: McpManagerOptions
  private closed = false
  private closing: Deferred.Deferred<void> | undefined

  constructor(config: McpServerMap, options: McpManagerOptions) {
    this.options = options
    this.credentialStore = options.credentialStore ?? createKeychainCredentialStore()
    this.createClient =
      options.createClient ??
      (() => {
        const client = new Client({ name: 'pi-mcp-gateway', version: '1.0.0' })
        return {
          callTool: (params, schema, requestOptions) => client.callTool(params, schema, requestOptions),
          close: () => client.close(),
          connect: (transport, connectOptions) => client.connect(transport, connectOptions),
          getInstructions: () => client.getInstructions(),
          listTools: (params, requestOptions) =>
            client.listTools(params, requestOptions).then((page) => {
              const tools: ClientTool[] = []
              for (const tool of page.tools) {
                if (!isRecord(tool.inputSchema)) {
                  return Promise.reject(new McpError({ message: 'MCP server returned a tool with an invalid input schema' }))
                }
                tools.push({ ...tool, inputSchema: tool.inputSchema })
              }
              return page.nextCursor === undefined ? { tools } : { nextCursor: page.nextCursor, tools }
            }),
        }
      })
    this.createTransport = options.createTransport ?? this.defaultTransport.bind(this)
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS

    for (const [name, serverConfig] of Object.entries(config)) {
      this.runtimes.set(name, {
        config: serverConfig,
        connectWaiters: 0,
        name,
        status: initialStatus(serverConfig),
      })
    }
  }

  status(): readonly ServerStatus[] {
    return [...this.runtimes.values()].map((runtime) => {
      const status: ServerStatus = {
        name: runtime.name,
        status: runtime.status,
      }
      if (isNotNullOrUndefined(runtime.error) && isNotEmptyString(runtime.error)) {
        status.error = runtime.error
      }
      return status
    })
  }

  oauthServers(): readonly string[] {
    return [...this.runtimes.values()]
      .filter((runtime) => isUsableRuntime(runtime) && oauthConfigFor(runtime.config) !== undefined)
      .map((runtime) => runtime.name)
      .toSorted((left, right) => left.localeCompare(right))
  }

  connect(server: string, options: { signal?: AbortSignal } = {}): Effect.Effect<ConnectedServer, McpFailure> {
    return Effect.gen({ self: this }, function* () {
      const runtime = yield* this.runtime(server)
      if (runtime.connection !== undefined) {
        return runtime.connection
      }
      let attempt = runtime.connecting
      if (attempt === undefined) {
        runtime.status = 'connecting'
        runtime.error = undefined
        this.notify()
        const controller = makeAbortController()
        runtime.connectingController = controller
        attempt = yield* Effect.forkDetach(this.attemptConnection(runtime, controller), { startImmediately: true })
        if (runtime.connectingController === controller) {
          runtime.connecting = attempt
        }
      }
      runtime.connectWaiters += 1
      return yield* waitWithSignal(Fiber.join(attempt), options.signal).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            runtime.connectWaiters -= 1
            if (runtime.connectWaiters === 0 && runtime.connection === undefined) {
              runtime.connectingController?.abort()
            }
          })
        )
      )
    })
  }

  /** The shared connection attempt: it owns the status transitions and clears itself when it settles. */
  private attemptConnection(runtime: ServerRuntime, controller: AbortController): Effect.Effect<ConnectedServer, McpFailure> {
    return Effect.gen({ self: this }, function* () {
      const connection = yield* this.establish(runtime, { signal: controller.signal })
      // Fail-safe: an establish that settles in the same tick as `teardown`'s snapshot would be published after it, and nothing would close it.
      if (this.closed) {
        yield* closeQuietly(connection.client)
        return yield* new McpError({ message: 'MCP manager is closed' })
      }
      /*
       * A concurrent `authenticateServer` establishes outside this fiber, so whoever publishes
       * second must close its own client instead of overwriting and orphaning the first.
       */
      const published = runtime.connection
      if (published !== undefined) {
        yield* closeQuietly(connection.client)
        return published
      }
      runtime.connection = connection
      const collision = this.globalCollision()
      if (collision !== undefined) {
        runtime.connection = undefined
        yield* closeQuietly(connection.client)
        return yield* collision
      }
      runtime.status = 'connected'
      runtime.error = undefined
      this.notify()
      return connection
    }).pipe(
      Effect.catch((error) => {
        const publicError = safeOperationError(error, 'connection', runtime.name)
        runtime.status = isAuthorizationFailure(error) ? 'needs-auth' : 'failed'
        runtime.error = publicError.message
        this.notify()
        return Effect.fail(publicError)
      }),
      Effect.ensuring(
        Effect.sync(() => {
          if (runtime.connectingController === controller) {
            runtime.connecting = undefined
            runtime.connectingController = undefined
          }
        })
      )
    )
  }

  list(server: string, options: { signal?: AbortSignal } = {}): Effect.Effect<readonly ToolMetadata[], McpFailure> {
    return this.toolsForServer(server, options.signal).pipe(
      Effect.map((tools) => tools.filter((tool) => this.isAllowed(tool, 'list')).map((tool) => ({ ...tool, annotations: { ...tool.annotations } })))
    )
  }

  search(
    query: string,
    options: { server?: string; regex?: boolean; limit?: number; signal?: AbortSignal } = {}
  ): Effect.Effect<readonly ToolMetadata[], McpFailure> {
    return Effect.gen({ self: this }, function* () {
      const runtimes =
        isNotNullOrUndefined(options.server) && isNotEmptyString(options.server)
          ? [yield* this.runtime(options.server)]
          : [...this.runtimes.values()].filter(isUsableRuntime)
      const settled = yield* Effect.forEach(runtimes, (runtime) => Effect.result(this.toolsForServer(runtime.name, options.signal)), {
        concurrency: DISCOVERY_CONCURRENCY,
      })
      const tools = settled.flatMap((result) => (Result.isSuccess(result) ? result.success : [])).filter((tool) => this.isAllowed(tool, 'search'))
      if (tools.length === 0) {
        const firstFailure = settled.find(Result.isFailure)
        if (firstFailure !== undefined) {
          return yield* firstFailure.failure
        }
      }

      let matches: ToolMetadata[]
      if (isTrue(options.regex)) {
        if (!isSafeSearchRegex(query)) {
          return yield* new McpError({
            message: 'Invalid MCP search regular expression: use at most 128 characters without lookarounds, backreferences, or quantified groups',
          })
        }
        const expression = yield* Effect.try({
          catch: (cause) => new McpError({ cause, message: `Invalid MCP search regular expression: ${errorMessage(cause)}` }),
          try: () => new RegExp(query, 'i'),
        })
        matches = tools.filter((tool) => expression.test(`${tool.name}\n${(tool.description ?? '').slice(0, 2048)}`))
      } else {
        const needle = query.toLocaleLowerCase()
        matches = tools.filter((tool) => `${tool.name}\n${(tool.description ?? '').slice(0, 2048)}`.toLocaleLowerCase().includes(needle))
      }
      return matches
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .slice(0, options.limit ?? 30)
        .map((tool) => ({ ...tool, annotations: { ...tool.annotations } }))
    })
  }

  describe(tool: string, options: { server?: string; signal?: AbortSignal } = {}): Effect.Effect<ToolMetadata, McpFailure> {
    return this.resolveTool(tool, options, 'describe').pipe(Effect.map((metadata) => ({ ...metadata, annotations: { ...metadata.annotations } })))
  }

  call(tool: string, args: JsonObject, options: { server?: string; signal?: AbortSignal } = {}): Effect.Effect<AgentToolResult<unknown>, McpFailure> {
    return Effect.gen({ self: this }, function* () {
      const metadata = yield* this.resolveTool(tool, options, 'call')
      const runtime = yield* this.runtime(metadata.server)
      const { connection } = runtime
      if (connection === undefined) {
        return yield* new McpError({ message: `MCP server ${quoted(metadata.server)} is not connected` })
      }
      const result = yield* Effect.tryPromise({
        catch: (cause) => safeOperationError(cause, 'tool call', metadata.server),
        try: () =>
          connection.client.callTool({ arguments: args, name: metadata.remoteName }, undefined, {
            signal: options.signal,
            timeout: this.requestTimeoutMs,
          }),
      })
      const converted = convertToolResult(result)
      const bounded = yield* boundGatewayOutput(converted.content)
      if (converted.isError) {
        const errorText = bounded.content
          .filter((block): block is Extract<GatewayContent, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim()
        return yield* new McpError({ message: errorText || 'The MCP tool reported an error' })
      }
      return {
        content: bounded.content,
        details: {
          server: metadata.server,
          tool: metadata.name,
          ...bounded.details,
        },
      }
    })
  }

  authenticate(server: string, options: { signal?: AbortSignal } = {}): Effect.Effect<void, McpFailure> {
    return Effect.gen({ self: this }, function* () {
      const existing = this.authenticationByServer.get(server)
      let authentication = existing
      let fiber = existing?.fiber
      if (authentication === undefined || fiber === undefined) {
        const controller = makeAbortController()
        const record: AuthenticationRuntime = { controller, waiters: 0 }
        this.authentications.add(record)
        this.authenticationByServer.set(server, record)
        fiber = yield* Effect.forkDetach(
          this.authenticateServer(server, { signal: controller.signal }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                this.authentications.delete(record)
                if (this.authenticationByServer.get(server) === record) {
                  this.authenticationByServer.delete(server)
                }
              })
            )
          ),
          { startImmediately: true }
        )
        record.fiber = fiber
        authentication = record
      }

      const claimed = authentication
      claimed.waiters += 1
      return yield* waitWithSignal(Fiber.join(fiber), options.signal).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            claimed.waiters -= 1
            if (claimed.waiters === 0 && this.authenticationByServer.has(server)) {
              claimed.controller.abort()
            }
          })
        )
      )
    })
  }

  private authenticateServer(server: string, options: { signal?: AbortSignal } = {}): Effect.Effect<void, McpFailure> {
    return Effect.gen({ self: this }, function* () {
      const runtime = yield* this.runtime(server)
      yield* this.awaitExistingConnectionAttempt(runtime, options.signal)
      const oauthConfig = oauthConfigFor(runtime.config)
      if (runtime.config.type !== 'http' || oauthConfig === undefined) {
        return yield* new McpError({ message: `MCP server ${quoted(server)} does not support OAuth` })
      }
      if (runtime.connection !== undefined) {
        return undefined
      }

      const operation = makeAbortController()
      const signal = combineSignals(this.lifecycle.signal, operation.signal, options.signal)
      const state = createOAuthState()
      const serverUrl = runtime.config.url

      yield* Effect.scoped(
        Effect.gen({ self: this }, function* () {
          const callback = yield* startOAuthCallback({
            expectedState: state,
            port: oauthCallbackPort(oauthConfig),
            redirectUri: oauthConfig.redirectUri,
            signal,
          })
          const provider = new KeychainOAuthProvider({
            config: oauthConfig,
            interactive: true,
            openUrl: this.options.openUrl,
            serverName: runtime.name,
            serverUrl,
            signal,
            state,
            store: this.credentialStore,
          })

          runtime.status = 'connecting'
          runtime.error = undefined
          this.notify()
          yield* this.runOAuthFlow(runtime, { callback, provider, signal }).pipe(
            Effect.catch((error) => {
              const publicError = safeOperationError(error, 'authentication', runtime.name)
              runtime.status = isAuthorizationFailure(error) ? 'needs-auth' : 'failed'
              runtime.error = publicError.message
              this.notify()
              return Effect.fail(publicError)
            })
          )
        }).pipe(Effect.ensuring(Effect.sync(() => operation.abort())))
      )
      return undefined
    })
  }

  private awaitExistingConnectionAttempt(runtime: ServerRuntime, signal?: AbortSignal): Effect.Effect<void, McpFailure> {
    const attempt = runtime.connecting
    if (attempt === undefined) {
      return Effect.void
    }
    return waitWithSignal(Fiber.join(attempt), signal).pipe(
      Effect.asVoid,
      Effect.catch((error) => (isAuthorizationFailure(error) || runtime.status === 'needs-auth' ? Effect.void : Effect.fail(error)))
    )
  }

  private attemptOAuthConnect(
    runtime: ServerRuntime,
    provider: OAuthClientProvider,
    signal: AbortSignal
  ): Effect.Effect<PendingAuthorization | undefined, McpFailure> {
    return Effect.gen({ self: this }, function* () {
      const connected = yield* this.establish(runtime, { provider, retainAuthorization: true, signal })
      if (runtime.connection !== undefined) {
        yield* closeQuietly(connected.client)
        return undefined
      }
      runtime.connection = connected
      const collision = this.globalCollision()
      if (collision !== undefined) {
        runtime.connection = undefined
        yield* closeQuietly(connected.client)
        return yield* collision
      }
      runtime.status = 'connected'
      // `status()` surfaces any non-empty error regardless of status, so a stale one must be cleared.
      runtime.error = undefined
      this.notify()
      return undefined
    }).pipe(Effect.catch((error) => (error instanceof PendingAuthorization ? Effect.succeed(error) : Effect.fail(error))))
  }

  private runOAuthFlow(
    runtime: ServerRuntime,
    options: { provider: OAuthClientProvider; signal: AbortSignal; callback: OAuthCallback }
  ): Effect.Effect<void, McpFailure> {
    return Effect.gen({ self: this }, function* () {
      const { provider, signal, callback } = options
      const pending = yield* this.attemptOAuthConnect(runtime, provider, signal)
      if (pending === undefined) {
        return undefined
      }
      yield* Effect.gen(function* () {
        /*
         * The loopback listener is one-shot: released as soon as the code arrives so the fixed
         * callback port is free during token exchange and the reconnect below, which may itself
         * need to bind it.
         */
        const code = yield* callback.waitForCode.pipe(Effect.ensuring(callback.close))
        const { finishAuth } = pending.transport
        if (finishAuth === undefined) {
          return yield* new McpError({ message: 'The MCP HTTP transport cannot complete OAuth authorization' })
        }
        return yield* Effect.tryPromise({ catch: asError, try: () => finishAuth.call(pending.transport, code) })
      }).pipe(Effect.ensuring(closeQuietly(pending.client)))
      runtime.status = 'disconnected'
      yield* this.connect(runtime.name, { signal })
      return undefined
    })
  }

  /**
   * Every caller awaits the same run: setting a `closed` flag and returning early let a second
   * caller — or an interrupted first one — leave transports and stdio processes open forever.
   */
  readonly close: Effect.Effect<void> = Effect.suspend(() => {
    const inFlight = this.closing
    if (inFlight !== undefined) {
      return Deferred.await(inFlight)
    }
    const completed = Deferred.makeUnsafe<void>()
    this.closing = completed
    this.closed = true
    this.lifecycle.abort()
    return this.teardown.pipe(Effect.ensuring(Deferred.succeed(completed, undefined)), Effect.uninterruptible)
  })

  private readonly teardown: Effect.Effect<void> = Effect.gen({ self: this }, function* () {
    const pendingConnections = [...this.runtimes.values()]
      .map((runtime) => runtime.connecting)
      .filter((attempt): attempt is Fiber.Fiber<ConnectedServer, McpFailure> => attempt !== undefined)
    const pendingAuthentications = [...this.authentications]
      .map((authentication) => authentication.fiber)
      .filter((attempt): attempt is Fiber.Fiber<void, McpFailure> => attempt !== undefined)
    /*
     * Interrupted, not merely awaited: `lifecycle.abort()` only reaches SDK calls that honour the
     * signal, so an in-flight `listTools` or token exchange would otherwise hold shutdown open for
     * its full request timeout.
     */
    yield* Fiber.interruptAll([...pendingConnections, ...pendingAuthentications])
    const connections = [...this.runtimes.values()]
      .map((runtime) => runtime.connection)
      .filter((connection): connection is ConnectedServer => connection !== undefined)
    yield* Effect.forEach(connections, (connection) => closeQuietly(connection.client), { concurrency: 'unbounded', discard: true })
    for (const runtime of this.runtimes.values()) {
      runtime.connection = undefined
      runtime.connecting = undefined
      runtime.connectingController = undefined
      runtime.connectWaiters = 0
      runtime.error = undefined
      runtime.status = initialStatus(runtime.config)
    }
    this.notify()
  })

  private runtime(name: string): Effect.Effect<ServerRuntime, McpFailure> {
    return Effect.suspend(() => {
      if (this.closed) {
        return Effect.fail(new McpError({ message: 'MCP manager is closed' }))
      }
      const runtime = this.runtimes.get(name)
      if (runtime === undefined) {
        return Effect.fail(new McpError({ message: `Unknown MCP server ${quoted(name)}` }))
      }
      if (runtime.status === 'disabled') {
        return Effect.fail(new McpError({ message: `MCP server ${quoted(name)} is disabled` }))
      }
      if (runtime.status === 'invalid-config') {
        return Effect.fail(new McpError({ message: `MCP server ${quoted(name)} has invalid config` }))
      }
      return Effect.succeed(runtime)
    })
  }

  private resolveTool(
    requested: string,
    options: { server?: string; signal?: AbortSignal },
    operation: 'describe' | 'call'
  ): Effect.Effect<ToolMetadata, McpFailure> {
    return Effect.gen({ self: this }, function* () {
      if (isNotNullOrUndefined(options.server) && isNotEmptyString(options.server)) {
        const tools = yield* this.toolsForServer(options.server, options.signal)
        const matches = tools.filter((tool) => tool.name === requested || tool.remoteName === requested)
        const [onlyMatch] = matches
        if (matches.length === 1 && onlyMatch !== undefined) {
          return yield* this.requireAllowed(onlyMatch, operation)
        }
        if (matches.length > 1) {
          return yield* new McpError({ message: `Ambiguous MCP tool ${quoted(requested)}` })
        }
        return yield* new McpError({ message: `MCP tool ${quoted(requested)} was not found on ${options.server}` })
      }

      const prefixed = [...this.runtimes.values()]
        .filter(isUsableRuntime)
        .map((runtime) => ({ prefix: `${sanitizeToolPart(runtime.name)}_`, runtime }))
        .filter(({ prefix }) => requested.startsWith(prefix))
        .toSorted((left, right) => right.prefix.length - left.prefix.length)
      const [longestPrefixed] = prefixed
      if (longestPrefixed !== undefined) {
        const longest = longestPrefixed.prefix.length
        const targets = prefixed.filter(({ prefix }) => prefix.length === longest)
        if (targets.length > 1) {
          return yield* new McpError({ message: `MCP server-name collision while resolving ${quoted(requested)}` })
        }
        const [target] = targets
        if (target === undefined) {
          return yield* new McpError({ message: `Unknown MCP tool ${quoted(requested)}` })
        }
        const tools = yield* this.toolsForServer(target.runtime.name, options.signal)
        const match = tools.find((tool) => tool.name === requested)
        if (match !== undefined) {
          return yield* this.requireAllowed(match, operation)
        }
        return yield* new McpError({ message: `Unknown MCP tool ${quoted(requested)}` })
      }

      const runtimes = [...this.runtimes.values()].filter(isUsableRuntime)
      const settled = yield* Effect.forEach(runtimes, (runtime) => Effect.result(this.toolsForServer(runtime.name, options.signal)), {
        concurrency: DISCOVERY_CONCURRENCY,
      })
      const all = settled.flatMap((result) => (Result.isSuccess(result) ? result.success : []))
      if (all.length === 0) {
        const firstFailure = settled.find(Result.isFailure)
        if (firstFailure !== undefined) {
          return yield* firstFailure.failure
        }
      }
      const matches = all.filter((tool) => tool.name === requested || tool.remoteName === requested)
      const [onlyMatch] = matches
      if (matches.length === 1 && onlyMatch !== undefined) {
        return yield* this.requireAllowed(onlyMatch, operation)
      }
      if (matches.length > 1) {
        return yield* new McpError({ message: `Ambiguous MCP tool ${quoted(requested)}; use its exposed server-prefixed name` })
      }
      return yield* new McpError({ message: `Unknown MCP tool ${quoted(requested)}` })
    })
  }

  private toolsForServer(server: string, signal?: AbortSignal): Effect.Effect<ToolMetadata[], McpFailure> {
    return this.connect(server, { signal }).pipe(Effect.map((connection) => connection.tools))
  }

  private isAllowed(tool: ToolMetadata, operation: McpPolicyOperation): boolean {
    const { policy } = this.options
    if (policy === undefined) {
      return true
    }
    try {
      return policy.allows({
        annotations: { ...tool.annotations },
        exposedName: tool.name,
        operation,
        remoteName: tool.remoteName,
        server: tool.server,
      })
    } catch {
      return false
    }
  }

  private requireAllowed(tool: ToolMetadata, operation: 'describe' | 'call'): Effect.Effect<ToolMetadata, McpFailure> {
    if (this.isAllowed(tool, operation)) {
      return Effect.succeed(tool)
    }
    const policyName = (this.options.policy?.name ?? 'configured').replaceAll(/[\r\n]/g, ' ').slice(0, 80)
    const remoteName = quoted(tool.remoteName.slice(0, 128))
    const server = quoted(tool.server.slice(0, 128))
    return Effect.fail(new McpError({ message: `MCP tool ${remoteName} on server ${server} is denied by the ${policyName} policy` }))
  }

  private establish(
    runtime: ServerRuntime,
    options: {
      provider?: OAuthClientProvider
      retainAuthorization?: boolean
      signal?: AbortSignal
    } = {}
  ): Effect.Effect<ConnectedServer, McpFailure> {
    return Effect.suspend(() => {
      if (runtime.config.type === undefined) {
        return Effect.fail(new McpError({ message: 'Disabled MCP server has no transport' }))
      }
      const timeout = AbortSignal.timeout(this.connectTimeoutMs)
      const signal = combineSignals(this.lifecycle.signal, timeout, options.signal)
      const retainAuthorization = options.retainAuthorization ?? false
      const provider = options.provider ?? this.defaultOAuthProvider(runtime, signal)

      if (runtime.config.type === 'stdio') {
        return this.connectTransport(runtime, { kind: 'stdio', provider, retainAuthorization, signal })
      }
      return this.establishHttp(runtime, { provider, retainAuthorization, signal })
    })
  }

  private defaultOAuthProvider(runtime: ServerRuntime, signal: AbortSignal): KeychainOAuthProvider | undefined {
    return runtime.config.type === 'http' && runtime.config.oauth !== undefined
      ? this.createOAuthProvider(runtime, runtime.config.oauth, signal)
      : undefined
  }

  private establishHttp(
    runtime: ServerRuntime,
    attempt: { provider: OAuthClientProvider | undefined; signal: AbortSignal; retainAuthorization: boolean }
  ): Effect.Effect<ConnectedServer, McpFailure> {
    const { provider, signal, retainAuthorization } = attempt
    return this.connectTransport(runtime, { kind: 'streamable-http', provider, retainAuthorization, signal }).pipe(
      Effect.catch((error) => {
        const retriedProvider = this.implicitOAuthProvider(runtime, provider, error, signal)
        if (retriedProvider === undefined) {
          return this.fallbackToSse(runtime, { ...attempt, provider }, error)
        }
        return this.connectTransport(runtime, { kind: 'streamable-http', provider: retriedProvider, retainAuthorization, signal }).pipe(
          Effect.catch((retryError) => this.fallbackToSse(runtime, { ...attempt, provider: retriedProvider }, retryError))
        )
      })
    )
  }

  private implicitOAuthProvider(
    runtime: ServerRuntime,
    provider: OAuthClientProvider | undefined,
    failure: unknown,
    signal: AbortSignal
  ): KeychainOAuthProvider | undefined {
    if (runtime.config.type !== 'http') {
      return undefined
    }
    // Keep public/anonymous HTTP servers independent of the credential store.
    // Only attach an implicit OAuth provider after the endpoint returns 401.
    const implicitOAuth = runtime.config.oauth === undefined ? oauthConfigFor(runtime.config) : undefined
    if (provider !== undefined || implicitOAuth === undefined || !isOAuthChallenge(failure)) {
      return undefined
    }
    return this.createOAuthProvider(runtime, implicitOAuth, signal)
  }

  private fallbackToSse(
    runtime: ServerRuntime,
    attempt: { provider: OAuthClientProvider | undefined; signal: AbortSignal; retainAuthorization: boolean },
    failure: McpFailure
  ): Effect.Effect<ConnectedServer, McpFailure> {
    const { provider, signal, retainAuthorization } = attempt
    if (failure instanceof PendingAuthorization || isAbort(failure, signal) || !isLegacyTransportCandidate(failure)) {
      return Effect.fail(failure)
    }
    return this.connectTransport(runtime, { kind: 'sse', provider, retainAuthorization, signal })
  }

  private createOAuthProvider(runtime: ServerRuntime, config: OAuthConfig, signal: AbortSignal): KeychainOAuthProvider {
    if (runtime.config.type !== 'http') {
      throw new Error('OAuth requires an HTTP server')
    }
    return new KeychainOAuthProvider({
      config,
      serverName: runtime.name,
      serverUrl: runtime.config.url,
      signal,
      store: this.credentialStore,
    })
  }

  private connectTransport(
    runtime: ServerRuntime,
    options: {
      kind: 'stdio' | 'streamable-http' | 'sse'
      provider: OAuthClientProvider | undefined
      signal: AbortSignal
      retainAuthorization: boolean
    }
  ): Effect.Effect<ConnectedServer, McpFailure> {
    return Effect.gen({ self: this }, function* () {
      const { kind, provider, signal, retainAuthorization } = options
      const { config } = runtime
      if (config.type === undefined) {
        return yield* new McpError({ message: 'Disabled MCP server has no transport' })
      }
      const client = this.createClient(runtime.name)
      const transport = yield* Effect.try({
        catch: asError,
        try: () => this.createTransport(runtime.name, config, { authProvider: provider, kind }),
      })
      return yield* Effect.gen({ self: this }, function* () {
        yield* waitWithSignal(
          Effect.tryPromise({ catch: asError, try: () => client.connect(transport, { signal, timeout: this.connectTimeoutMs }) }),
          signal
        )
        const tools = yield* this.loadTools(runtime.name, client, signal)
        return { client, instructions: client.getInstructions(), tools, transport }
      }).pipe(
        Effect.catch((error) =>
          retainAuthorization && isAuthorizationFailure(error)
            ? Effect.fail(new PendingAuthorization({ client, transport }))
            : closeQuietly(client).pipe(Effect.andThen(Effect.fail(error)))
        )
      )
    })
  }

  private loadTools(server: string, client: ClientLike, signal: AbortSignal): Effect.Effect<ToolMetadata[], McpFailure> {
    return Effect.gen({ self: this }, function* () {
      const tools: ToolMetadata[] = []
      const names = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      let pages = 0
      const exceededDiscoveryLimit = new McpError({
        message: `MCP server ${server} exceeded the ${MAX_TOOL_PAGES}-page / ${MAX_TOOLS_PER_SERVER}-tool discovery limit`,
      })
      do {
        pages += 1
        if (pages > MAX_TOOL_PAGES || tools.length > MAX_TOOLS_PER_SERVER) {
          return yield* exceededDiscoveryLimit
        }
        if (isNotNullOrUndefined(cursor) && isNotEmptyString(cursor)) {
          if (cursors.has(cursor)) {
            return yield* new McpError({ message: `MCP server ${server} repeated a tools cursor` })
          }
          cursors.add(cursor)
        }
        const request = isNotNullOrUndefined(cursor) && isNotEmptyString(cursor) ? { cursor } : undefined
        const page = yield* Effect.tryPromise({
          catch: asError,
          try: () => client.listTools(request, { signal, timeout: this.requestTimeoutMs }),
        })
        /*
         * Checked against the remaining budget before the page is walked: measuring only between
         * pages lets one oversized page allocate without bound before the next check runs.
         */
        if (page.tools.length > MAX_TOOLS_PER_SERVER - tools.length) {
          return yield* exceededDiscoveryLimit
        }
        for (const tool of page.tools) {
          if (!isRecord(tool.inputSchema)) {
            return yield* new McpError({ message: `MCP server ${quoted(server)} returned a tool with an invalid input schema` })
          }
          const name = `${sanitizeToolPart(server)}_${sanitizeToolPart(tool.name)}`
          if (names.has(name)) {
            return yield* new McpError({ message: `MCP tool-name collision on ${server}: ${quoted(name)}` })
          }
          names.add(name)
          tools.push({
            annotations: normalizeAnnotations(tool.annotations),
            description: tool.description,
            inputSchema: tool.inputSchema,
            name,
            remoteName: tool.name,
            server,
          })
        }
        cursor = page.nextCursor
      } while (cursor)
      return tools
      /*
       * The per-page timeout does not bound the loop, so a server handing out fresh cursors
       * forever needs an overall deadline as well as the page and tool caps above.
       */
    }).pipe(
      Effect.timeoutOrElse({
        duration: MAX_TOOL_DISCOVERY_MS,
        orElse: () => new McpError({ message: `MCP server ${server} did not finish tool discovery within ${MAX_TOOL_DISCOVERY_MS}ms` }),
      })
    )
  }

  private globalCollision(): McpError | undefined {
    const names = new Map<string, string>()
    for (const runtime of this.runtimes.values()) {
      for (const tool of runtime.connection?.tools ?? []) {
        const previous = names.get(tool.name)
        if (previous !== undefined && previous !== runtime.name) {
          return new McpError({
            message: `MCP tool-name collision: servers ${quoted(previous)} and ${quoted(runtime.name)} both expose ${quoted(tool.name)}`,
          })
        }
        names.set(tool.name, runtime.name)
      }
    }
    return undefined
  }

  /**
   * The host-supplied status callback is outside this module's error model: letting it throw
   * would turn a UI failure into a defect that bypasses every typed `McpFailure` recovery and
   * leave connection state half-updated.
   */
  private notify(): void {
    try {
      this.options.onStatusChange?.(this.status())
    } catch {
      // A status listener that fails must not abort a connection or authentication.
    }
  }

  private defaultTransport(
    _serverName: string,
    config: Exclude<ServerConfig, { type?: undefined }>,
    { kind, authProvider }: TransportOptions
  ): Transport {
    if (kind === 'stdio' && config.type === 'stdio') {
      return new StdioClientTransport({
        args: config.args,
        command: config.command,
        cwd: config.cwd,
        env: inheritedEnvironment(config.env),
        stderr: 'ignore',
      })
    }
    if (config.type !== 'http') {
      throw new McpError({ message: `Cannot use ${kind} for a stdio server` })
    }
    const requestInit: RequestInit = { headers: new Headers(config.headers) }
    if (kind === 'streamable-http') {
      return new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider,
        requestInit,
      })
    }
    // oxlint-disable-next-line typescript/no-deprecated -- streamable-http is preferred above; this is the deliberate fallback for servers still speaking SSE.
    return new SSEClientTransport(new URL(config.url), {
      authProvider,
      requestInit,
    })
  }
}

/** Scoped Effect service for callers that own the manager through a Layer. */
export class McpManagerService extends Context.Service<McpManagerService, McpManager>()('pi-extensions/features/mcp/manager/McpManagerService') {}

export const mcpManagerLayer = (config: McpServerMap, options: McpManagerOptions): Layer.Layer<McpManagerService> =>
  Layer.effect(McpManagerService)(
    Effect.acquireRelease(
      Effect.sync(() => new McpManager(config, options)),
      (manager) => manager.close
    )
  )
