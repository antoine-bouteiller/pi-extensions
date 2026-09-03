import { promiseFromEffect, tryEffect, describe, expect, it } from '@tests/utils/bun_effect.js'
import { asNarrowed } from '@tests/utils/casts.js'
import { Effect, Fiber, Option } from 'effect'

import {
  KeychainCredentialStore,
  MCP_OAUTH_KEYCHAIN_SERVICE,
  keychainAccount,
  nativeKeyringPackage,
  type KeychainCredentialError,
  type OAuthCredentialPayload,
} from '@/features/mcp/keychain.js'
import { jsonText, parseJsonText } from '@/shared/utils/json.js'

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

    getPassword(): Promise<string> {
      return promiseFromEffect(
        tryEffect(() => {
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
        })
      )
    }

    setPassword(password: string): Promise<void> {
      return promiseFromEffect(
        tryEffect(() => {
          calls.push({ account: this.account, operation: 'set', service: this.service })
          if (failure === 'set') {
            throw new Error(`could not save ${password}`)
          }
          values.set(this.account, password)
        })
      )
    }

    deletePassword(): Promise<boolean> {
      return promiseFromEffect(
        tryEffect(() => {
          calls.push({ account: this.account, operation: 'delete', service: this.service })
          if (failure === 'delete') {
            throw new Error('native delete failure containing secret-token')
          }
          if (!values.delete(this.account)) {
            throw Object.assign(new Error('item not found'), { code: 'NoEntry' })
          }
          return true
        })
      )
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
  it('selects native bindings for macOS and Linux libc variants', () => {
    expect(nativeKeyringPackage('darwin', 'arm64')).toBe('@napi-rs/keyring-darwin-arm64')
    expect(nativeKeyringPackage('linux', 'x64')).toBe('@napi-rs/keyring-linux-x64-gnu')
    expect(nativeKeyringPackage('linux', 'arm64', true)).toBe('@napi-rs/keyring-linux-arm64-musl')
    expect(() => nativeKeyringPackage('win32', 'x64')).toThrow('Unsupported keyring platform: win32-x64')
  })

  it.effect('round trips one validated URL-bound credential payload', () =>
    Effect.gen(function* () {
      const keyring = inMemoryKeyring()
      const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })

      yield* store.set('slack', credential)
      expect(yield* store.get('slack', credential.serverUrl)).toEqual(Option.some(credential))
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
      expect(parseJsonText(serialized)).toEqual(credential)
    })
  )

  it.effect('aborts the pending keyring operation when the caller is interrupted', () =>
    Effect.gen(function* () {
      const signals: (AbortSignal | undefined)[] = []
      const pending = <Value>(signal: AbortSignal | undefined | null): Promise<Value> => {
        signals.push(signal ?? undefined)
        return promiseFromEffect(Effect.never)
      }
      const store = new KeychainCredentialStore({
        createEntry: () => ({
          deletePassword: (signal) => pending<boolean>(signal),
          getPassword: (signal) => pending<string>(signal),
          setPassword: (_password, signal) => pending<void>(signal),
        }),
      })

      const lookup = yield* Effect.forkDetach(store.get('slack', credential.serverUrl), { startImmediately: true })
      yield* Effect.yieldNow
      yield* Fiber.interrupt(lookup)

      expect(signals).toHaveLength(1)
      expect(signals[0]?.aborted).toBeTrue()
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
      yield* store.set('slack', credential)

      expect(yield* store.get('slack', 'https://attacker.example/mcp')).toEqual(Option.none())
      expect(keyring.values.has(keychainAccount('slack'))).toBeTrue()
    })
  )

  it.effect('deletes credentials and treats absent entries as empty', () =>
    Effect.gen(function* () {
      const keyring = inMemoryKeyring()
      const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })

      expect(yield* store.get('slack', credential.serverUrl)).toEqual(Option.none())
      yield* store.delete('slack')
      yield* store.set('slack', credential)
      yield* store.delete('slack')
      expect(yield* store.get('slack', credential.serverUrl)).toEqual(Option.none())
    })
  )

  it.effect('deletes malformed JSON and malformed credential members', () =>
    Effect.gen(function* () {
      for (const serialized of [
        '{ nope',
        jsonText({ serverUrl: credential.serverUrl }),
        jsonText({
          serverUrl: credential.serverUrl,
          tokens: { access_token: 'secret', token_type: 3 },
        }),
        jsonText({
          clientInformation: { client_id: '' },
          serverUrl: credential.serverUrl,
        }),
        jsonText({
          plaintextFallback: true,
          serverUrl: credential.serverUrl,
          tokens: { access_token: 'secret', token_type: 'Bearer' },
        }),
      ]) {
        const keyring = inMemoryKeyring({ [keychainAccount('slack')]: serialized })
        const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })

        expect(yield* store.get('slack', credential.serverUrl)).toEqual(Option.none())
        expect(keyring.values.has(keychainAccount('slack'))).toBeFalse()
        expect(keyring.calls.map(({ operation }) => operation)).toEqual(['get', 'delete'])
      }
    })
  )

  it.effect('validates payloads before writing to Keychain', () =>
    Effect.gen(function* () {
      const keyring = inMemoryKeyring()
      const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })
      const malformed = asNarrowed<OAuthCredentialPayload, { serverUrl: string; tokens: { access_token: string } }>({
        serverUrl: credential.serverUrl,
        tokens: { access_token: 'secret' },
      })

      expect((yield* Effect.flip(store.set('slack', malformed))).message).toContain('is malformed')
      expect(keyring.calls).toEqual([])
    })
  )

  it.effect('redacts native lookup, write, and deletion failures', () =>
    Effect.gen(function* () {
      for (const operation of ['get', 'set', 'delete'] as const) {
        const keyring = inMemoryKeyring({}, operation)
        const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })
        let request: Effect.Effect<void, KeychainCredentialError>
        if (operation === 'get') {
          request = Effect.asVoid(store.get('slack', credential.serverUrl))
        } else if (operation === 'set') {
          request = store.set('slack', credential)
        } else {
          request = store.delete('slack')
        }
        const failure = yield* Effect.flip(request)

        expect(failure).toBeInstanceOf(Error)
        expect(failure.message).toContain('Ensure the keyring is available and unlocked')
        expect(failure.message).not.toContain('secret-token')
        expect(failure.message).not.toContain('access-secret')
      }
    })
  )

  it.effect('isolates server names that share one URL', () =>
    Effect.gen(function* () {
      const keyring = inMemoryKeyring()
      const store = new KeychainCredentialStore({ createEntry: keyring.createEntry })
      yield* store.set('alpha', credential)
      yield* store.set('beta', { ...credential, tokens: { access_token: 'beta-token', token_type: 'Bearer' } })

      const alpha = yield* store.get('alpha', credential.serverUrl)
      const beta = yield* store.get('beta', credential.serverUrl)
      expect(Option.getOrUndefined(alpha)?.tokens?.access_token).toBe('access-secret')
      expect(Option.getOrUndefined(beta)?.tokens?.access_token).toBe('beta-token')
    })
  )
})
