import { type AgentToolResult } from '@earendil-works/pi-coding-agent'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Context, Effect, Layer } from 'effect'

import { isRecord } from '../shared/records.js'
import { KeychainCredentialError, createKeychainCredentialStore, type CredentialStore } from './keychain.js'
import { KeychainOAuthProvider, createOAuthState, oauthCallbackPort, startOAuthCallback, type OAuthCallback, type OpenUrl } from './oauth.js'
import { boundGatewayOutput, type GatewayContent } from './output.js'
import {
  type McpGatewayPolicy,
  type McpPolicyOperation,
  type McpServerMap,
  type McpServerStatus,
  type McpToolAnnotations,
  type OAuthConfig,
  type ServerConfig,
} from './types.js'

const CONNECT_TIMEOUT_MS = 30_000
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
  inputSchema: Record<string, unknown>
  annotations: McpToolAnnotations
}

interface ClientLike {
  connect: (transport: Transport, options?: { signal?: AbortSignal; timeout?: number }) => Promise<void>
  close: () => Promise<void>
  getInstructions: () => string | undefined
  listTools: (
    params?: { cursor?: string },
    options?: { signal?: AbortSignal; timeout?: number }
  ) => Promise<{
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
  }>
  callTool: (
    params: { name: string; arguments: Record<string, unknown> },
    schema: undefined,
    options?: { signal?: AbortSignal; timeout?: number }
  ) => Promise<unknown>
}

interface ConnectedServer {
  client: ClientLike
  transport: Transport
  tools: ToolMetadata[]
  instructions?: string
}

interface AuthenticationRuntime {
  promise: Promise<void>
  controller: AbortController
  waiters: number
}

interface ServerRuntime {
  name: string
  config: ServerConfig
  status: McpServerStatus
  error?: string
  connection?: ConnectedServer
  connecting?: Promise<ConnectedServer>
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

class PendingAuthorization extends Error {
  readonly client: ClientLike
  readonly transport: Transport & { finishAuth?: (code: string) => Promise<void> }

  constructor(client: ClientLike, transport: Transport & { finishAuth?: (code: string) => Promise<void> }) {
    super('OAuth authorization is required')
    this.client = client
    this.transport = transport
  }
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const safeOperationError = (error: unknown, operation: string, server: string): Error => {
  if (isAbort(error)) {
    const cancelled = new Error(`MCP ${operation} was cancelled`)
    cancelled.name = 'AbortError'
    return cancelled
  }
  if (error instanceof KeychainCredentialError) {
    return new KeychainCredentialError(error.message.slice(0, 500))
  }
  if (isAuthorizationFailure(error)) {
    return new Error(`Authentication is required for MCP server ${JSON.stringify(server)}; run /mcp-auth ${server}.`)
  }
  const message = errorMessage(error)
  if (
    /^(?:MCP tool-name collision|MCP server-name collision|MCP server .* repeated a tools cursor|OAuth callback|Could not start the OAuth callback|The MCP HTTP transport cannot|Invalid MCP search)/.test(
      message
    )
  ) {
    return new Error(message.slice(0, 500))
  }
  return new Error(`MCP ${operation} failed for server ${JSON.stringify(server)}`)
}

const isSafeSearchRegex = (pattern: string): boolean => {
  if (pattern.length === 0 || pattern.length > 128 || /\\[1-9]/.test(pattern)) {
    return false
  }
  // Accept only a fixed-width subset plus one `.*` wildcard. Excluding groups,
  // Alternation, and other repetition keeps evaluation linear in candidate size.
  const remainder = pattern.replaceAll(/\\./g, '').replaceAll(/\[(?:\\.|[^\]\\])*\]/g, '')
  const wildcards = remainder.match(/\.\*/g)?.length ?? 0
  return wildcards <= 1 && !/(?:[+*?{}()|]|\[|\])/.test(remainder.replace('.*', ''))
}

const isAbort = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted || (error instanceof Error && (error.name === 'AbortError' || /cancelled|aborted/i.test(error.message)))

const isAuthorizationFailure = (error: unknown): boolean =>
  error instanceof UnauthorizedError ||
  (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) ||
  (error instanceof Error && /unauthori[sz]ed|mcp-auth|authentication is required/i.test(error.message))

const isOAuthChallenge = (error: unknown): boolean =>
  error instanceof UnauthorizedError || (error instanceof StreamableHTTPError && error.code === 401)

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
  if (config.headers && Object.keys(config.headers).length > 0) {
    return undefined
  }
  return {}
}

const isLegacyTransportCandidate = (error: unknown): boolean =>
  error instanceof StreamableHTTPError &&
  ((error.code !== undefined && [400, 404, 405, 406, 415].includes(error.code)) ||
    (error.code === -1 && /unexpected content type/i.test(error.message)))

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
  if (!value) {
    return {}
  }
  return {
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.readOnlyHint === 'boolean' ? { readOnlyHint: value.readOnlyHint } : {}),
    ...(typeof value.destructiveHint === 'boolean' ? { destructiveHint: value.destructiveHint } : {}),
    ...(typeof value.idempotentHint === 'boolean' ? { idempotentHint: value.idempotentHint } : {}),
    ...(typeof value.openWorldHint === 'boolean' ? { openWorldHint: value.openWorldHint } : {}),
  }
}

const inheritedEnvironment = (configured: Record<string, string> | undefined): Record<string, string> => {
  const inherited: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      inherited[name] = value
    }
  }
  return { ...inherited, ...configured }
}

const combineSignals = (...signals: (AbortSignal | undefined)[]): AbortSignal => {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  const [only] = present
  if (present.length === 0) {
    return new AbortController().signal
  }
  if (present.length === 1 && only) {
    return only
  }
  return AbortSignal.any(present)
}

const waitWithSignal = <Value>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> => {
  if (!signal) {
    return promise
  }
  if (signal.aborted) {
    return Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
  }
  return new Promise<Value>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

const convertContentBlock = (item: unknown): GatewayContent | undefined => {
  if (typeof item !== 'object' || item === null || !('type' in item)) {
    return undefined
  }
  const block = item as Record<string, unknown>
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

const convertToolResult = (result: unknown): { content: GatewayContent[]; isError: boolean } => {
  if (typeof result !== 'object' || result === null) {
    return { content: [{ text: JSON.stringify(result), type: 'text' }], isError: false }
  }
  const value = result as {
    isError?: boolean
    content?: unknown[]
    structuredContent?: Record<string, unknown>
    toolResult?: unknown
  }
  if ('toolResult' in value && value.content === undefined) {
    return {
      content: [{ text: JSON.stringify(value.toolResult, undefined, 2), type: 'text' }],
      isError: false,
    }
  }

  const converted = (value.content ?? []).map((item) => convertContentBlock(item)).filter((block): block is GatewayContent => block !== undefined)
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
  private readonly lifecycle = new AbortController()
  private readonly credentialStore: CredentialStore
  private readonly createClient: (serverName: string) => ClientLike
  private readonly createTransport: NonNullable<McpManagerOptions['createTransport']>
  private readonly connectTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly authentications = new Set<Promise<void>>()
  private readonly authenticationByServer = new Map<string, AuthenticationRuntime>()
  private readonly options: McpManagerOptions
  private closed = false

  constructor(config: McpServerMap, options: McpManagerOptions) {
    this.options = options
    this.credentialStore = options.credentialStore ?? createKeychainCredentialStore()
    this.createClient = options.createClient ?? (() => new Client({ name: 'pi-mcp-gateway', version: '1.0.0' }))
    this.createTransport = options.createTransport ?? this.defaultTransport.bind(this)
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS

    for (const [name, serverConfig] of Object.entries(config)) {
      this.runtimes.set(name, {
        config: serverConfig,
        connectWaiters: 0,
        name,
        status: serverConfig.disabled ? 'disabled' : 'disconnected',
      })
    }
  }

  status(): readonly { name: string; status: McpServerStatus; error?: string }[] {
    return [...this.runtimes.values()].map((runtime) => ({
      name: runtime.name,
      status: runtime.status,
      ...(runtime.error ? { error: runtime.error } : {}),
    }))
  }

  oauthServers(): readonly string[] {
    return [...this.runtimes.values()]
      .filter((runtime) => runtime.status !== 'disabled' && oauthConfigFor(runtime.config) !== undefined)
      .map((runtime) => runtime.name)
      .toSorted((left, right) => left.localeCompare(right))
  }

  async connect(server: string, options: { signal?: AbortSignal } = {}): Promise<ConnectedServer> {
    const runtime = this.runtime(server)
    if (runtime.connection) {
      return runtime.connection
    }
    if (!runtime.connecting) {
      runtime.status = 'connecting'
      runtime.error = undefined
      this.notify()
      runtime.connectingController = new AbortController()
      runtime.connecting = this.establish(runtime, {
        signal: runtime.connectingController.signal,
      })
        .then(async (connection) => {
          runtime.connection = connection
          try {
            this.validateGlobalCollisions()
          } catch (error) {
            runtime.connection = undefined
            await connection.client.close().catch(() => undefined)
            throw error
          }
          runtime.status = 'connected'
          runtime.error = undefined
          this.notify()
          return connection
        })
        .catch((error) => {
          const publicError = safeOperationError(error, 'connection', runtime.name)
          runtime.status = isAuthorizationFailure(error) ? 'needs-auth' : 'failed'
          runtime.error = publicError.message
          this.notify()
          throw publicError
        })
        .finally(() => {
          runtime.connecting = undefined
          runtime.connectingController = undefined
        })
    }
    runtime.connectWaiters += 1
    try {
      return await waitWithSignal(runtime.connecting, options.signal)
    } finally {
      runtime.connectWaiters -= 1
      if (runtime.connectWaiters === 0 && !runtime.connection) {
        runtime.connectingController?.abort()
      }
    }
  }

  async list(server: string, options: { signal?: AbortSignal } = {}): Promise<readonly ToolMetadata[]> {
    const tools = await this.toolsForServer(server, options.signal)
    return tools.filter((tool) => this.isAllowed(tool, 'list')).map((tool) => ({ ...tool, annotations: { ...tool.annotations } }))
  }

  async search(
    query: string,
    options: { server?: string; regex?: boolean; limit?: number; signal?: AbortSignal } = {}
  ): Promise<readonly ToolMetadata[]> {
    const runtimes = options.server ? [this.runtime(options.server)] : [...this.runtimes.values()].filter((runtime) => runtime.status !== 'disabled')
    const settled = await Promise.allSettled(runtimes.map((runtime) => this.toolsForServer(runtime.name, options.signal)))
    const tools = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])).filter((tool) => this.isAllowed(tool, 'search'))
    if (tools.length === 0) {
      const firstFailure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (firstFailure) {
        throw firstFailure.reason
      }
    }

    let matches: ToolMetadata[]
    if (options.regex) {
      if (!isSafeSearchRegex(query)) {
        throw new Error('Invalid MCP search regular expression: use at most 128 characters without lookarounds, backreferences, or quantified groups')
      }
      let expression: RegExp
      try {
        expression = new RegExp(query, 'i')
      } catch (error) {
        throw new Error(`Invalid MCP search regular expression: ${errorMessage(error)}`, { cause: error })
      }
      matches = tools.filter((tool) => expression.test(`${tool.name}\n${(tool.description ?? '').slice(0, 2048)}`))
    } else {
      const needle = query.toLocaleLowerCase()
      matches = tools.filter((tool) => `${tool.name}\n${(tool.description ?? '').slice(0, 2048)}`.toLocaleLowerCase().includes(needle))
    }
    return matches
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .slice(0, options.limit ?? 30)
      .map((tool) => ({ ...tool, annotations: { ...tool.annotations } }))
  }

  async describe(tool: string, options: { server?: string; signal?: AbortSignal } = {}): Promise<ToolMetadata> {
    const metadata = await this.resolveTool(tool, options, 'describe')
    return { ...metadata, annotations: { ...metadata.annotations } }
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    options: { server?: string; signal?: AbortSignal } = {}
  ): Promise<AgentToolResult<unknown>> {
    const metadata = await this.resolveTool(tool, options, 'call')
    const runtime = this.runtime(metadata.server)
    if (!runtime.connection) {
      throw new Error(`MCP server ${JSON.stringify(metadata.server)} is not connected`)
    }
    let result: unknown
    try {
      result = await runtime.connection.client.callTool({ arguments: args, name: metadata.remoteName }, undefined, {
        signal: options.signal,
        timeout: this.requestTimeoutMs,
      })
    } catch (error) {
      throw safeOperationError(error, 'tool call', metadata.server)
    }
    const converted = convertToolResult(result)
    const bounded = await boundGatewayOutput(converted.content)
    if (converted.isError) {
      const errorText = bounded.content
        .filter((block): block is Extract<GatewayContent, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      throw new Error(errorText || 'The MCP tool reported an error')
    }
    return {
      content: bounded.content,
      details: {
        server: metadata.server,
        tool: metadata.name,
        ...bounded.details,
      },
    }
  }

  authenticate(server: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    let authentication = this.authenticationByServer.get(server)
    if (!authentication) {
      const controller = new AbortController()
      const promise = this.authenticateServer(server, { signal: controller.signal })
      authentication = { controller, promise, waiters: 0 }
      this.authentications.add(promise)
      this.authenticationByServer.set(server, authentication)
      void promise
        .finally(() => {
          this.authentications.delete(promise)
          if (this.authenticationByServer.get(server)?.promise === promise) {
            this.authenticationByServer.delete(server)
          }
        })
        .catch(() => undefined)
    }

    authentication.waiters += 1
    return waitWithSignal(authentication.promise, options.signal).finally(() => {
      authentication.waiters -= 1
      if (authentication.waiters === 0 && this.authenticationByServer.has(server)) {
        authentication.controller.abort()
      }
    })
  }

  private async authenticateServer(server: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const runtime = this.runtime(server)
    await this.awaitExistingConnectionAttempt(runtime, options.signal)
    const oauthConfig = oauthConfigFor(runtime.config)
    if (runtime.config.type !== 'http' || !oauthConfig) {
      throw new Error(`MCP server ${JSON.stringify(server)} does not support OAuth`)
    }
    if (runtime.connection) {
      return
    }

    const operation = new AbortController()
    const signal = combineSignals(this.lifecycle.signal, operation.signal, options.signal)
    const state = createOAuthState()
    const callback = await startOAuthCallback({
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
      serverUrl: runtime.config.url,
      signal,
      state,
      store: this.credentialStore,
    })

    runtime.status = 'connecting'
    runtime.error = undefined
    this.notify()
    try {
      await this.runOAuthFlow(runtime, { callback, provider, signal })
    } catch (error) {
      const publicError = safeOperationError(error, 'authentication', runtime.name)
      runtime.status = isAuthorizationFailure(error) ? 'needs-auth' : 'failed'
      runtime.error = publicError.message
      this.notify()
      throw publicError
    } finally {
      operation.abort()
      await callback.close()
    }
  }

  private async awaitExistingConnectionAttempt(runtime: ServerRuntime, signal?: AbortSignal): Promise<void> {
    if (!runtime.connecting) {
      return
    }
    try {
      await waitWithSignal(runtime.connecting, signal)
    } catch (error) {
      if (!isAuthorizationFailure(error) && runtime.status !== 'needs-auth') {
        throw error
      }
    }
  }

  private async attemptOAuthConnect(
    runtime: ServerRuntime,
    provider: OAuthClientProvider,
    signal: AbortSignal
  ): Promise<PendingAuthorization | undefined> {
    try {
      const connected = await this.establish(runtime, { provider, retainAuthorization: true, signal })
      runtime.connection = connected
      try {
        this.validateGlobalCollisions()
      } catch (error) {
        runtime.connection = undefined
        await connected.client.close().catch(() => undefined)
        throw error
      }
      runtime.status = 'connected'
      this.notify()
      return undefined
    } catch (error) {
      if (error instanceof PendingAuthorization) {
        return error
      }
      throw error
    }
  }

  private async runOAuthFlow(
    runtime: ServerRuntime,
    options: { provider: OAuthClientProvider; signal: AbortSignal; callback: OAuthCallback }
  ): Promise<void> {
    const { provider, signal, callback } = options
    const pending = await this.attemptOAuthConnect(runtime, provider, signal)
    if (!pending) {
      return
    }
    try {
      const code = await callback.waitForCode()
      if (!pending.transport.finishAuth) {
        throw new Error('The MCP HTTP transport cannot complete OAuth authorization')
      }
      await pending.transport.finishAuth(code)
    } finally {
      await pending.client.close().catch(() => undefined)
    }
    runtime.status = 'disconnected'
    await this.connect(runtime.name, { signal })
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.lifecycle.abort()
    const pendingConnections = [...this.runtimes.values()]
      .map((runtime) => runtime.connecting)
      .filter((connection): connection is Promise<ConnectedServer> => connection !== undefined)
    await Promise.allSettled([...pendingConnections, ...this.authentications])
    const connections = [...this.runtimes.values()]
      .map((runtime) => runtime.connection)
      .filter((connection): connection is ConnectedServer => connection !== undefined)
    await Promise.allSettled(connections.map((connection) => connection.client.close()))
    for (const runtime of this.runtimes.values()) {
      runtime.connection = undefined
      runtime.connecting = undefined
      runtime.connectingController = undefined
      runtime.connectWaiters = 0
      runtime.error = undefined
      runtime.status = runtime.config.disabled ? 'disabled' : 'disconnected'
    }
    this.notify()
  }

  private runtime(name: string): ServerRuntime {
    if (this.closed) {
      throw new Error('MCP manager is closed')
    }
    const runtime = this.runtimes.get(name)
    if (!runtime) {
      throw new Error(`Unknown MCP server ${JSON.stringify(name)}`)
    }
    if (runtime.status === 'disabled') {
      throw new Error(`MCP server ${JSON.stringify(name)} is disabled`)
    }
    return runtime
  }

  private async resolveTool(
    requested: string,
    options: { server?: string; signal?: AbortSignal },
    operation: 'describe' | 'call'
  ): Promise<ToolMetadata> {
    if (options.server) {
      const tools = await this.toolsForServer(options.server, options.signal)
      const matches = tools.filter((tool) => tool.name === requested || tool.remoteName === requested)
      const [onlyMatch] = matches
      if (matches.length === 1 && onlyMatch) {
        return this.requireAllowed(onlyMatch, operation)
      }
      if (matches.length > 1) {
        throw new Error(`Ambiguous MCP tool ${JSON.stringify(requested)}`)
      }
      throw new Error(`MCP tool ${JSON.stringify(requested)} was not found on ${options.server}`)
    }

    const prefixed = [...this.runtimes.values()]
      .filter((runtime) => runtime.status !== 'disabled')
      .map((runtime) => ({ prefix: `${sanitizeToolPart(runtime.name)}_`, runtime }))
      .filter(({ prefix }) => requested.startsWith(prefix))
      .toSorted((left, right) => right.prefix.length - left.prefix.length)
    const [longestPrefixed] = prefixed
    if (longestPrefixed) {
      const longest = longestPrefixed.prefix.length
      const targets = prefixed.filter(({ prefix }) => prefix.length === longest)
      if (targets.length > 1) {
        throw new Error(`MCP server-name collision while resolving ${JSON.stringify(requested)}`)
      }
      const [target] = targets
      if (!target) {
        throw new Error(`Unknown MCP tool ${JSON.stringify(requested)}`)
      }
      const tools = await this.toolsForServer(target.runtime.name, options.signal)
      const match = tools.find((tool) => tool.name === requested)
      if (match) {
        return this.requireAllowed(match, operation)
      }
      throw new Error(`Unknown MCP tool ${JSON.stringify(requested)}`)
    }

    const runtimes = [...this.runtimes.values()].filter((runtime) => runtime.status !== 'disabled')
    const settled = await Promise.allSettled(runtimes.map((runtime) => this.toolsForServer(runtime.name, options.signal)))
    const all = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    if (all.length === 0) {
      const firstFailure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (firstFailure) {
        throw firstFailure.reason
      }
    }
    const matches = all.filter((tool) => tool.name === requested || tool.remoteName === requested)
    const [onlyMatch] = matches
    if (matches.length === 1 && onlyMatch) {
      return this.requireAllowed(onlyMatch, operation)
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous MCP tool ${JSON.stringify(requested)}; use its exposed server-prefixed name`)
    }
    throw new Error(`Unknown MCP tool ${JSON.stringify(requested)}`)
  }

  private async toolsForServer(server: string, signal?: AbortSignal): Promise<ToolMetadata[]> {
    const connection = await this.connect(server, { signal })
    return connection.tools
  }

  private isAllowed(tool: ToolMetadata, operation: McpPolicyOperation): boolean {
    const { policy } = this.options
    if (!policy) {
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

  private requireAllowed(tool: ToolMetadata, operation: 'describe' | 'call'): ToolMetadata {
    if (this.isAllowed(tool, operation)) {
      return tool
    }
    const policyName = (this.options.policy?.name ?? 'configured').replaceAll(/[\r\n]/g, ' ').slice(0, 80)
    const remoteName = JSON.stringify(tool.remoteName.slice(0, 128))
    const server = JSON.stringify(tool.server.slice(0, 128))
    throw new Error(`MCP tool ${remoteName} on server ${server} is denied by the ${policyName} policy`)
  }

  private async establish(
    runtime: ServerRuntime,
    options: {
      provider?: OAuthClientProvider
      retainAuthorization?: boolean
      signal?: AbortSignal
    } = {}
  ): Promise<ConnectedServer> {
    if (runtime.config.type === undefined) {
      throw new Error('Disabled MCP server has no transport')
    }
    const timeout = AbortSignal.timeout(this.connectTimeoutMs)
    const signal = combineSignals(this.lifecycle.signal, timeout, options.signal)
    const retainAuthorization = options.retainAuthorization ?? false
    const provider = options.provider ?? this.defaultOAuthProvider(runtime)

    if (runtime.config.type === 'stdio') {
      return this.connectTransport(runtime, { kind: 'stdio', provider, retainAuthorization, signal })
    }
    return this.establishHttp(runtime, { provider, retainAuthorization, signal })
  }

  private defaultOAuthProvider(runtime: ServerRuntime): KeychainOAuthProvider | undefined {
    return runtime.config.type === 'http' && runtime.config.oauth ? this.createOAuthProvider(runtime, runtime.config.oauth) : undefined
  }

  private async establishHttp(
    runtime: ServerRuntime,
    attempt: { provider: OAuthClientProvider | undefined; signal: AbortSignal; retainAuthorization: boolean }
  ): Promise<ConnectedServer> {
    const { provider, signal, retainAuthorization } = attempt
    try {
      return await this.connectTransport(runtime, {
        kind: 'streamable-http',
        provider,
        retainAuthorization,
        signal,
      })
    } catch (error) {
      const retriedProvider = this.implicitOAuthProvider(runtime, provider, error)
      if (!retriedProvider) {
        return this.fallbackToSse(runtime, { ...attempt, provider }, error)
      }
      try {
        return await this.connectTransport(runtime, {
          kind: 'streamable-http',
          provider: retriedProvider,
          retainAuthorization,
          signal,
        })
      } catch (retryError) {
        return this.fallbackToSse(runtime, { ...attempt, provider: retriedProvider }, retryError)
      }
    }
  }

  private implicitOAuthProvider(
    runtime: ServerRuntime,
    provider: OAuthClientProvider | undefined,
    failure: unknown
  ): KeychainOAuthProvider | undefined {
    if (runtime.config.type !== 'http') {
      return undefined
    }
    // Keep public/anonymous HTTP servers independent of the credential store.
    // Only attach an implicit OAuth provider after the endpoint returns 401.
    const implicitOAuth = runtime.config.oauth === undefined ? oauthConfigFor(runtime.config) : undefined
    if (provider || !implicitOAuth || !isOAuthChallenge(failure)) {
      return undefined
    }
    return this.createOAuthProvider(runtime, implicitOAuth)
  }

  private fallbackToSse(
    runtime: ServerRuntime,
    attempt: { provider: OAuthClientProvider | undefined; signal: AbortSignal; retainAuthorization: boolean },
    failure: unknown
  ): Promise<ConnectedServer> {
    const { provider, signal, retainAuthorization } = attempt
    if (failure instanceof PendingAuthorization || isAbort(failure, signal) || !isLegacyTransportCandidate(failure)) {
      throw failure
    }
    return this.connectTransport(runtime, { kind: 'sse', provider, retainAuthorization, signal })
  }

  private createOAuthProvider(runtime: ServerRuntime, config: OAuthConfig): KeychainOAuthProvider {
    if (runtime.config.type !== 'http') {
      throw new Error('OAuth requires an HTTP server')
    }
    return new KeychainOAuthProvider({
      config,
      serverName: runtime.name,
      serverUrl: runtime.config.url,
      store: this.credentialStore,
    })
  }

  private async connectTransport(
    runtime: ServerRuntime,
    options: {
      kind: 'stdio' | 'streamable-http' | 'sse'
      provider: OAuthClientProvider | undefined
      signal: AbortSignal
      retainAuthorization: boolean
    }
  ): Promise<ConnectedServer> {
    const { kind, provider, signal, retainAuthorization } = options
    if (runtime.config.type === undefined) {
      throw new Error('Disabled MCP server has no transport')
    }
    const client = this.createClient(runtime.name)
    const transport = this.createTransport(runtime.name, runtime.config, { authProvider: provider, kind })
    try {
      await waitWithSignal(client.connect(transport, { signal, timeout: this.connectTimeoutMs }), signal)
      const tools = await this.loadTools(runtime.name, client, signal)
      return { client, instructions: client.getInstructions(), tools, transport }
    } catch (error) {
      if (retainAuthorization && isAuthorizationFailure(error)) {
        throw new PendingAuthorization(client, transport)
      }
      await client.close().catch(() => undefined)
      throw error
    }
  }

  private async loadTools(server: string, client: ClientLike, signal: AbortSignal): Promise<ToolMetadata[]> {
    const tools: ToolMetadata[] = []
    const names = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      if (cursor) {
        if (cursors.has(cursor)) {
          throw new Error(`MCP server ${server} repeated a tools cursor`)
        }
        cursors.add(cursor)
      }
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        signal,
        timeout: this.requestTimeoutMs,
      })
      for (const tool of page.tools) {
        const name = `${sanitizeToolPart(server)}_${sanitizeToolPart(tool.name)}`
        if (names.has(name)) {
          throw new Error(`MCP tool-name collision on ${server}: ${JSON.stringify(name)}`)
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
  }

  private validateGlobalCollisions(): void {
    const names = new Map<string, string>()
    for (const runtime of this.runtimes.values()) {
      for (const tool of runtime.connection?.tools ?? []) {
        const previous = names.get(tool.name)
        if (previous && previous !== runtime.name) {
          throw new Error(
            `MCP tool-name collision: servers ${JSON.stringify(previous)} and ${JSON.stringify(runtime.name)} both expose ${JSON.stringify(tool.name)}`
          )
        }
        names.set(tool.name, runtime.name)
      }
    }
  }

  private notify(): void {
    this.options.onStatusChange?.(this.status())
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
      throw new Error(`Cannot use ${kind} for a stdio server`)
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
export class McpManagerService extends Context.Service<McpManagerService, McpManager>()('@pi/mcp/Manager') {}

export const mcpManagerLayer = (config: McpServerMap, options: McpManagerOptions): Layer.Layer<McpManagerService> =>
  Layer.effect(McpManagerService)(
    Effect.acquireRelease(
      Effect.sync(() => new McpManager(config, options)),
      (manager) => Effect.tryPromise({ catch: (cause) => cause, try: () => manager.close() }).pipe(Effect.ignore)
    )
  )
