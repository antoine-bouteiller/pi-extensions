import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import { type OAuthClientInformationMixed, type OAuthClientMetadata, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { type Cause, Effect, Semaphore, type Scope } from 'effect'

import { isEmptyString, isNotEmptyString, isNotNullOrUndefined, isNullOrUndefined, isTrue } from '@/shared/utils/predicates.js'

import { type CredentialStore, type OAuthCredentialPayload } from './keychain.js'
import { type OAuthConfig } from './types.js'

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_CALLBACK_PORT = 3334

export type OpenUrl = (url: string, signal?: AbortSignal) => Promise<void>

export interface OAuthCallback {
  redirectUrl: string
  waitForCode: () => Promise<string>
  close: () => Promise<void>
}

export interface OAuthCallbackOptions {
  port: number
  redirectUri?: string
  expectedState: string
  signal?: AbortSignal
  timeoutMs?: number
}

const abortError = (message: string): Error => {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

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

/** Start a one-shot, loopback-only OAuth callback listener. */
export const startOAuthCallback = async (options: OAuthCallbackOptions): Promise<OAuthCallback> => {
  if (isTrue(options.signal?.aborted)) {
    throw abortError('OAuth authentication was cancelled')
  }
  const { url, bindHost } = callbackUrl(options)
  const timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS
  let settled = false
  let closePromise: Promise<void> | undefined
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // Avoid an unhandled rejection when listener startup itself fails.
  void codePromise.catch(() => undefined)

  const finish = (error?: Error, code?: string) => {
    if (settled) {
      return
    }
    settled = true
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    options.signal?.removeEventListener('abort', onAbort)
    if (error !== undefined) {
      rejectCode(error)
      void close()
      return
    }
    if (code !== undefined) {
      resolveCode(code)
      void close()
      return
    }
    rejectCode(new Error('OAuth callback finished without a code or an error'))
    void close()
  }

  const server = createServer((request, response) => {
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

    const state = requested.searchParams.get('state')
    if (state !== options.expectedState) {
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
      finish(new Error(message))
      return
    }

    const code = requested.searchParams.get('code')
    if (isNullOrUndefined(code) || isEmptyString(code)) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>OAuth error</title><p>Missing authorization code.</p>')
      finish(new Error('OAuth callback did not include an authorization code'))
      return
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>OAuth complete</title><p>Authentication succeeded. You can close this window and return to Pi.</p>')
    finish(undefined, code)
  })

  const close = (): Promise<void> => {
    if (closePromise !== undefined) {
      return closePromise
    }
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    options.signal?.removeEventListener('abort', onAbort)
    closePromise = server.listening ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve()
    return closePromise
  }

  const onAbort = () => finish(abortError('OAuth authentication was cancelled'))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => finish(new Error('OAuth callback timed out after five minutes')), timeoutMs)
  timer.unref?.()

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(options.port, bindHost)
    })
  } catch (error) {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    options.signal?.removeEventListener('abort', onAbort)
    await close()
    const reason =
      error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
        ? `OAuth callback port ${options.port} is already in use`
        : 'Could not start the OAuth callback listener'
    throw new Error(reason, { cause: error })
  }

  const address = server.address()
  if (address === null || typeof address === 'string') {
    await close()
    throw new Error('Could not determine the OAuth callback listener address')
  }

  return { close, redirectUrl: url.href, waitForCode: () => codePromise }
}

/** Scoped callback resource used by Effect-native authentication flows. */
export const startOAuthCallbackScoped = (options: OAuthCallbackOptions): Effect.Effect<OAuthCallback, Cause.UnknownError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise(() => startOAuthCallback(options)),
    (callback) => Effect.tryPromise(() => callback.close()).pipe(Effect.ignore)
  )

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

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.update((credential) => ({
      serverUrl: this.options.serverUrl,
      ...credential,
      clientInformation,
    }))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const credential = await this.load()
    return credential?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update((credential) => ({
      serverUrl: this.options.serverUrl,
      ...credential,
      tokens,
    }))
  }

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
        Effect.tryPromise(async () => {
          const next = updater(await this.load())
          await (next === undefined
            ? this.options.store.delete(this.options.serverName, this.options.signal)
            : this.options.store.set(this.options.serverName, next, this.options.signal))
        })
      )
    )
  }
}

export const createOAuthState = (): string => randomBytes(32).toString('base64url')

export const oauthCallbackPort = (config: OAuthConfig): number => config.callbackPort ?? DEFAULT_CALLBACK_PORT
