import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  DisabledServerConfig,
  HttpServerConfig,
  McpServerConfig,
  McpServerMap,
  OAuthConfig,
  StdioServerConfig,
} from "./types";

const SERVER_FIELDS = new Set([
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "oauth",
  "disabled",
]);
const OAUTH_FIELDS = new Set([
  "clientId",
  "client_id",
  "clientSecret",
  "client_secret",
  "scope",
  "callbackPort",
  "callback_port",
  "redirectUri",
  "redirect_uri",
]);

export class McpConfigError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "McpConfigError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(path: string, message: string): never {
  throw new McpConfigError(path, message);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length === 0) fail(path, "must not be empty");
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}

function stringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(path, "must be an array of strings");
  return value.map((entry, index) => {
    if (typeof entry !== "string") fail(`${path}.${index}`, "must be a string");
    return entry;
  });
}

function stringMap(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) fail(path, "must be an object whose values are strings");

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry !== "string") fail(`${path}.${key}`, "must be a string");
      return [key, entry];
    }),
  );
}

function aliasedValue(
  value: Record<string, unknown>,
  camel: string,
  snake: string,
  path: string,
): unknown {
  if (value[camel] !== undefined && value[snake] !== undefined) {
    fail(`${path}.${camel}`, `must not be specified together with ${snake}`);
  }
  return value[camel] ?? value[snake];
}

function parseOAuth(value: unknown, path: string): OAuthConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) fail(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!OAUTH_FIELDS.has(key)) fail(`${path}.${key}`, "is not supported");
  }

  const clientId = optionalString(
    aliasedValue(value, "clientId", "client_id", path),
    `${path}.clientId`,
  );
  const clientSecret = optionalString(
    aliasedValue(value, "clientSecret", "client_secret", path),
    `${path}.clientSecret`,
  );
  const scope = optionalString(value.scope, `${path}.scope`);
  const redirectUri = optionalString(
    aliasedValue(value, "redirectUri", "redirect_uri", path),
    `${path}.redirectUri`,
  );
  const rawCallbackPort = aliasedValue(value, "callbackPort", "callback_port", path);
  let callbackPort: number | undefined;
  if (rawCallbackPort !== undefined) {
    if (
      typeof rawCallbackPort !== "number" ||
      !Number.isInteger(rawCallbackPort) ||
      rawCallbackPort < 1 ||
      rawCallbackPort > 65_535
    ) {
      fail(`${path}.callbackPort`, "must be an integer between 1 and 65535");
    }
    callbackPort = rawCallbackPort;
  }

  return {
    ...(clientId === undefined ? {} : { clientId }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(scope === undefined ? {} : { scope }),
    ...(callbackPort === undefined ? {} : { callbackPort }),
    ...(redirectUri === undefined ? {} : { redirectUri }),
  };
}

function parseServer(name: string, value: unknown): McpServerConfig {
  const path = `mcpServers.${name}`;
  if (!isObject(value)) fail(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!SERVER_FIELDS.has(key)) fail(`${path}.${key}`, "is not supported");
  }

  const disabled = optionalBoolean(value.disabled, `${path}.disabled`);
  const hasCommand = value.command !== undefined;
  const hasUrl = value.url !== undefined;
  if (hasCommand && hasUrl) fail(path, "must specify exactly one of command or url");
  if (!hasCommand && !hasUrl) {
    if (disabled !== true) fail(path, "must specify exactly one of command or url");
    for (const field of ["type", "args", "env", "cwd", "headers", "oauth"] as const) {
      if (value[field] !== undefined) {
        fail(`${path}.${field}`, "requires a command or url transport");
      }
    }
    return { disabled: true } satisfies DisabledServerConfig;
  }

  if (value.type !== undefined && value.type !== "stdio" && value.type !== "http") {
    fail(`${path}.type`, 'must be either "stdio" or "http"');
  }

  if (hasCommand) {
    if (value.type !== undefined && value.type !== "stdio") {
      fail(`${path}.type`, 'must be "stdio" when command is configured');
    }
    for (const field of ["headers", "oauth"] as const) {
      if (value[field] !== undefined) fail(`${path}.${field}`, "is only supported for url servers");
    }

    const server: StdioServerConfig = {
      type: "stdio",
      command: requiredString(value.command, `${path}.command`),
    };
    const args = stringArray(value.args, `${path}.args`);
    const env = stringMap(value.env, `${path}.env`);
    const cwd = optionalString(value.cwd, `${path}.cwd`);
    if (args !== undefined) server.args = args;
    if (env !== undefined) server.env = env;
    if (cwd !== undefined) server.cwd = cwd;
    if (disabled !== undefined) server.disabled = disabled;
    return server;
  }

  if (value.type !== undefined && value.type !== "http") {
    fail(`${path}.type`, 'must be "http" when url is configured');
  }
  for (const field of ["args", "env", "cwd"] as const) {
    if (value[field] !== undefined)
      fail(`${path}.${field}`, "is only supported for command servers");
  }

  const server: HttpServerConfig = {
    type: "http",
    url: requiredString(value.url, `${path}.url`),
  };
  const headers = stringMap(value.headers, `${path}.headers`);
  const oauth = parseOAuth(value.oauth, `${path}.oauth`);
  if (headers !== undefined) server.headers = headers;
  if (oauth !== undefined) server.oauth = oauth;
  if (disabled !== undefined) server.disabled = disabled;
  return server;
}

/** Validate a parsed standard MCP configuration and return its stable server map. */
export function parseMcpConfig(value: unknown): McpServerMap {
  if (!isObject(value)) fail("mcpServers", "configuration root must be an object");
  if (!isObject(value.mcpServers)) fail("mcpServers", "must be an object");

  return Object.fromEntries(
    Object.entries(value.mcpServers).map(([name, server]) => {
      if (name.length === 0) fail("mcpServers", "server names must not be empty");
      return [name, parseServer(name, server)];
    }),
  );
}

/** Parse JSON text without adding JSONC or interpolation semantics. */
export function parseMcpConfigText(text: string, source = "MCP config"): McpServerMap {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new McpConfigError(source, "contains malformed JSON");
  }
  return parseMcpConfig(value);
}

/** Load an MCP file. This helper exists so tests never need to access the real home directory. */
export async function loadMcpConfigFile(path: string): Promise<McpServerMap> {
  try {
    return parseMcpConfigText(await readFile(path, "utf8"), path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export function globalMcpConfigPath(): string {
  return join(homedir(), ".config", "mcp", "mcp.json");
}

/** Load only the standard user-global MCP configuration. */
export function loadGlobalMcpConfig(): Promise<McpServerMap> {
  return loadMcpConfigFile(globalMcpConfigPath());
}
