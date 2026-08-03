import { describe, expect, test } from 'bun:test'

import { asError, asOAuthCredentialPayload } from '@tests/utils/casts.js'
import { Effect, Option } from 'effect'

import {
  CredentialStoreEffect,
  KeychainCredentialStore,
  MCP_OAUTH_KEYCHAIN_SERVICE,
  credentialStoreEffectLayer,
  keychainAccount,
  type OAuthCredentialPayload,
} from '@/features/mcp/keychain.js'

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

    deletePassword(): boolean {
      calls.push({ account: this.account, operation: 'delete', service: this.service })
      if (failure === 'delete') {
        throw new Error('native delete failure containing secret-token')
      }
      if (!values.delete(this.account)) {
        throw Object.assign(new Error('item not found'), { code: 'NoEntry' })
      }
      return true
    }
  }

  return {
    calls,
    createEntry: (service: string, account: string) => new Entry(service, account),
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
    const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })

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
    const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })
    await store.set('slack', credential)

    expect(await store.get('slack', 'https://attacker.example/mcp')).toBeUndefined()
    expect(keyring.values.has(keychainAccount('slack'))).toBeTrue()
  })

  test('deletes credentials and treats absent entries as empty', async () => {
    const keyring = inMemoryKeyring()
    const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })

    expect(await store.get('slack', credential.serverUrl)).toBeUndefined()
    await store.delete('slack')
    await store.set('slack', credential)
    await store.delete('slack')
    expect(await store.get('slack', credential.serverUrl)).toBeUndefined()
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
      const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })
      expect(store.get('slack', credential.serverUrl)).rejects.toThrow('credential for MCP server "slack" is malformed')
    }
  })

  test('validates payloads before writing to Keychain', async () => {
    const keyring = inMemoryKeyring()
    const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })
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
      const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })
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

  test('isolates server names that share one URL and exposes the Effect service as Option', async () => {
    const keyring = inMemoryKeyring()
    const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })
    await store.set('alpha', credential)
    await store.set('beta', { ...credential, tokens: { access_token: 'beta-token', token_type: 'Bearer' } })

    const alpha = await store.get('alpha', credential.serverUrl)
    const beta = await store.get('beta', credential.serverUrl)
    expect(alpha?.tokens?.access_token).toBe('access-secret')
    expect(beta?.tokens?.access_token).toBe('beta-token')

    const loaded = await Effect.runPromise(
      Effect.gen(function* () {
        const effectStore = yield* CredentialStoreEffect
        return yield* effectStore.get('alpha', credential.serverUrl)
      }).pipe(Effect.provide(credentialStoreEffectLayer({ createEntry: keyring.createEntry })))
    )
    expect(Option.isSome(loaded)).toBe(true)
  })
})
