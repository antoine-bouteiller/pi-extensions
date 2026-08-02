import { createHash } from 'node:crypto'

import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'

export const MCP_OAUTH_KEYCHAIN_SERVICE = 'pi-mcp.oauth'

/** A bounded, redacted message that is safe to surface to the user/model. */
export class KeychainCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeychainCredentialError'
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
interface JsonObject {
  [key: string]: JsonValue | undefined
}

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
  get: (serverName: string, serverUrl: string) => Promise<OAuthCredentialPayload | undefined>
  set: (serverName: string, credential: OAuthCredentialPayload) => Promise<void>
  delete: (serverName: string) => Promise<void>
}

interface KeyringEntry {
  getPassword: () => string | null | Promise<string | null>
  setPassword: (password: string) => void | Promise<void>
  deletePassword: () => void | Promise<void>
}

interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry
}

type KeyringLoader = () => Promise<KeyringModule>

export interface KeychainCredentialStoreOptions {
  serviceName?: string
  loadKeyring?: KeyringLoader
}

const isObject = (value: unknown): value is Record<string, unknown> => {
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
  new KeychainCredentialError(`Stored OAuth credential for MCP server ${JSON.stringify(serverName)} is malformed; delete it and authenticate again.`)

const requireString = (value: Record<string, unknown>, field: string, serverName: string): string => {
  const result = value[field]
  if (typeof result !== 'string' || result.length === 0) {
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

  return {
    serverUrl,
    ...(tokens === undefined ? {} : { tokens }),
    ...(clientInformation === undefined ? {} : { clientInformation }),
  }
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
  new KeychainCredentialError(
    `macOS Keychain OAuth credential ${operation} failed for MCP server ` +
      `${JSON.stringify(serverName)}. Ensure Keychain is available and unlocked, then retry.`
  )

const loadProductionKeyring = async (): Promise<KeyringModule> => {
  // Keep this specifier indirect so merely loading the MCP extension does not initialize
  // The native keyring package (and so the package can be installed in the dependency step).
  const packageName = '@napi-rs/keyring'
  const loaded: unknown = await import(packageName)
  if (!isObject(loaded) || typeof loaded.Entry !== 'function') {
    throw new KeychainCredentialError('The @napi-rs/keyring native module is unavailable or malformed; reinstall it and retry.')
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a constructor signature has no schema equivalent; `Entry` is verified constructible above.
  return { Entry: loaded.Entry as KeyringModule['Entry'] }
}

export class KeychainCredentialStore implements CredentialStore {
  readonly serviceName: string
  private readonly loadKeyring: KeyringLoader

  constructor(options: KeychainCredentialStoreOptions = {}) {
    this.serviceName = options.serviceName ?? MCP_OAUTH_KEYCHAIN_SERVICE
    this.loadKeyring = options.loadKeyring ?? loadProductionKeyring
  }

  private async entry(serverName: string): Promise<KeyringEntry> {
    const keyring = await this.loadKeyring()
    return new keyring.Entry(this.serviceName, keychainAccount(serverName))
  }

  async get(serverName: string, serverUrl: string): Promise<OAuthCredentialPayload | undefined> {
    let serialized: string | null
    try {
      const entry = await this.entry(serverName)
      serialized = await entry.getPassword()
    } catch (error) {
      if (isMissingCredential(error)) {
        return undefined
      }
      throw operationError('lookup', serverName)
    }
    if (serialized === null) {
      return undefined
    }
    if (typeof serialized !== 'string') {
      throw malformed(serverName)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(serialized) as unknown
    } catch {
      throw malformed(serverName)
    }
    const credential = validateCredentialPayload(parsed, serverName)
    return credential.serverUrl === serverUrl ? credential : undefined
  }

  async set(serverName: string, credential: OAuthCredentialPayload): Promise<void> {
    const validated = validateCredentialPayload(credential, serverName)
    try {
      const entry = await this.entry(serverName)
      await entry.setPassword(JSON.stringify(validated))
    } catch {
      throw operationError('write', serverName)
    }
  }

  async delete(serverName: string): Promise<void> {
    try {
      const entry = await this.entry(serverName)
      await entry.deletePassword()
    } catch (error) {
      if (isMissingCredential(error)) {
        return
      }
      throw operationError('deletion', serverName)
    }
  }
}

export const createKeychainCredentialStore = (options: KeychainCredentialStoreOptions = {}): CredentialStore => new KeychainCredentialStore(options)
