import { describe, expect, test } from 'bun:test'

import { asError, asOAuthCredentialPayload } from '#test-utils/casts'

import { KeychainCredentialStore, MCP_OAUTH_KEYCHAIN_SERVICE, keychainAccount, type OAuthCredentialPayload } from '../keychain'

type FailureMode = 'get' | 'set' | 'delete' | undefined

const inMemoryKeyring = (initial: Record<string, string> = {}, failure?: FailureMode) => {
  const values = new Map(Object.entries(initial))
  const calls: { operation: string; service: string; account: string }[] = []

  class Entry {
    private readonly service: string
    private readonly account: string

    constructor(service: string, account: string) {
      this.service = service
      this.account = account
    }

    getPassword(): string {
      calls.push({ account: this.account, operation: 'get', service: this.service })
      if (failure === 'get') {
        throw new Error('native failure containing secret-token')
      }
      if (!values.has(this.account)) {
        throw Object.assign(new Error('No matching entry found'), { code: 'NoEntry' })
      }
      const stored = values.get(this.account)
      if (stored === undefined) {
        throw new Error('missing password')
      }
      return stored
    }

    setPassword(password: string): void {
      calls.push({ account: this.account, operation: 'set', service: this.service })
      if (failure === 'set') {
        throw new Error(`could not save ${password}`)
      }
      values.set(this.account, password)
    }

    deletePassword(): void {
      calls.push({ account: this.account, operation: 'delete', service: this.service })
      if (failure === 'delete') {
        throw new Error('native delete failure containing secret-token')
      }
      if (!values.delete(this.account)) {
        throw Object.assign(new Error('item not found'), { code: 'NoEntry' })
      }
    }
  }

  return {
    calls,
    loadKeyring: async () => ({ Entry }),
    values,
  }
}

const credential: OAuthCredentialPayload = {
  clientInformation: {
    client_id: 'dynamic-client',
    client_id_issued_at: 123,
    client_secret: 'dynamic-secret',
    client_secret_expires_at: 456,
    registration_access_token: 'registration-secret',
    registration_client_uri: 'https://mcp.example.test/register/client',
    token_endpoint_auth_method: 'client_secret_post',
  },
  serverUrl: 'https://mcp.example.test/mcp',
  tokens: {
    access_token: 'access-secret',
    expires_in: 3600,
    refresh_token: 'refresh-secret',
    scope: 'read write',
    token_type: 'Bearer',
  },
}

describe('Keychain OAuth credential store', () => {
  test('round trips one validated URL-bound credential payload', async () => {
    const keyring = inMemoryKeyring()
    const store = new KeychainCredentialStore({ loadKeyring: keyring.loadKeyring })

    await store.set('slack', credential)
    expect(await store.get('slack', credential.serverUrl)).toEqual(credential)
    expect(keyring.calls).toEqual([
      {
        account: keychainAccount('slack'),
        operation: 'set',
        service: MCP_OAUTH_KEYCHAIN_SERVICE,
      },
      {
        account: keychainAccount('slack'),
        operation: 'get',
        service: MCP_OAUTH_KEYCHAIN_SERVICE,
      },
    ])

    const serialized = keyring.values.get(keychainAccount('slack'))
    if (!serialized) {
      throw new Error('expected a serialized credential')
    }
    expect(JSON.parse(serialized)).toEqual(credential)
  })

  test('uses a stable SHA-256 account without exposing the server name', () => {
    expect(keychainAccount('slack')).toMatch(/^[0-9a-f]{64}$/)
    expect(keychainAccount('slack')).not.toContain('slack')
    expect(keychainAccount('slack')).toBe(keychainAccount('slack'))
    expect(keychainAccount('linear')).not.toBe(keychainAccount('slack'))
  })

  test('rejects a payload when the configured endpoint was repointed', async () => {
    const keyring = inMemoryKeyring()
    const store = new KeychainCredentialStore({ loadKeyring: keyring.loadKeyring })
    await store.set('slack', credential)

    expect(await store.get('slack', 'https://attacker.example/mcp')).toBeUndefined()
    expect(keyring.values.has(keychainAccount('slack'))).toBeTrue()
  })

  test('deletes credentials and treats absent entries as empty', async () => {
    const keyring = inMemoryKeyring()
    const store = new KeychainCredentialStore({ loadKeyring: keyring.loadKeyring })

    expect(await store.get('slack', credential.serverUrl)).toBeUndefined()
    await store.delete('slack')
    await store.set('slack', credential)
    await store.delete('slack')
    expect(await store.get('slack', credential.serverUrl)).toBeUndefined()
  })

  test('loads the native module lazily on credential access', async () => {
    let loads = 0
    const keyring = inMemoryKeyring()
    const store = new KeychainCredentialStore({
      loadKeyring: async () => {
        loads += 1
        return keyring.loadKeyring()
      },
    })

    expect(loads).toBe(0)
    await store.get('slack', credential.serverUrl)
    expect(loads).toBe(1)
  })

  test('rejects malformed JSON and malformed credential members', async () => {
    for (const serialized of [
      '{ nope',
      JSON.stringify({ serverUrl: credential.serverUrl }),
      JSON.stringify({
        serverUrl: credential.serverUrl,
        tokens: { access_token: 'secret', token_type: 3 },
      }),
      JSON.stringify({
        clientInformation: { client_id: '' },
        serverUrl: credential.serverUrl,
      }),
      JSON.stringify({
        plaintextFallback: true,
        serverUrl: credential.serverUrl,
        tokens: { access_token: 'secret', token_type: 'Bearer' },
      }),
    ]) {
      const keyring = inMemoryKeyring({ [keychainAccount('slack')]: serialized })
      const store = new KeychainCredentialStore({ loadKeyring: keyring.loadKeyring })
      expect(store.get('slack', credential.serverUrl)).rejects.toThrow('credential for MCP server "slack" is malformed')
    }
  })

  test('validates payloads before writing to Keychain', async () => {
    const keyring = inMemoryKeyring()
    const store = new KeychainCredentialStore({ loadKeyring: keyring.loadKeyring })
    const malformed = asOAuthCredentialPayload({
      serverUrl: credential.serverUrl,
      tokens: { access_token: 'secret' },
    })

    expect(store.set('slack', malformed)).rejects.toThrow('is malformed')
    expect(keyring.calls).toEqual([])
  })

  test('redacts native lookup, write, and deletion failures', async () => {
    for (const operation of ['get', 'set', 'delete'] as const) {
      const keyring = inMemoryKeyring({}, operation)
      const store = new KeychainCredentialStore({ loadKeyring: keyring.loadKeyring })
      let error: unknown
      try {
        if (operation === 'get') {
          await store.get('slack', credential.serverUrl)
        }
        if (operation === 'set') {
          await store.set('slack', credential)
        }
        if (operation === 'delete') {
          await store.delete('slack')
        }
      } catch (caughtError) {
        error = caughtError
      }

      expect(error).toBeInstanceOf(Error)
      expect(asError(error).message).toContain('Ensure Keychain is available and unlocked')
      expect(asError(error).message).not.toContain('secret-token')
      expect(asError(error).message).not.toContain('access-secret')
    }
  })

  test('redacts a native module loading failure', async () => {
    const store = new KeychainCredentialStore({
      loadKeyring: async () => {
        throw new Error('dlopen failed at /private/secret/path')
      },
    })

    expect(store.get('slack', credential.serverUrl)).rejects.toThrow('Ensure Keychain is available and unlocked')
    try {
      await store.get('slack', credential.serverUrl)
    } catch (error) {
      expect(asError(error).message).not.toContain('/private/secret/path')
    }
  })
})
