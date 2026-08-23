import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { type AsyncEntry as AsyncEntryType } from '@napi-rs/keyring'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'

import { type JsonObject, type JsonValue } from '#shared/utils/json'
import { isEmptyString } from '#shared/utils/predicates'
import { isRecord } from '#shared/utils/records'

export const MCP_OAUTH_KEYCHAIN_SERVICE = 'pi-mcp.oauth'

/** A bounded, redacted message that is safe to surface to the user/model. */
export class KeychainCredentialError extends Schema.TaggedError<KeychainCredentialError>()('KeychainCredentialError', {
  message: Schema.String,
}) {}

const OAuthTokensSchema = Type.Object({
  access_token: Type.String({ minLength: 1 }),
  expires_in: Type.Optional(Type.Number()),
  refresh_token: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String()),
  token_type: Type.String({ minLength: 1 }),
})

const OAuthClientInformationSchema = Type.Object({
  client_id: Type.String({ minLength: 1 }),
  client_id_issued_at: Type.Optional(Type.Number()),
  client_secret: Type.Optional(Type.String()),
  client_secret_expires_at: Type.Optional(Type.Number()),
  registration_access_token: Type.Optional(Type.String()),
  registration_client_uri: Type.Optional(Type.String()),
  token_endpoint_auth_method: Type.Optional(Type.String()),
})

type OAuthTokens = Static<typeof OAuthTokensSchema>
type OAuthClientInformation = Static<typeof OAuthClientInformationSchema>

export interface OAuthCredentialPayload {
  serverUrl: string
  tokens?: OAuthTokens
  clientInformation?: OAuthClientInformation
}

/** Async boundary consumed by the OAuth provider; tests can supply an in-memory store. */
export interface CredentialStore {
  get: (serverName: string, serverUrl: string, signal?: AbortSignal) => Promise<OAuthCredentialPayload | undefined>
  set: (serverName: string, credential: OAuthCredentialPayload, signal?: AbortSignal) => Promise<void>
  delete: (serverName: string, signal?: AbortSignal) => Promise<void>
}

interface CredentialStoreEffectApi {
  readonly delete: (serverName: string) => Effect.Effect<void, KeychainCredentialError>
  readonly get: (serverName: string, serverUrl: string) => Effect.Effect<Option.Option<OAuthCredentialPayload>, KeychainCredentialError>
  readonly set: (serverName: string, credential: OAuthCredentialPayload) => Effect.Effect<void, KeychainCredentialError>
}

/** Effect-native credential boundary; the Promise interface remains as the MCP SDK adapter. */
export class CredentialStoreEffect extends Context.Service<CredentialStoreEffect, CredentialStoreEffectApi>()(
  'pi-extensions/features/mcp/keychain/CredentialStoreEffect'
) {}

type KeyringEntry = Pick<AsyncEntryType, 'deletePassword' | 'getPassword' | 'setPassword'>
type EntryFactory = (service: string, account: string) => KeyringEntry
interface KeyringModule {
  AsyncEntry: new (service: string, account: string) => AsyncEntryType
}

const isKeyringModule = (value: unknown): value is KeyringModule =>
  typeof value === 'object' && value !== null && 'AsyncEntry' in value && typeof value.AsyncEntry === 'function'

export const nativeKeyringPackage = (platform: NodeJS.Platform, arch: string, musl = false): string => {
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) {
    return `@napi-rs/keyring-darwin-${arch}`
  }
  if (platform === 'linux' && ['arm64', 'x64'].includes(arch)) {
    return `@napi-rs/keyring-linux-${arch}-${musl ? 'musl' : 'gnu'}`
  }
  throw new Error(`Unsupported keyring platform: ${platform}-${arch}`)
}

const isMusl = (): boolean => {
  const report = process.report?.getReport()
  if (!isRecord(report)) {
    return false
  }
  return !isRecord(report.header) || typeof report.header.glibcVersionRuntime !== 'string'
}

export interface KeychainCredentialStoreOptions {
  serviceName?: string
  createEntry?: EntryFactory
}

const isObject = (value: unknown): value is JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || ['boolean', 'string'].includes(typeof value)) {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }
  if (!isObject(value)) {
    return false
  }
  return Object.values(value).every(isJsonValue)
}

const malformed = (serverName: string): Error =>
  KeychainCredentialError.make({
    message: `Stored OAuth credential for MCP server ${JSON.stringify(serverName)} is malformed; delete it and authenticate again.`,
  })

const requireString = (value: JsonObject, field: string, serverName: string): string => {
  const result = value[field]
  if (typeof result !== 'string' || isEmptyString(result)) {
    throw malformed(serverName)
  }
  return result
}

const validateTokens = (value: unknown, serverName: string): OAuthTokens => {
  if (!isObject(value) || !isJsonValue(value) || !Check(OAuthTokensSchema, value)) {
    throw malformed(serverName)
  }
  return value
}

const validateClientInformation = (value: unknown, serverName: string): OAuthClientInformation => {
  if (!isObject(value) || !isJsonValue(value) || !Check(OAuthClientInformationSchema, value)) {
    throw malformed(serverName)
  }
  return value
}

const validateCredentialPayload = (value: unknown, serverName: string): OAuthCredentialPayload => {
  if (!isObject(value)) {
    throw malformed(serverName)
  }
  for (const field of Object.keys(value)) {
    if (!new Set(['serverUrl', 'tokens', 'clientInformation']).has(field)) {
      throw malformed(serverName)
    }
  }

  const serverUrl = requireString(value, 'serverUrl', serverName)
  const tokens = value.tokens === undefined ? undefined : validateTokens(value.tokens, serverName)
  const clientInformation = value.clientInformation === undefined ? undefined : validateClientInformation(value.clientInformation, serverName)
  if (tokens === undefined && clientInformation === undefined) {
    throw malformed(serverName)
  }

  const credential: OAuthCredentialPayload = { serverUrl }
  if (tokens !== undefined) {
    credential.tokens = tokens
  }
  if (clientInformation !== undefined) {
    credential.clientInformation = clientInformation
  }
  return credential
}

export const keychainAccount = (serverName: string): string => createHash('sha256').update(serverName, 'utf8').digest('hex')

const isMissingCredential = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  const name = 'name' in error && typeof error.name === 'string' ? error.name : ''
  const message = 'message' in error && typeof error.message === 'string' ? error.message.toLowerCase() : ''
  return (
    /no.?entry|not.?found/i.test(code) ||
    /no.?entry|not.?found/i.test(name) ||
    message.includes('no entry') ||
    message.includes('no matching entry') ||
    message.includes('item not found')
  )
}

const operationError = (operation: string, serverName: string): Error =>
  KeychainCredentialError.make({
    message:
      `System keyring OAuth credential ${operation} failed for MCP server ` +
      `${JSON.stringify(serverName)}. Ensure the keyring is available and unlocked, then retry.`,
  })

export class KeychainCredentialStore implements CredentialStore {
  readonly serviceName: string
  private readonly createEntry: EntryFactory

  constructor(options: KeychainCredentialStoreOptions = {}) {
    this.serviceName = options.serviceName ?? MCP_OAUTH_KEYCHAIN_SERVICE
    this.createEntry =
      options.createEntry ??
      ((service, account) => {
        const packageName = nativeKeyringPackage(process.platform, process.arch, process.platform === 'linux' && isMusl())
        const nativeKeyring: unknown = createRequire(import.meta.url)(fileURLToPath(import.meta.resolve(packageName)))
        if (!isKeyringModule(nativeKeyring)) {
          throw new Error('Failed to load system keyring binding')
        }
        return new nativeKeyring.AsyncEntry(service, account)
      })
  }

  private entry(serverName: string): KeyringEntry {
    return this.createEntry(this.serviceName, keychainAccount(serverName))
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Implements the promise-returning `CredentialStore` awaited by the MCP SDK's OAuth provider; `CredentialStoreEffect` is the Effect-facing wrapper.
  async get(serverName: string, serverUrl: string, signal?: AbortSignal): Promise<OAuthCredentialPayload | undefined> {
    let serialized: string | undefined
    try {
      const entry = this.entry(serverName)
      serialized = await entry.getPassword(signal)
    } catch (error) {
      if (isMissingCredential(error)) {
        return undefined
      }
      throw operationError('lookup', serverName)
    }
    if (serialized === undefined) {
      return undefined
    }
    try {
      if (typeof serialized !== 'string') {
        throw malformed(serverName)
      }
      const credential = validateCredentialPayload(JSON.parse(serialized) as unknown, serverName)
      return credential.serverUrl === serverUrl ? credential : undefined
    } catch {
      await this.delete(serverName, signal)
      return undefined
    }
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Implements the promise-returning `CredentialStore` awaited by the MCP SDK's OAuth provider.
  async set(serverName: string, credential: OAuthCredentialPayload, signal?: AbortSignal): Promise<void> {
    const validated = validateCredentialPayload(credential, serverName)
    try {
      const entry = this.entry(serverName)
      await entry.setPassword(JSON.stringify(validated), signal)
    } catch {
      throw operationError('write', serverName)
    }
  }

  // oxlint-disable-next-line effecttsgo/async-function -- Implements the promise-returning `CredentialStore` awaited by the MCP SDK's OAuth provider.
  async delete(serverName: string, signal?: AbortSignal): Promise<void> {
    try {
      const entry = this.entry(serverName)
      await entry.deletePassword(signal)
    } catch (error) {
      if (isMissingCredential(error)) {
        return
      }
      throw operationError('deletion', serverName)
    }
  }
}

export const createKeychainCredentialStore = (options: KeychainCredentialStoreOptions = {}): CredentialStore => new KeychainCredentialStore(options)

const asKeychainError = (cause: unknown): KeychainCredentialError =>
  Schema.is(KeychainCredentialError)(cause) ? cause : KeychainCredentialError.make({ message: 'System keyring OAuth credential operation failed.' })

export const credentialStoreEffectLayer = (options: KeychainCredentialStoreOptions = {}): Layer.Layer<CredentialStoreEffect> => {
  const store = createKeychainCredentialStore(options)
  return Layer.succeed(CredentialStoreEffect)({
    delete: (serverName) => Effect.tryPromise({ catch: asKeychainError, try: () => store.delete(serverName) }),
    get: (serverName, serverUrl) =>
      Effect.tryPromise({ catch: asKeychainError, try: () => store.get(serverName, serverUrl) }).pipe(
        Effect.map((value) => (value === undefined ? Option.none() : Option.some(value)))
      ),
    set: (serverName, credential) => Effect.tryPromise({ catch: asKeychainError, try: () => store.set(serverName, credential) }),
  })
}
