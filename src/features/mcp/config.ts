import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { type Cause, Effect, Function, Schema } from 'effect'

import { isEmptyString, isTrue } from '@/shared/utils/predicates.js'

import {
  type DisabledServerConfig,
  type HttpServerConfig,
  type InvalidServerConfig,
  type McpServerConfig,
  type McpServerMap,
  type OAuthConfig,
  type StdioServerConfig,
} from './types.js'

const SERVER_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'oauth', 'disabled'])
const OAUTH_FIELDS = new Set([
  'clientId',
  'client_id',
  'clientName',
  'client_name',
  'clientSecret',
  'client_secret',
  'scope',
  'callbackPort',
  'callback_port',
  'redirectUri',
  'redirect_uri',
])

class McpConfigError extends Schema.TaggedErrorClass<McpConfigError>()('McpConfigError', {
  message: Schema.String,
  path: Schema.String,
}) {
  static from(path: string, reason: string): McpConfigError {
    return McpConfigError.make({ message: `${path}: ${reason}`, path })
  }
}

const StringMapSchema = Schema.Record(Schema.String, Schema.String)
const OAuthSchema = Schema.Struct({
  callbackPort: Schema.optional(Schema.Finite),
  clientId: Schema.optional(Schema.String),
  clientName: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  redirectUri: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
})
const StdioServerSchema = Schema.Struct({
  args: Schema.optional(Schema.Array(Schema.String)),
  command: Schema.String,
  cwd: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  env: Schema.optional(StringMapSchema),
  type: Schema.Literal('stdio'),
})
const HttpServerSchema = Schema.Struct({
  disabled: Schema.optional(Schema.Boolean),
  headers: Schema.optional(StringMapSchema),
  oauth: Schema.optional(OAuthSchema),
  type: Schema.Literal('http'),
  url: Schema.String,
})
const DisabledServerSchema = Schema.Struct({ disabled: Schema.Literal(true) })
const InvalidServerSchema = Schema.Struct({ invalid: Schema.Literal(true) })

/** Canonical server schema. Input aliases and validation precedence are normalized before decoding. */
const McpServerSchema = Schema.Union([StdioServerSchema, HttpServerSchema, DisabledServerSchema, InvalidServerSchema])
const McpServerMapSchema = Schema.Record(Schema.String, McpServerSchema)

const isObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const fail = (path: string, message: string): never => {
  throw McpConfigError.from(path, message)
}

const optionalBoolean = (value: unknown, path: string): boolean | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    return fail(path, 'must be a boolean')
  }
  return value
}

const requiredString = (value: unknown, path: string): string => {
  if (typeof value !== 'string') {
    return fail(path, 'must be a string')
  }
  if (isEmptyString(value)) {
    return fail(path, 'must not be empty')
  }
  return value
}

const optionalString = (value: unknown, path: string): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  return requiredString(value, path)
}

const optionalPort = (value: unknown, path: string): number | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    return fail(path, 'must be an integer between 1 and 65535')
  }
  return value
}

const stringArray = (value: unknown, path: string): string[] | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    return fail(path, 'must be an array of strings')
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      return fail(`${path}.${index}`, 'must be a string')
    }
    return entry
  })
}

const stringMap = (value: unknown, path: string): Record<string, string> | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (!isObject(value)) {
    return fail(path, 'must be an object whose values are strings')
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry !== 'string') {
        return fail(`${path}.${key}`, 'must be a string')
      }
      return [key, entry]
    })
  )
}

const aliasedValue = (value: Record<string, unknown>, aliases: { camel: string; snake: string }, path: string): unknown => {
  const { camel, snake } = aliases
  if (value[camel] !== undefined && value[snake] !== undefined) {
    fail(`${path}.${camel}`, `must not be specified together with ${snake}`)
  }
  return value[camel] ?? value[snake]
}

const parseOAuth = (value: unknown, path: string): OAuthConfig | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (!isObject(value)) {
    return fail(path, 'must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!OAUTH_FIELDS.has(key)) {
      fail(`${path}.${key}`, 'is not supported')
    }
  }

  const clientId = optionalString(aliasedValue(value, { camel: 'clientId', snake: 'client_id' }, path), `${path}.clientId`)
  const clientName = optionalString(aliasedValue(value, { camel: 'clientName', snake: 'client_name' }, path), `${path}.clientName`)
  const clientSecret = optionalString(aliasedValue(value, { camel: 'clientSecret', snake: 'client_secret' }, path), `${path}.clientSecret`)
  const scope = optionalString(value.scope, `${path}.scope`)
  const redirectUri = optionalString(aliasedValue(value, { camel: 'redirectUri', snake: 'redirect_uri' }, path), `${path}.redirectUri`)
  const callbackPort = optionalPort(aliasedValue(value, { camel: 'callbackPort', snake: 'callback_port' }, path), `${path}.callbackPort`)

  return {
    ...(clientId === undefined ? {} : { clientId }),
    ...(clientName === undefined ? {} : { clientName }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(scope === undefined ? {} : { scope }),
    ...(callbackPort === undefined ? {} : { callbackPort }),
    ...(redirectUri === undefined ? {} : { redirectUri }),
  }
}

const validateServerFields = (path: string, value: Record<string, unknown>): void => {
  for (const key of Object.keys(value)) {
    if (!SERVER_FIELDS.has(key)) {
      fail(`${path}.${key}`, 'is not supported')
    }
  }
}

const parseDisabledOnlyServer = (path: string, value: Record<string, unknown>): DisabledServerConfig => {
  for (const field of ['type', 'args', 'env', 'cwd', 'headers', 'oauth'] as const) {
    if (value[field] !== undefined) {
      fail(`${path}.${field}`, 'requires a command or url transport')
    }
  }
  return { disabled: true } satisfies DisabledServerConfig
}

const parseStdioServer = (path: string, value: Record<string, unknown>, disabled: boolean | undefined): StdioServerConfig => {
  if (value.type !== undefined && value.type !== 'stdio') {
    fail(`${path}.type`, 'must be "stdio" when command is configured')
  }
  for (const field of ['headers', 'oauth'] as const) {
    if (value[field] !== undefined) {
      fail(`${path}.${field}`, 'is only supported for url servers')
    }
  }

  const server: StdioServerConfig = {
    command: requiredString(value.command, `${path}.command`),
    type: 'stdio',
  }
  const args = stringArray(value.args, `${path}.args`)
  const env = stringMap(value.env, `${path}.env`)
  const cwd = optionalString(value.cwd, `${path}.cwd`)
  if (args !== undefined) {
    server.args = args
  }
  if (env !== undefined) {
    server.env = env
  }
  if (cwd !== undefined) {
    server.cwd = cwd
  }
  if (disabled !== undefined) {
    server.disabled = disabled
  }
  return server
}

const parseHttpServer = (path: string, value: Record<string, unknown>, disabled: boolean | undefined): HttpServerConfig => {
  if (value.type !== undefined && value.type !== 'http') {
    fail(`${path}.type`, 'must be "http" when url is configured')
  }
  for (const field of ['args', 'env', 'cwd'] as const) {
    if (value[field] !== undefined) {
      fail(`${path}.${field}`, 'is only supported for command servers')
    }
  }

  const server: HttpServerConfig = {
    type: 'http',
    url: requiredString(value.url, `${path}.url`),
  }
  const headers = stringMap(value.headers, `${path}.headers`)
  const oauth = parseOAuth(value.oauth, `${path}.oauth`)
  if (headers !== undefined) {
    server.headers = headers
  }
  if (oauth !== undefined) {
    server.oauth = oauth
  }
  if (disabled !== undefined) {
    server.disabled = disabled
  }
  return server
}

const parseServer = (name: string, value: unknown): McpServerConfig => {
  const path = `mcpServers.${name}`
  if (!isObject(value)) {
    return fail(path, 'must be an object')
  }
  validateServerFields(path, value)

  const disabled = optionalBoolean(value.disabled, `${path}.disabled`)
  const hasCommand = value.command !== undefined
  const hasUrl = value.url !== undefined
  if (hasCommand && hasUrl) {
    fail(path, 'must specify exactly one of command or url')
  }
  if (!hasCommand && !hasUrl) {
    if (!isTrue(disabled)) {
      fail(path, 'must specify exactly one of command or url')
    }
    return parseDisabledOnlyServer(path, value)
  }

  if (value.type !== undefined && value.type !== 'stdio' && value.type !== 'http') {
    fail(`${path}.type`, 'must be either "stdio" or "http"')
  }

  return hasCommand ? parseStdioServer(path, value, disabled) : parseHttpServer(path, value, disabled)
}

/** Validate a parsed standard MCP configuration while isolating malformed server entries. */
export const parseMcpConfig = (value: unknown): McpServerMap => {
  if (!isObject(value)) {
    return fail('mcpServers', 'configuration root must be an object')
  }
  if (!isObject(value.mcpServers)) {
    return fail('mcpServers', 'must be an object')
  }

  return Object.fromEntries(
    Object.entries(value.mcpServers).map(([name, server]) => {
      try {
        if (isEmptyString(name)) {
          fail('mcpServers', 'server names must not be empty')
        }
        return [name, parseServer(name, server)]
      } catch (error) {
        if (error instanceof McpConfigError) {
          return [name, { invalid: true } satisfies InvalidServerConfig]
        }
        throw error
      }
    })
  )
}

/** Effect boundary for callers that want typed configuration failures without changing legacy error text. */
export const parseMcpConfigEffect = (value: unknown): Effect.Effect<McpServerMap, McpConfigError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      catch: (cause) =>
        cause instanceof McpConfigError ? cause : McpConfigError.from('mcpServers', cause instanceof Error ? cause.message : String(cause)),
      try: () => parseMcpConfig(value),
    })
    yield* Schema.decodeUnknownEffect(McpServerMapSchema, { onExcessProperty: 'error' })(parsed).pipe(
      Effect.mapError((cause) => McpConfigError.from('mcpServers', String(cause)))
    )
    return parsed
  })

/** Parse JSON text without adding JSONC or interpolation semantics. */
export const parseMcpConfigText: {
  (source: string): (text: string) => McpServerMap
  (text: string, source: string): McpServerMap
} = Function.dual(2, (text: string, source = 'MCP config'): McpServerMap => {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw McpConfigError.from(source, 'contains malformed JSON')
  }
  return parseMcpConfig(value)
})

/** Load an MCP file. This helper exists so tests never need to access the real home directory. */
export const loadMcpConfigFile = async (path: string): Promise<McpServerMap> => {
  try {
    return parseMcpConfigText(await readFile(path, 'utf8'), path)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

export const loadMcpConfigFileEffect = (path: string): Effect.Effect<McpServerMap, Cause.UnknownError> =>
  Effect.tryPromise(() => loadMcpConfigFile(path))

const globalMcpConfigPath = (): string => join(homedir(), '.config', 'mcp', 'mcp.json')

/** Load only the standard user-global MCP configuration. */
export const loadGlobalMcpConfig = (): Promise<McpServerMap> => loadMcpConfigFile(globalMcpConfigPath())
