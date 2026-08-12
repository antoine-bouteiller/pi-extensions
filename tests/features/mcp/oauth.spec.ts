// oxlint-disable-next-line effecttsgo/node-builtin-import -- The spec asserts real loopback listener binding and cleanup; an HTTP client cannot create the server under test.
import { createServer } from 'node:http'

import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asError } from '@tests/utils/casts.js'
import { httpGet } from '@tests/utils/http.js'
import { Effect } from 'effect'

import { type CredentialStore, type OAuthCredentialPayload } from '@/features/mcp/keychain.js'
import { KeychainOAuthProvider, createOAuthState, startOAuthCallback, type OAuthCallback, type OAuthCallbackOptions } from '@/features/mcp/oauth.js'

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

class MemoryStore implements CredentialStore {
  value?: OAuthCredentialPayload
  reads = 0
  async get(_name: string, url: string) {
    this.reads += 1
    return this.value?.serverUrl === url ? structuredClone(this.value) : undefined
  }
  async set(_name: string, value: OAuthCredentialPayload) {
    this.value = structuredClone(value)
  }
  async delete() {
    this.value = undefined
  }
}

/** The listener is a scoped resource: leaving `use` releases the port. */
const withCallback = <Value, Failure, Requirements>(
  options: OAuthCallbackOptions,
  use: (callback: OAuthCallback) => Effect.Effect<Value, Failure, Requirements>
) => Effect.scoped(startOAuthCallback(options).pipe(Effect.flatMap(use)))

describe('OAuth callback', () => {
  it.live('accepts a matching callback and releases the port', () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => freePort())
      yield* withCallback({ expectedState: 'right', port }, (callback) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() => httpGet(`${callback.redirectUrl}?code=code-1&state=right`))
          expect(response.status).toBe(200)
          expect(yield* callback.waitForCode).toBe('code-1')
        })
      )

      yield* withCallback({ expectedState: 'next', port }, () => Effect.void)
    })
  )

  it.live('rejects a wrong state without consuming the legitimate callback', () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => freePort())
      yield* withCallback({ expectedState: 'right', port }, (callback) =>
        Effect.gen(function* () {
          const badResponse = yield* Effect.promise(() => httpGet(`${callback.redirectUrl}?code=bad&state=wrong`))
          expect(badResponse.status).toBe(400)
          const goodResponse = yield* Effect.promise(() => httpGet(`${callback.redirectUrl}?code=good&state=right`))
          expect(goodResponse.status).toBe(200)
          expect(yield* callback.waitForCode).toBe('good')
        })
      )
    })
  )

  it.live('HTML-escapes reflected OAuth errors and releases scoped listeners', () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => freePort())
      yield* withCallback({ expectedState: 'state', port }, (callback) =>
        Effect.gen(function* () {
          const payload = `<script>alert("x")</script>&'`
          const response = yield* Effect.promise(() =>
            httpGet(`${callback.redirectUrl}?error=${encodeURIComponent(payload)}&error_description=${encodeURIComponent(payload)}&state=state`)
          )
          const html = yield* Effect.promise(() => response.text())
          expect(html).not.toContain('<script>')
          expect(html).toContain('&lt;script&gt;')
          expect(html).toContain('&amp;')
          expect(asError(yield* Effect.flip(callback.waitForCode)).message).toContain('<script>')
        })
      )

      yield* withCallback({ expectedState: 'replacement', port }, () => Effect.void)
    })
  )

  it.live('handles OAuth errors, timeout, cancellation, and occupied ports', () =>
    Effect.gen(function* () {
      yield* withCallback({ expectedState: 'state', port: yield* Effect.promise(() => freePort()) }, (callback) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => httpGet(`${callback.redirectUrl}?error=access_denied&error_description=nope&state=state`))
          expect(asError(yield* Effect.flip(callback.waitForCode)).message).toContain('access_denied')
        })
      )

      yield* withCallback({ expectedState: 'state', port: yield* Effect.promise(() => freePort()), timeoutMs: 5 }, (callback) =>
        Effect.gen(function* () {
          expect(asError(yield* Effect.flip(callback.waitForCode)).message).toContain('timed out')
        })
      )

      // oxlint-disable-next-line effecttsgo/abort-controller-in-effect -- This test must control the exact external AbortSignal and its timing.
      const controller = new AbortController()
      yield* withCallback({ expectedState: 'state', port: yield* Effect.promise(() => freePort()), signal: controller.signal }, (callback) =>
        Effect.gen(function* () {
          controller.abort()
          expect(asError(yield* Effect.flip(callback.waitForCode)).message).toContain('cancelled')
        })
      )

      const occupiedPort = yield* Effect.promise(() => freePort())
      yield* withCallback({ expectedState: 'one', port: occupiedPort }, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Effect.scoped(startOAuthCallback({ expectedState: 'two', port: occupiedPort })))
          expect(asError(error).message).toContain('already in use')
        })
      )
    })
  )

  it.live('rejects non-loopback or mismatched redirect URIs', () =>
    Effect.gen(function* () {
      for (const [redirectUri, message] of [
        ['https://example.test/callback', 'loopback'],
        ['http://localhost:5678/callback', 'match callbackPort'],
      ] as const) {
        const error = yield* Effect.flip(Effect.scoped(startOAuthCallback({ expectedState: 'state', port: 1234, redirectUri })))
        expect(asError(error).message).toContain(message)
      }
    })
  )
})

describe('Keychain OAuth provider', () => {
  it.effect('does not read credentials during construction and returns static client metadata', () =>
    Effect.gen(function* () {
      const store = new MemoryStore()
      const provider = new KeychainOAuthProvider({
        config: { callbackPort: 3118, clientId: 'static-id', clientName: 'My Custom Client', clientSecret: 'static-secret' },
        serverName: 'slack',
        serverUrl: 'https://mcp.slack.test/mcp',
        store,
      })

      expect(store.reads).toBe(0)
      expect(yield* Effect.promise(() => provider.clientInformation())).toEqual({
        client_id: 'static-id',
        client_secret: 'static-secret',
      })
      expect(provider.clientMetadata.client_name).toBe('My Custom Client')
      expect(provider.clientMetadata.redirect_uris).toEqual(['http://localhost:3118/callback'])
    })
  )

  it.effect('persists dynamic registration and refresh token updates without losing either', () =>
    Effect.gen(function* () {
      const store = new MemoryStore()
      const provider = new KeychainOAuthProvider({
        config: { callbackPort: 3119 },
        serverName: 'remote',
        serverUrl: 'https://mcp.example.test/mcp',
        store,
      })

      yield* Effect.promise(() => provider.saveClientInformation({ client_id: 'dynamic-id' }))
      yield* Effect.promise(() =>
        provider.saveTokens({
          access_token: 'access',
          refresh_token: 'refresh',
          token_type: 'Bearer',
        })
      )
      yield* Effect.promise(() =>
        provider.saveTokens({
          access_token: 'refreshed',
          refresh_token: 'refresh-2',
          token_type: 'Bearer',
        })
      )

      expect(yield* Effect.promise(() => provider.clientInformation())).toEqual({ client_id: 'dynamic-id' })
      expect(yield* Effect.promise(() => provider.tokens())).toMatchObject({
        access_token: 'refreshed',
        refresh_token: 'refresh-2',
      })
      expect(store.value?.serverUrl).toBe('https://mcp.example.test/mcp')
    })
  )

  it.effect('opens the browser only in an explicit interactive flow', () =>
    Effect.gen(function* () {
      const opened: string[] = []
      const provider = new KeychainOAuthProvider({
        config: { callbackPort: 3120 },
        serverName: 'remote',
        serverUrl: 'https://mcp.example.test/mcp',
        store: new MemoryStore(),
      })
      expect(provider.redirectToAuthorization(new URL('https://auth.test'))).rejects.toThrow('/mcp-auth')

      const state = createOAuthState()
      const interactive = new KeychainOAuthProvider({
        config: { callbackPort: 3120 },
        interactive: true,
        openUrl: async (url) => {
          opened.push(url)
        },
        serverName: 'remote',
        serverUrl: 'https://mcp.example.test/mcp',
        state,
        store: new MemoryStore(),
      })
      expect(interactive.state()).toBe(state)
      yield* Effect.promise(() => interactive.redirectToAuthorization(new URL('https://auth.test/start')))
      expect(opened).toEqual(['https://auth.test/start'])
    })
  )
})
