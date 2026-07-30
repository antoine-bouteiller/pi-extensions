import { createHash } from "node:crypto";

export const MCP_OAUTH_KEYCHAIN_SERVICE = "pi-mcp.oauth";

/** A bounded, redacted message that is safe to surface to the user/model. */
export class KeychainCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainCredentialError";
  }
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export interface OAuthTokens extends JsonObject {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface OAuthClientInformation extends JsonObject {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  registration_access_token?: string;
  registration_client_uri?: string;
  token_endpoint_auth_method?: string;
}

export interface OAuthCredentialPayload {
  serverUrl: string;
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformation;
}

/** Async boundary consumed by the OAuth provider; tests can supply an in-memory store. */
export interface CredentialStore {
  get(serverName: string, serverUrl: string): Promise<OAuthCredentialPayload | undefined>;
  set(serverName: string, credential: OAuthCredentialPayload): Promise<void>;
  delete(serverName: string): Promise<void>;
}

interface KeyringEntry {
  getPassword(): string | null | Promise<string | null>;
  setPassword(password: string): void | Promise<void>;
  deletePassword(): void | Promise<void>;
}

interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
}

type KeyringLoader = () => Promise<KeyringModule>;

export interface KeychainCredentialStoreOptions {
  serviceName?: string;
  loadKeyring?: KeyringLoader;
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["boolean", "string"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function malformed(serverName: string): Error {
  return new KeychainCredentialError(
    `Stored OAuth credential for MCP server ${JSON.stringify(serverName)} is malformed; ` +
      "delete it and authenticate again.",
  );
}

function requireString(value: Record<string, unknown>, field: string, serverName: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) throw malformed(serverName);
  return result;
}

function optionalString(value: Record<string, unknown>, field: string, serverName: string): void {
  if (value[field] !== undefined && typeof value[field] !== "string") throw malformed(serverName);
}

function optionalNumber(value: Record<string, unknown>, field: string, serverName: string): void {
  if (
    value[field] !== undefined &&
    (typeof value[field] !== "number" || !Number.isFinite(value[field]))
  ) {
    throw malformed(serverName);
  }
}

function validateTokens(value: unknown, serverName: string): OAuthTokens {
  if (!isObject(value) || !isJsonValue(value)) throw malformed(serverName);
  requireString(value, "access_token", serverName);
  requireString(value, "token_type", serverName);
  optionalString(value, "refresh_token", serverName);
  optionalString(value, "scope", serverName);
  optionalNumber(value, "expires_in", serverName);
  return value as OAuthTokens;
}

function validateClientInformation(value: unknown, serverName: string): OAuthClientInformation {
  if (!isObject(value) || !isJsonValue(value)) throw malformed(serverName);
  requireString(value, "client_id", serverName);
  for (const field of [
    "client_secret",
    "registration_access_token",
    "registration_client_uri",
    "token_endpoint_auth_method",
  ]) {
    optionalString(value, field, serverName);
  }
  optionalNumber(value, "client_id_issued_at", serverName);
  optionalNumber(value, "client_secret_expires_at", serverName);
  return value as OAuthClientInformation;
}

export function validateCredentialPayload(
  value: unknown,
  serverName: string,
): OAuthCredentialPayload {
  if (!isObject(value)) throw malformed(serverName);
  for (const field of Object.keys(value)) {
    if (!new Set(["serverUrl", "tokens", "clientInformation"]).has(field)) {
      throw malformed(serverName);
    }
  }

  const serverUrl = requireString(value, "serverUrl", serverName);
  const tokens = value.tokens === undefined ? undefined : validateTokens(value.tokens, serverName);
  const clientInformation =
    value.clientInformation === undefined
      ? undefined
      : validateClientInformation(value.clientInformation, serverName);
  if (tokens === undefined && clientInformation === undefined) throw malformed(serverName);

  return {
    serverUrl,
    ...(tokens === undefined ? {} : { tokens }),
    ...(clientInformation === undefined ? {} : { clientInformation }),
  };
}

export function keychainAccount(serverName: string): string {
  return createHash("sha256").update(serverName, "utf8").digest("hex");
}

function isMissingCredential(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  const message =
    "message" in error && typeof error.message === "string" ? error.message.toLowerCase() : "";
  return (
    /no.?entry|not.?found/i.test(code) ||
    /no.?entry|not.?found/i.test(name) ||
    message.includes("no entry") ||
    message.includes("no matching entry") ||
    message.includes("item not found")
  );
}

function operationError(operation: string, serverName: string): Error {
  return new KeychainCredentialError(
    `macOS Keychain OAuth credential ${operation} failed for MCP server ` +
      `${JSON.stringify(serverName)}. Ensure Keychain is available and unlocked, then retry.`,
  );
}

async function loadProductionKeyring(): Promise<KeyringModule> {
  // Keep this specifier indirect so merely loading the MCP extension does not initialize
  // the native keyring package (and so the package can be installed in the dependency step).
  const packageName = "@napi-rs/keyring";
  return (await import(packageName)) as KeyringModule;
}

export class KeychainCredentialStore implements CredentialStore {
  readonly serviceName: string;
  private readonly loadKeyring: KeyringLoader;

  constructor(options: KeychainCredentialStoreOptions = {}) {
    this.serviceName = options.serviceName ?? MCP_OAUTH_KEYCHAIN_SERVICE;
    this.loadKeyring = options.loadKeyring ?? loadProductionKeyring;
  }

  private async entry(serverName: string): Promise<KeyringEntry> {
    const keyring = await this.loadKeyring();
    return new keyring.Entry(this.serviceName, keychainAccount(serverName));
  }

  async get(serverName: string, serverUrl: string): Promise<OAuthCredentialPayload | undefined> {
    let serialized: string | null;
    try {
      serialized = await (await this.entry(serverName)).getPassword();
    } catch (error) {
      if (isMissingCredential(error)) return undefined;
      throw operationError("lookup", serverName);
    }
    if (serialized === null) return undefined;
    if (typeof serialized !== "string") throw malformed(serverName);

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch {
      throw malformed(serverName);
    }
    const credential = validateCredentialPayload(parsed, serverName);
    return credential.serverUrl === serverUrl ? credential : undefined;
  }

  async set(serverName: string, credential: OAuthCredentialPayload): Promise<void> {
    const validated = validateCredentialPayload(credential, serverName);
    try {
      await (await this.entry(serverName)).setPassword(JSON.stringify(validated));
    } catch {
      throw operationError("write", serverName);
    }
  }

  async delete(serverName: string): Promise<void> {
    try {
      await (await this.entry(serverName)).deletePassword();
    } catch (error) {
      if (isMissingCredential(error)) return;
      throw operationError("deletion", serverName);
    }
  }
}

export function createKeychainCredentialStore(
  options: KeychainCredentialStoreOptions = {},
): CredentialStore {
  return new KeychainCredentialStore(options);
}
