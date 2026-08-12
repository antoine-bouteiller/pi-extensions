import { randomBytes } from 'node:crypto'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- A loopback *server* for the OAuth redirect; `HttpClient` is a client and cannot receive the callback.
import { createServer, type Server } from 'node:http'

import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import { type OAuthClientInformationMixed, type OAuthClientMetadata, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { Deferred, Effect, Semaphore, type Scope } from 'effect'

import { isEmptyString, isNotEmptyString, isNotNullOrUndefined, isNullOrUndefined, isTrue } from '@/shared/utils/predicates.js'

import { type CredentialStore, type OAuthCredentialPayload } from './keychain.js'
import { McpError, type OAuthConfig } from './types.js'

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_CALLBACK_PORT = 3334

export type OpenUrl = (url: string, signal?: AbortSignal) => Promise<void>

export interface OAuthCallback {
  readonly redirectUrl: string
  readonly waitForCode: Effect.Effect<string, McpError>
  readonly close: Effect.Effect<void>
}

export interface OAuthCallbackOptions {
  port: number
  redirectUri?: string
  expectedState: string
  signal?: AbortSignal
  timeoutMs?: number
}

const abortError = (message: string): McpError => new McpError({ cause: Object.assign(new Error(message), { name: 'AbortError' }), message })

const escaped = (value: string): string =>
  value.replaceAll(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '"': '&quot;',
      '&': '&amp;',
      "'": '&#39;',
      '<': '&lt;',
      '>': '&gt;',
    }
    return entities[character] ?? character
  })

const callbackUrl = (options: OAuthCallbackOptions): { url: URL; bindHost: string } => {
  const url = new URL(options.redirectUri ?? `http://localhost:${options.port}/callback`)
  if (url.protocol !== 'http:') {
    throw new Error('OAuth redirectUri must use http on loopback')
  }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('OAuth redirectUri must use a loopback host')
  }
  if (isNotEmptyString(url.username) || isNotEmptyString(url.password) || isNotEmptyString(url.search) || isNotEmptyString(url.hash)) {
    throw new Error('OAuth redirectUri must not contain credentials, a query, or a fragment')
  }
  const configuredPort = isEmptyString(url.port) ? 80 : Number(url.port)
  if (configuredPort !== options.port) {
    throw new Error('OAuth redirectUri port must match callbackPort')
  }
  return {
    bindHost: url.hostname === '::1' || url.hostname === '[::1]' ? '::1' : '127.0.0.1',
    url,
  }
}

const closeServer = (server: Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void)
      return
    }
    server.close(() => resume(Effect.void))
  })

const listen = (server: Server, port: number, bindHost: string): Effect.Effect<void, McpError> =>
  Effect.callback<void, McpError>((resume) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      const reason =
        'code' in error && error.code === 'EADDRINUSE'
          ? `OAuth callback port ${port} is already in use`
          : 'Could not start the OAuth callback listener'
      resume(Effect.fail(new McpError({ cause: error, message: reason })))
    }
    const onListening = () => {
      server.off('error', onError)
      resume(Effect.void)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, bindHost)
  })

const respondToCallback = (request: { method?: string; url?: string }, response: OAuthResponse, options: CallbackHandlerOptions): void => {
  const { url, expectedState, code } = options
  let requested: URL
  try {
    requested = new URL(request.url ?? '/', url.origin)
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Invalid OAuth callback request')
    return
  }
  if (request.method !== 'GET' || requested.pathname !== url.pathname) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }

  if (requested.searchParams.get('state') !== expectedState) {
    response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>OAuth error</title><p>Invalid OAuth state. Return to Pi and retry.</p>')
    return
  }

  const oauthError = requested.searchParams.get('error')
  if (isNotNullOrUndefined(oauthError) && isNotEmptyString(oauthError)) {
    const description = requested.searchParams.get('error_description')
    const message = `OAuth authorization failed: ${oauthError}${
      isNotNullOrUndefined(description) && isNotEmptyString(description) ? ` (${description})` : ''
    }`
    response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>OAuth error</title><p>${escaped(message)}</p>`)
    Deferred.doneUnsafe(code, Effect.fail(new McpError({ message })))
    return
  }

  const authorizationCode = requested.searchParams.get('code')
  if (isNullOrUndefined(authorizationCode) || isEmptyString(authorizationCode)) {
    response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>OAuth error</title><p>Missing authorization code.</p>')
    Deferred.doneUnsafe(code, Effect.fail(new McpError({ message: 'OAuth callback did not include an authorization code' })))
    return
  }

  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>OAuth complete</title><p>Authentication succeeded. You can close this window and return to Pi.</p>')
  Deferred.doneUnsafe(code, Effect.succeed(authorizationCode))
}

interface OAuthResponse {
  writeHead: (status: number, headers: Record<string, string>) => unknown
  end: (body: string) => unknown
}

interface CallbackHandlerOptions {
  url: URL
  expectedState: string
  code: Deferred.Deferred<string, McpError>
}

/**
 * One-shot, loopback-only OAuth callback listener, scoped so the port is released even when the
 * authorization flow fails: the code arrives on a Node request callback, so it is handed to the
 * waiting fiber through a Deferred.
 */
export const startOAuthCallback = (options: OAuthCallbackOptions): Effect.Effect<OAuthCallback, McpError, Scope.Scope> =>
  Effect.gen(function* () {
    if (isTrue(options.signal?.aborted)) {
      return yield* abortError('OAuth authentication was cancelled')
    }
    const { url, bindHost } = yield* Effect.try({
      catch: (cause) => new McpError({ cause, message: cause instanceof Error ? cause.message : String(cause) }),
      try: () => callbackUrl(options),
    })
    const code = yield* Deferred.make<string, McpError>()
    const server = createServer((request, response) => {
      respondToCallback(request, response, { code, expectedState: options.expectedState, url })
    })

    yield* Effect.acquireRelease(listen(server, options.port, bindHost), () => closeServer(server))

    const address = server.address()
    if (address === null || typeof address === 'string') {
      return yield* new McpError({ message: 'Could not determine the OAuth callback listener address' })
    }

    const { signal } = options
    if (signal !== undefined) {
      const onAbort = () => {
        Deferred.doneUnsafe(code, Effect.fail(abortError('OAuth authentication was cancelled')))
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => signal.addEventListener('abort', onAbort, { once: true })),
        () => Effect.sync(() => signal.removeEventListener('abort', onAbort))
      )
    }

    yield* Effect.forkScoped(
      Effect.sleep(options.timeoutMs ?? CALLBACK_TIMEOUT_MS).pipe(
        Effect.andThen(Deferred.fail(code, new McpError({ message: 'OAuth callback timed out after five minutes' })))
      )
    )

    return { close: closeServer(server), redirectUrl: url.href, waitForCode: Deferred.await(code) }
  })

export interface KeychainOAuthProviderOptions {
  serverName: string
  serverUrl: string
  config: OAuthConfig
  store: CredentialStore
  interactive?: boolean
  state?: string
  openUrl?: OpenUrl
  signal?: AbortSignal
}

/** MCP SDK OAuth provider that persists only reusable tokens/registration data. */
export class KeychainOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string
  readonly clientMetadata: OAuthClientMetadata
  private verifier?: string
  private discovery?: OAuthDiscoveryState
  private readonly mutation = Semaphore.makeUnsafe(1)
  private readonly options: KeychainOAuthProviderOptions

  constructor(options: KeychainOAuthProviderOptions) {
    this.options = options
    const port = options.config.callbackPort ?? DEFAULT_CALLBACK_PORT
    const { url } = callbackUrl({
      expectedState: options.state ?? 'unused',
      port,
      redirectUri: options.config.redirectUri,
    })
    this.redirectUrl = url.href
    this.clientMetadata = {
      client_name: options.config.clientName ?? 'Pi MCP Gateway',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [this.redirectUrl],
      response_types: ['code'],
      token_endpoint_auth_method:
        isNotNullOrUndefined(options.config.clientSecret) && isNotEmptyString(options.config.clientSecret) ? 'client_secret_post' : 'none',
      ...(isNotNullOrUndefined(options.config.scope) && isNotEmptyString(options.config.scope) ? { scope: options.config.scope } : {}),
    }
  }

  state(): string {
    if (!isTrue(this.options.interactive) || isNullOrUndefined(this.options.state) || isEmptyString(this.options.state)) {
      throw new UnauthorizedError('OAuth authorization requires /mcp-auth <server>')
    }
    return this.options.state
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Implements the MCP SDK's `OAuthClientProvider`, which declares promise-returning members.
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (isNotNullOrUndefined(this.options.config.clientId) && isNotEmptyString(this.options.config.clientId)) {
      return {
        client_id: this.options.config.clientId,
        ...(isNotNullOrUndefined(this.options.config.clientSecret) && isNotEmptyString(this.options.config.clientSecret)
          ? { client_secret: this.options.config.clientSecret }
          : {}),
      }
    }
    const credential = await this.load()
    return credential?.clientInformation
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Implements the MCP SDK's `OAuthClientProvider`, which declares promise-returning members.
  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.update((credential) => ({
      serverUrl: this.options.serverUrl,
      ...credential,
      clientInformation,
    }))
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Implements the MCP SDK's `OAuthClientProvider`, which declares promise-returning members.
  async tokens(): Promise<OAuthTokens | undefined> {
    const credential = await this.load()
    return credential?.tokens
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Implements the MCP SDK's `OAuthClientProvider`, which declares promise-returning members.
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update((credential) => ({
      serverUrl: this.options.serverUrl,
      ...credential,
      tokens,
    }))
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Implements the MCP SDK's `OAuthClientProvider`, which declares promise-returning members.
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!isTrue(this.options.interactive) || isNullOrUndefined(this.options.openUrl)) {
      throw new UnauthorizedError('OAuth authorization is required; use /mcp-auth <server>')
    }
    await this.options.openUrl(authorizationUrl.href, this.options.signal)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    if (isNullOrUndefined(this.verifier) || isEmptyString(this.verifier)) {
      throw new Error('OAuth PKCE verifier is unavailable; restart authentication')
    }
    return this.verifier
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Implements the MCP SDK's `OAuthClientProvider`, which declares promise-returning members.
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') {
      this.verifier = undefined
      return
    }
    if (scope === 'discovery') {
      this.discovery = undefined
      return
    }
    if (scope === 'all') {
      this.verifier = undefined
      this.discovery = undefined
      await this.options.store.delete(this.options.serverName, this.options.signal)
      return
    }
    await this.update((credential) => {
      const next = { ...credential, serverUrl: this.options.serverUrl }
      if (scope === 'client') {
        delete next.clientInformation
      }
      if (scope === 'tokens') {
        delete next.tokens
      }
      return next.tokens !== undefined || next.clientInformation !== undefined ? next : undefined
    })
  }

  private load(): Promise<OAuthCredentialPayload | undefined> {
    return this.options.store.get(this.options.serverName, this.options.serverUrl, this.options.signal)
  }

  private update(updater: (current: OAuthCredentialPayload | undefined) => OAuthCredentialPayload | undefined): Promise<void> {
    return Effect.runPromise(
      this.mutation.withPermits(1)(
        Effect.gen({ self: this }, function* () {
          const current = yield* Effect.tryPromise(() => this.load())
          const next = updater(current)
          yield* Effect.tryPromise(() =>
            next === undefined
              ? this.options.store.delete(this.options.serverName, this.options.signal)
              : this.options.store.set(this.options.serverName, next, this.options.signal)
          )
        })
      )
    )
  }
}

export const createOAuthState = (): string => randomBytes(32).toString('base64url')

export const oauthCallbackPort = (config: OAuthConfig): number => config.callbackPort ?? DEFAULT_CALLBACK_PORT
