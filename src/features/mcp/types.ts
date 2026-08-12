import { Data } from 'effect'

/** Every manager failure the gateway can observe, keeping the SDK's own error in `cause`. */
export class McpError extends Data.TaggedError('McpError')<{
  readonly cause?: unknown
  readonly message: string
}> {}

export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export type McpPolicyOperation = 'list' | 'search' | 'describe' | 'call'

export interface McpPolicyRequest {
  /** Configured MCP server name, before exposed-name sanitization. */
  server: string
  remoteName: string
  exposedName: string
  annotations: Readonly<McpToolAnnotations>
  operation: McpPolicyOperation
}

export interface McpGatewayPolicy {
  /** A short, non-sensitive label used in bounded denial errors. */
  name: string
  allows: (request: Readonly<McpPolicyRequest>) => boolean
}

export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'invalid-config'

export interface OAuthConfig {
  clientId?: string
  clientName?: string
  clientSecret?: string
  scope?: string
  callbackPort?: number
  redirectUri?: string
}

export interface StdioServerConfig {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  disabled?: boolean
}

export interface HttpServerConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
  oauth?: OAuthConfig
  disabled?: boolean
}

/** A disabled placeholder is allowed to omit its transport entirely. */
export interface DisabledServerConfig {
  type?: undefined
  disabled: true
}

/** Retains a malformed server entry so valid siblings can still be used. */
export interface InvalidServerConfig {
  type?: undefined
  invalid: true
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig | DisabledServerConfig | InvalidServerConfig
export type McpServerMap = Record<string, McpServerConfig>

// Short alias used by the connection manager and gateway.
export type ServerConfig = McpServerConfig
