import { describe, expect, it } from '@tests/utils/bun_effect.js'
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

    async getPassword(): Promise<string> {
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

    async setPassword(password: string): Promise<void> {
      calls.push({ account: this.account, operation: 'set', service: this.service })
      if (failure === 'set') {
        throw new Error(`could not save ${password}`)
      }
      values.set(this.account, password)
    }

    async deletePassword(): Promise<boolean> {
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
  it.effect('round trips one validated URL-bound credential payload', () =>
    Effect.gen(function* () {
      const keyring = inMemoryKeyring()
      const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })

      yield* Effect.promise(() => store.set('slack', credential))
      expect(yield* Effect.promise(() => store.get('slack', credential.serverUrl))).toEqual(credential)
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
      if (serialized === undefined) {
        throw new Error('expected a serialized credential')
      }
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This test exercises native JSON fixture or process behavior; schema decoding would change the boundary under test.
      expect(JSON.parse(serialized)).toEqual(credential)
    })
  )

  it.effect('awaits async keyring operations and forwards cancellation', () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line effecttsgo/abort-controller-in-effect -- This test must control the exact external AbortSignal and its timing.
      const controller = new AbortController()
      const signals: (AbortSignal | undefined)[] = []
      let serialized: string | undefined
      const store = new KeychainCredentialStore({
        createEntry: () => ({
          async deletePassword(signal) {
            await Promise.resolve()
            signals.push(signal ?? undefined)
            serialized = undefined
            return true
          },
          async getPassword(signal) {
            await Promise.resolve()
            signals.push(signal ?? undefined)
            return serialized
          },
          async setPassword(password, signal) {
            await Promise.resolve()
            signals.push(signal ?? undefined)
            serialized = password
          },
        }),
      })

      yield* Effect.promise(() => store.set('slack', credential, controller.signal))
      expect(yield* Effect.promise(() => store.get('slack', credential.serverUrl, controller.signal))).toEqual(credential)
      yield* Effect.promise(() => store.delete('slack', controller.signal))

      expect(serialized).toBeUndefined()
      expect(signals).toEqual([controller.signal, controller.signal, controller.signal])
    })
  )

  it.effect('uses a stable SHA-256 account without exposing the server name', () =>
    Effect.sync(() => {
      expect(keychainAccount('slack')).toMatch(/^[0-9a-f]{64}$/)
      expect(keychainAccount('slack')).not.toContain('slack')
      expect(keychainAccount('slack')).toBe(keychainAccount('slack'))
      expect(keychainAccount('linear')).not.toBe(keychainAccount('slack'))
    })
  )

  it.effect('rejects a payload when the configured endpoint was repointed', () =>
    Effect.gen(function* () {
      const keyring = inMemoryKeyring()
      const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })
      yield* Effect.promise(() => store.set('slack', credential))

      expect(yield* Effect.promise(() => store.get('slack', 'https://attacker.example/mcp'))).toBeUndefined()
      expect(keyring.values.has(keychainAccount('slack'))).toBeTrue()
    })
  )

  it.effect('deletes credentials and treats absent entries as empty', () =>
    Effect.gen(function* () {
      const keyring = inMemoryKeyring()
      const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })

      expect(yield* Effect.promise(() => store.get('slack', credential.serverUrl))).toBeUndefined()
      yield* Effect.promise(() => store.delete('slack'))
      yield* Effect.promise(() => store.set('slack', credential))
      yield* Effect.promise(() => store.delete('slack'))
      expect(yield* Effect.promise(() => store.get('slack', credential.serverUrl))).toBeUndefined()
    })
  )

  it.effect('rejects malformed JSON and malformed credential members', () =>
    Effect.gen(function* () {
      for (const serialized of [
        '{ nope',
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This test exercises native JSON fixture or process behavior; schema decoding would change the boundary under test.
        JSON.stringify({ serverUrl: credential.serverUrl }),
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This test exercises native JSON fixture or process behavior; schema decoding would change the boundary under test.
        JSON.stringify({
          serverUrl: credential.serverUrl,
          tokens: { access_token: 'secret', token_type: 3 },
        }),
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This test exercises native JSON fixture or process behavior; schema decoding would change the boundary under test.
        JSON.stringify({
          clientInformation: { client_id: '' },
          serverUrl: credential.serverUrl,
        }),
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This test exercises native JSON fixture or process behavior; schema decoding would change the boundary under test.
        JSON.stringify({
          plaintextFallback: true,
          serverUrl: credential.serverUrl,
          tokens: { access_token: 'secret', token_type: 'Bearer' },
        }),
      ]) {
        const keyring = inMemoryKeyring({ [keychainAccount('slack')]: serialized })
        const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })
        yield* Effect.promise(() =>
          store.get('slack', credential.serverUrl).then(
            () => {
              throw new Error('expected malformed Keychain credential')
            },
            (error: unknown) => {
              expect(asError(error).message).toContain('credential for MCP server "slack" is malformed')
            }
          )
        )
      }
    })
  )

  it.effect('validates payloads before writing to Keychain', () =>
    Effect.gen(function* () {
      const keyring = inMemoryKeyring()
      const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })
      const malformed = asOAuthCredentialPayload({
        serverUrl: credential.serverUrl,
        tokens: { access_token: 'secret' },
      })

      yield* Effect.promise(() =>
        store.set('slack', malformed).then(
          () => {
            throw new Error('expected malformed Keychain credential')
          },
          (error: unknown) => {
            expect(asError(error).message).toContain('is malformed')
          }
        )
      )
      expect(keyring.calls).toEqual([])
    })
  )

  it.effect('redacts native lookup, write, and deletion failures', () =>
    Effect.gen(function* () {
      for (const operation of ['get', 'set', 'delete'] as const) {
        const keyring = inMemoryKeyring({}, operation)
        const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })
        let request: Promise<unknown>
        if (operation === 'get') {
          request = store.get('slack', credential.serverUrl)
        } else if (operation === 'set') {
          request = store.set('slack', credential)
        } else {
          request = store.delete('slack')
        }
        const failure = yield* Effect.promise(() => request.then(undefined, (error: unknown) => error))

        expect(failure).toBeInstanceOf(Error)
        expect(asError(failure).message).toContain('Ensure Keychain is available and unlocked')
        expect(asError(failure).message).not.toContain('secret-token')
        expect(asError(failure).message).not.toContain('access-secret')
      }
    })
  )

  it.effect('isolates server names that share one URL and exposes the Effect service as Option', () =>
    Effect.gen(function* () {
      const keyring = inMemoryKeyring()
      const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })
      yield* Effect.promise(() => store.set('alpha', credential))
      yield* Effect.promise(() => store.set('beta', { ...credential, tokens: { access_token: 'beta-token', token_type: 'Bearer' } }))

      const alpha = yield* Effect.promise(() => store.get('alpha', credential.serverUrl))
      const beta = yield* Effect.promise(() => store.get('beta', credential.serverUrl))
      expect(alpha?.tokens?.access_token).toBe('access-secret')
      expect(beta?.tokens?.access_token).toBe('beta-token')

      const loaded = yield* Effect.gen(function* () {
        const effectStore = yield* CredentialStoreEffect
        return yield* effectStore.get('alpha', credential.serverUrl)
      }).pipe(Effect.provide(credentialStoreEffectLayer({ createEntry: keyring.createEntry })))
      expect(Option.isSome(loaded)).toBe(true)
    })
  )
})
