import { describe, expect, test } from 'bun:test'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The spec asserts real loopback listener binding and cleanup; an HTTP client cannot create the server under test.
import { createServer } from 'node:http'

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
const withCallback = <Value>(options: OAuthCallbackOptions, use: (callback: OAuthCallback) => Promise<Value>): Promise<Value> =>
  Effect.runPromise(Effect.scoped(startOAuthCallback(options).pipe(Effect.flatMap((callback) => Effect.promise(() => use(callback))))))

const listenerFailure = (options: OAuthCallbackOptions): Promise<OAuthCallback> => Effect.runPromise(Effect.scoped(startOAuthCallback(options)))

describe('OAuth callback', () => {
  test('accepts a matching callback and releases the port', async () => {
    const port = await freePort()
    await withCallback({ expectedState: 'right', port }, async (callback) => {
      const response = await httpGet(`${callback.redirectUrl}?code=code-1&state=right`)

      expect(response.status).toBe(200)
      expect(await Effect.runPromise(callback.waitForCode)).toBe('code-1')
    })

    await withCallback({ expectedState: 'next', port }, async () => undefined)
  })

  test('rejects a wrong state without consuming the legitimate callback', async () => {
    const port = await freePort()
    await withCallback({ expectedState: 'right', port }, async (callback) => {
      const badResponse = await httpGet(`${callback.redirectUrl}?code=bad&state=wrong`)
      expect(badResponse.status).toBe(400)
      const goodResponse = await httpGet(`${callback.redirectUrl}?code=good&state=right`)
      expect(goodResponse.status).toBe(200)
      expect(await Effect.runPromise(callback.waitForCode)).toBe('good')
    })
  })

  test('HTML-escapes reflected OAuth errors and releases scoped listeners', async () => {
    const port = await freePort()
    await withCallback({ expectedState: 'state', port }, async (callback) => {
      const payload = `<script>alert("x")</script>&'`
      const response = await httpGet(
        `${callback.redirectUrl}?error=${encodeURIComponent(payload)}&error_description=${encodeURIComponent(payload)}&state=state`
      )
      const html = await response.text()
      expect(html).not.toContain('<script>')
      expect(html).toContain('&lt;script&gt;')
      expect(html).toContain('&amp;')
      const callbackFailure = await Effect.runPromise(callback.waitForCode).then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      expect(callbackFailure).toContain('<script>')
    })

    await withCallback({ expectedState: 'replacement', port }, async () => undefined)
  })

  test('handles OAuth errors, timeout, cancellation, and occupied ports', async () => {
    await withCallback({ expectedState: 'state', port: await freePort() }, async (callback) => {
      await httpGet(`${callback.redirectUrl}?error=access_denied&error_description=nope&state=state`)
      expect(Effect.runPromise(callback.waitForCode)).rejects.toThrow('access_denied')
    })

    await withCallback({ expectedState: 'state', port: await freePort(), timeoutMs: 5 }, async (callback) => {
      expect(Effect.runPromise(callback.waitForCode)).rejects.toThrow('timed out')
    })

    const controller = new AbortController()
    await withCallback({ expectedState: 'state', port: await freePort(), signal: controller.signal }, async (callback) => {
      controller.abort()
      expect(Effect.runPromise(callback.waitForCode)).rejects.toThrow('cancelled')
    })

    const occupiedPort = await freePort()
    await withCallback({ expectedState: 'one', port: occupiedPort }, async () => {
      expect(listenerFailure({ expectedState: 'two', port: occupiedPort })).rejects.toThrow('already in use')
    })
  })

  test('rejects non-loopback or mismatched redirect URIs', async () => {
    expect(
      listenerFailure({
        expectedState: 'state',
        port: 1234,
        redirectUri: 'https://example.test/callback',
      })
    ).rejects.toThrow('loopback')
    expect(
      listenerFailure({
        expectedState: 'state',
        port: 1234,
        redirectUri: 'http://localhost:5678/callback',
      })
    ).rejects.toThrow('match callbackPort')
  })
})

describe('Keychain OAuth provider', () => {
  test('does not read credentials during construction and returns static client metadata', async () => {
    const store = new MemoryStore()
    const provider = new KeychainOAuthProvider({
      config: { callbackPort: 3118, clientId: 'static-id', clientName: 'My Custom Client', clientSecret: 'static-secret' },
      serverName: 'slack',
      serverUrl: 'https://mcp.slack.test/mcp',
      store,
    })

    expect(store.reads).toBe(0)
    expect(await provider.clientInformation()).toEqual({
      client_id: 'static-id',
      client_secret: 'static-secret',
    })
    expect(provider.clientMetadata.client_name).toBe('My Custom Client')
    expect(provider.clientMetadata.redirect_uris).toEqual(['http://localhost:3118/callback'])
  })

  test('persists dynamic registration and refresh token updates without losing either', async () => {
    const store = new MemoryStore()
    const provider = new KeychainOAuthProvider({
      config: { callbackPort: 3119 },
      serverName: 'remote',
      serverUrl: 'https://mcp.example.test/mcp',
      store,
    })

    await provider.saveClientInformation({ client_id: 'dynamic-id' })
    await provider.saveTokens({
      access_token: 'access',
      refresh_token: 'refresh',
      token_type: 'Bearer',
    })
    await provider.saveTokens({
      access_token: 'refreshed',
      refresh_token: 'refresh-2',
      token_type: 'Bearer',
    })

    expect(await provider.clientInformation()).toEqual({ client_id: 'dynamic-id' })
    expect(await provider.tokens()).toMatchObject({
      access_token: 'refreshed',
      refresh_token: 'refresh-2',
    })
    expect(store.value?.serverUrl).toBe('https://mcp.example.test/mcp')
  })

  test('opens the browser only in an explicit interactive flow', async () => {
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
    await interactive.redirectToAuthorization(new URL('https://auth.test/start'))
    expect(opened).toEqual(['https://auth.test/start'])
  })
})
