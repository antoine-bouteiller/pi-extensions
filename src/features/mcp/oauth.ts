import { randomBytes } from 'node:crypto'

import { BunHttpServer } from '@effect/platform-bun'
import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import { type OAuthClientInformationMixed, type OAuthClientMetadata, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { Cause, Deferred, Effect, Exit, Option, Scope, Semaphore } from 'effect'
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'

import { toPromiseMethod } from '#shared/effect/runtime'
import { isEmptyString, isNotEmptyString, isNotNullOrUndefined, isNullOrUndefined, isTrue } from '#shared/utils/predicates'

import { type CredentialStore, type KeychainCredentialError, type OAuthCredentialPayload } from './keychain.js'
import { assertOpenableAuthorizationUrl, McpError, type OAuthConfig } from './types.js'

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_CALLBACK_PORT = 3334

export type OpenUrl = (url: string) => Effect.Effect<void, McpError>

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
    const entities = new Map([
      ['"', '&quot;'],
      ['&', '&amp;'],
      ["'", '&#39;'],
      ['<', '&lt;'],
      ['>', '&gt;'],
    ])
    return entities.get(character) ?? character
  })

interface CallbackUrl {
  url: URL
  bindHost: string
}

const callbackUrl = (options: OAuthCallbackOptions): CallbackUrl => {
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
  if (isEmptyString(url.port)) {
    url.port = String(options.port)
  } else if (Number(url.port) !== options.port) {
    throw new Error('OAuth redirectUri port must match callbackPort')
  }
  return {
    bindHost: url.hostname === '::1' || url.hostname === '[::1]' ? '::1' : '127.0.0.1',
    url,
  }
}

const listenerError = (port: number, cause: Cause.Cause<unknown>): McpError => {
  const error = Cause.squash(cause)
  const message = String(error)
  return new McpError({
    cause: error,
    message:
      message.includes('EADDRINUSE') || message.toLowerCase().includes('in use')
        ? `OAuth callback port ${port} is already in use`
        : 'Could not start the OAuth callback listener',
  })
}

const respondToCallback = (
  request: Pick<HttpServerRequest.HttpServerRequest, 'method' | 'url'>,
  options: CallbackHandlerOptions
): HttpServerResponse.HttpServerResponse => {
  const { url, expectedState, code } = options
  let requested: URL
  try {
    requested = new URL(request.url ?? '/', url.origin)
  } catch {
    return HttpServerResponse.text('Invalid OAuth callback request', { contentType: 'text/plain; charset=utf-8', status: 400 })
  }
  if (request.method !== 'GET' || requested.origin !== url.origin || requested.pathname !== url.pathname) {
    return HttpServerResponse.text('Not found', { contentType: 'text/plain; charset=utf-8', status: 404 })
  }

  if (requested.searchParams.get('state') !== expectedState) {
    return HttpServerResponse.text('<!doctype html><title>OAuth error</title><p>Invalid OAuth state. Return to Pi and retry.</p>', {
      contentType: 'text/html; charset=utf-8',
      status: 400,
    })
  }

  const oauthError = requested.searchParams.get('error')
  if (isNotNullOrUndefined(oauthError) && isNotEmptyString(oauthError)) {
    const description = requested.searchParams.get('error_description')
    const message = `OAuth authorization failed: ${oauthError}${
      isNotNullOrUndefined(description) && isNotEmptyString(description) ? ` (${description})` : ''
    }`
    Deferred.doneUnsafe(code, Effect.fail(new McpError({ message })))
    return HttpServerResponse.text(`<!doctype html><title>OAuth error</title><p>${escaped(message)}</p>`, {
      contentType: 'text/html; charset=utf-8',
      status: 400,
    })
  }

  const authorizationCode = requested.searchParams.get('code')
  if (isNullOrUndefined(authorizationCode) || isEmptyString(authorizationCode)) {
    Deferred.doneUnsafe(code, Effect.fail(new McpError({ message: 'OAuth callback did not include an authorization code' })))
    return HttpServerResponse.text('<!doctype html><title>OAuth error</title><p>Missing authorization code.</p>', {
      contentType: 'text/html; charset=utf-8',
      status: 400,
    })
  }

  Deferred.doneUnsafe(code, Effect.succeed(authorizationCode))
  return HttpServerResponse.text(
    '<!doctype html><title>OAuth complete</title><p>Authentication succeeded. You can close this window and return to Pi.</p>',
    { contentType: 'text/html; charset=utf-8' }
  )
}

interface CallbackHandlerOptions {
  url: URL
  expectedState: string
  code: Deferred.Deferred<string, McpError>
}

/**
 * One-shot, loopback-only OAuth callback listener, scoped so the port is released even when the
 * authorization flow fails: the code arrives through the Bun server handler and is handed to the
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
    const listenerScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
    const server = yield* BunHttpServer.make({ hostname: bindHost, port: options.port }).pipe(
      Effect.provideService(Scope.Scope, listenerScope),
      Effect.catchCause((cause) => Effect.fail(listenerError(options.port, cause)))
    )
    yield* server
      .serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          /*
           * `connection: close` keeps shutdown prompt: a keep-alive browser socket would hold the
           * listener — and the fixed callback port needed by the reconnect — open until the
           * server's shutdown grace period expires.
           */
          return HttpServerResponse.setHeader(respondToCallback(request, { code, expectedState: options.expectedState, url }), 'connection', 'close')
        })
      )
      .pipe(Effect.provideService(Scope.Scope, listenerScope))

    if (server.address._tag !== 'TcpAddress') {
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

    yield* Effect.forkIn(
      Effect.sleep(options.timeoutMs ?? CALLBACK_TIMEOUT_MS).pipe(
        Effect.andThen(Deferred.fail(code, new McpError({ message: 'OAuth callback timed out after five minutes' })))
      ),
      listenerScope
    )

    return {
      close: Deferred.fail(code, abortError('OAuth authentication was cancelled')).pipe(Effect.andThen(Scope.close(listenerScope, Exit.void))),
      redirectUrl: url.href,
      waitForCode: Deferred.await(code),
    }
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

/**
 * MCP SDK OAuth provider that persists only reusable tokens/registration data.
 *
 * Every member the SDK awaits is an Effect internally; the promise-returning members it declares are
 * assembled in the constructor through the sanctioned `toPromiseMethod` bridge, which also threads
 * this provider's `AbortSignal` so an SDK abort interrupts the pending store operation.
 */
export class KeychainOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string
  readonly clientMetadata: OAuthClientMetadata
  readonly clientInformation: () => Promise<OAuthClientInformationMixed | undefined>
  readonly saveClientInformation: (clientInformation: OAuthClientInformationMixed) => Promise<void>
  readonly tokens: () => Promise<OAuthTokens | undefined>
  readonly saveTokens: (tokens: OAuthTokens) => Promise<void>
  readonly redirectToAuthorization: (authorizationUrl: URL) => Promise<void>
  readonly invalidateCredentials: (scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') => Promise<void>
  private verifier?: string
  private discovery?: OAuthDiscoveryState
  private readonly mutation = Semaphore.makeUnsafe(1)
  private readonly options: KeychainOAuthProviderOptions

  constructor(options: KeychainOAuthProviderOptions) {
    this.options = options
    const bridge = { signal: options.signal }
    this.clientInformation = toPromiseMethod(() => this.clientInformationEffect(), bridge)
    this.saveClientInformation = toPromiseMethod(
      (clientInformation: OAuthClientInformationMixed) => this.saveClientInformationEffect(clientInformation),
      bridge
    )
    this.tokens = toPromiseMethod(() => this.tokensEffect(), bridge)
    this.saveTokens = toPromiseMethod((tokens: OAuthTokens) => this.saveTokensEffect(tokens), bridge)
    this.redirectToAuthorization = toPromiseMethod((authorizationUrl: URL) => this.redirectToAuthorizationEffect(authorizationUrl), bridge)
    this.invalidateCredentials = toPromiseMethod(
      (scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') => this.invalidateCredentialsEffect(scope),
      bridge
    )
    const port = options.config.callbackPort ?? DEFAULT_CALLBACK_PORT
    const { url } = callbackUrl({
      expectedState: options.state ?? 'unused',
      port,
      redirectUri: options.config.redirectUri,
    })
    this.redirectUrl = url.href
    const clientMetadata: OAuthClientMetadata = {
      client_name: options.config.clientName ?? 'Pi MCP Gateway',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [this.redirectUrl],
      response_types: ['code'],
      token_endpoint_auth_method:
        isNotNullOrUndefined(options.config.clientSecret) && isNotEmptyString(options.config.clientSecret) ? 'client_secret_post' : 'none',
    }
    if (isNotNullOrUndefined(options.config.scope) && isNotEmptyString(options.config.scope)) {
      clientMetadata.scope = options.config.scope
    }
    this.clientMetadata = clientMetadata
  }

  state(): string {
    if (!isTrue(this.options.interactive) || isNullOrUndefined(this.options.state) || isEmptyString(this.options.state)) {
      throw new UnauthorizedError('OAuth authorization requires /mcp-auth <server>')
    }
    return this.options.state
  }

  private clientInformationEffect(): Effect.Effect<OAuthClientInformationMixed | undefined, KeychainCredentialError> {
    if (isNotNullOrUndefined(this.options.config.clientId) && isNotEmptyString(this.options.config.clientId)) {
      const clientInformation: OAuthClientInformationMixed = { client_id: this.options.config.clientId }
      if (isNotNullOrUndefined(this.options.config.clientSecret) && isNotEmptyString(this.options.config.clientSecret)) {
        clientInformation.client_secret = this.options.config.clientSecret
      }
      return Effect.succeed(clientInformation)
    }
    return this.load().pipe(Effect.map((credential) => credential?.clientInformation))
  }

  private saveClientInformationEffect(clientInformation: OAuthClientInformationMixed): Effect.Effect<void, KeychainCredentialError> {
    return this.update((credential) => ({
      serverUrl: this.options.serverUrl,
      ...credential,
      clientInformation,
    }))
  }

  private tokensEffect(): Effect.Effect<OAuthTokens | undefined, KeychainCredentialError> {
    return this.load().pipe(Effect.map((credential) => credential?.tokens))
  }

  private saveTokensEffect(tokens: OAuthTokens): Effect.Effect<void, KeychainCredentialError> {
    return this.update((credential) => ({
      serverUrl: this.options.serverUrl,
      ...credential,
      tokens,
    }))
  }

  /** Throws like `state()` rather than failing: the SDK matches `instanceof UnauthorizedError`, which a tagged failure would hide. */
  private redirectToAuthorizationEffect(authorizationUrl: URL): Effect.Effect<void, McpError> {
    return Effect.suspend(() => {
      const { interactive, openUrl } = this.options
      if (!isTrue(interactive) || isNullOrUndefined(openUrl)) {
        throw new UnauthorizedError('OAuth authorization is required; use /mcp-auth <server>')
      }
      return openUrl(assertOpenableAuthorizationUrl(authorizationUrl.href).href)
    })
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

  private invalidateCredentialsEffect(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Effect.Effect<void, KeychainCredentialError> {
    if (scope === 'verifier') {
      this.verifier = undefined
      return Effect.void
    }
    if (scope === 'discovery') {
      this.discovery = undefined
      return Effect.void
    }
    if (scope === 'all') {
      this.verifier = undefined
      this.discovery = undefined
      return this.options.store.delete(this.options.serverName)
    }
    return this.update((credential) => {
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

  private load(): Effect.Effect<OAuthCredentialPayload | undefined, KeychainCredentialError> {
    return this.options.store.get(this.options.serverName, this.options.serverUrl).pipe(Effect.map(Option.getOrUndefined))
  }

  private update(
    updater: (current: OAuthCredentialPayload | undefined) => OAuthCredentialPayload | undefined
  ): Effect.Effect<void, KeychainCredentialError> {
    return this.mutation.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const current = yield* this.load()
        const next = updater(current)
        yield* next === undefined ? this.options.store.delete(this.options.serverName) : this.options.store.set(this.options.serverName, next)
      })
    )
  }
}

export const createOAuthState = (): string => randomBytes(32).toString('base64url')

export const oauthCallbackPort = (config: OAuthConfig): number => config.callbackPort ?? DEFAULT_CALLBACK_PORT
