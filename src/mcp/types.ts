export type McpServerStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "needs-auth"
  | "failed"
  | "disabled";

export interface OAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  callbackPort?: number;
  redirectUri?: string;
}

export interface StdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

export interface HttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  oauth?: OAuthConfig;
  disabled?: boolean;
}

/** A disabled placeholder is allowed to omit its transport entirely. */
export interface DisabledServerConfig {
  type?: undefined;
  disabled: true;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig | DisabledServerConfig;
export type McpServerMap = Record<string, McpServerConfig>;

// Short aliases used by the connection manager and gateway.
export type ServerConfig = McpServerConfig;
export type ServerMap = McpServerMap;
export type ConnectionStatus = McpServerStatus;
