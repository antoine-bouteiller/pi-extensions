import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialStore, OAuthCredentialPayload } from "./keychain.js";
import type { OAuthConfig } from "./types.js";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CALLBACK_PORT = 3334;

export type OpenUrl = (url: string, signal?: AbortSignal) => Promise<void>;

export interface OAuthCallback {
  redirectUrl: string;
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

export interface OAuthCallbackOptions {
  port: number;
  redirectUri?: string;
  expectedState: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function escaped(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}

function callbackUrl(options: OAuthCallbackOptions): { url: URL; bindHost: string } {
  const url = new URL(options.redirectUri ?? `http://localhost:${options.port}/callback`);
  if (url.protocol !== "http:") throw new Error("OAuth redirectUri must use http on loopback");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("OAuth redirectUri must use a loopback host");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("OAuth redirectUri must not contain credentials, a query, or a fragment");
  }
  const configuredPort = url.port ? Number(url.port) : 80;
  if (configuredPort !== options.port) {
    throw new Error("OAuth redirectUri port must match callbackPort");
  }
  return {
    url,
    bindHost: url.hostname === "::1" || url.hostname === "[::1]" ? "::1" : "127.0.0.1",
  };
}

/** Start a one-shot, loopback-only OAuth callback listener. */
export async function startOAuthCallback(options: OAuthCallbackOptions): Promise<OAuthCallback> {
  if (options.signal?.aborted) throw abortError("OAuth authentication was cancelled");
  const { url, bindHost } = callbackUrl(options);
  const timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS;
  let settled = false;
  let closePromise: Promise<void> | undefined;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Avoid an unhandled rejection when listener startup itself fails.
  void codePromise.catch(() => undefined);

  let server: Server;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (error?: Error, code?: string) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (error) rejectCode(error);
    else resolveCode(code!);
    void close();
  };

  server = createServer((request, response) => {
    let requested: URL;
    try {
      requested = new URL(request.url ?? "/", url.origin);
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid OAuth callback request");
      return;
    }
    if (request.method !== "GET" || requested.pathname !== url.pathname) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const state = requested.searchParams.get("state");
    if (state !== options.expectedState) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><title>OAuth error</title><p>Invalid OAuth state. Return to Pi and retry.</p>",
      );
      return;
    }

    const oauthError = requested.searchParams.get("error");
    if (oauthError) {
      const description = requested.searchParams.get("error_description");
      const message = `OAuth authorization failed: ${oauthError}${description ? ` (${description})` : ""}`;
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>OAuth error</title><p>${escaped(message)}</p>`);
      finish(new Error(message));
      return;
    }

    const code = requested.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>OAuth error</title><p>Missing authorization code.</p>");
      finish(new Error("OAuth callback did not include an authorization code"));
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>OAuth complete</title><p>Authentication succeeded. You can close this window and return to Pi.</p>",
    );
    finish(undefined, code);
  });

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    closePromise = !server.listening
      ? Promise.resolve()
      : new Promise<void>((resolve) => server.close(() => resolve()));
    return closePromise;
  }

  const onAbort = () => finish(abortError("OAuth authentication was cancelled"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  timer = setTimeout(
    () => finish(new Error("OAuth callback timed out after five minutes")),
    timeoutMs,
  );
  timer.unref?.();

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(options.port, bindHost);
    });
  } catch (error) {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    await close();
    const reason =
      error instanceof Error && "code" in error && error.code === "EADDRINUSE"
        ? `OAuth callback port ${options.port} is already in use`
        : "Could not start the OAuth callback listener";
    throw new Error(reason);
  }

  const address = server.address() as AddressInfo | null;
  if (!address) {
    await close();
    throw new Error("Could not determine the OAuth callback listener address");
  }

  return { redirectUrl: url.href, waitForCode: () => codePromise, close };
}

export interface KeychainOAuthProviderOptions {
  serverName: string;
  serverUrl: string;
  config: OAuthConfig;
  store: CredentialStore;
  interactive?: boolean;
  state?: string;
  openUrl?: OpenUrl;
  signal?: AbortSignal;
}

/** MCP SDK OAuth provider that persists only reusable tokens/registration data. */
export class KeychainOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  private verifier?: string;
  private discovery?: OAuthDiscoveryState;
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly options: KeychainOAuthProviderOptions) {
    const port = options.config.callbackPort ?? DEFAULT_CALLBACK_PORT;
    const { url } = callbackUrl({
      port,
      redirectUri: options.config.redirectUri,
      expectedState: options.state ?? "unused",
    });
    this.redirectUrl = url.href;
    this.clientMetadata = {
      redirect_uris: [this.redirectUrl],
      client_name: "Pi MCP Gateway",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: options.config.clientSecret ? "client_secret_post" : "none",
      ...(options.config.scope ? { scope: options.config.scope } : {}),
    };
  }

  state(): string {
    if (!this.options.interactive || !this.options.state) {
      throw new UnauthorizedError("OAuth authorization requires /mcp-auth <server>");
    }
    return this.options.state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.options.config.clientId) {
      return {
        client_id: this.options.config.clientId,
        ...(this.options.config.clientSecret
          ? { client_secret: this.options.config.clientSecret }
          : {}),
      };
    }
    return (await this.load())?.clientInformation as OAuthClientInformationMixed | undefined;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.update((credential) => ({
      serverUrl: this.options.serverUrl,
      ...credential,
      clientInformation: clientInformation as OAuthCredentialPayload["clientInformation"],
    }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load())?.tokens as OAuthTokens | undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update((credential) => ({
      serverUrl: this.options.serverUrl,
      ...credential,
      tokens: tokens as OAuthCredentialPayload["tokens"],
    }));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.options.interactive || !this.options.openUrl) {
      throw new UnauthorizedError("OAuth authorization is required; use /mcp-auth <server>");
    }
    await this.options.openUrl(authorizationUrl.href, this.options.signal);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier)
      throw new Error("OAuth PKCE verifier is unavailable; restart authentication");
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "verifier") {
      this.verifier = undefined;
      return;
    }
    if (scope === "discovery") {
      this.discovery = undefined;
      return;
    }
    if (scope === "all") {
      this.verifier = undefined;
      this.discovery = undefined;
      await this.options.store.delete(this.options.serverName);
      return;
    }
    await this.update((credential) => {
      const next = { ...credential, serverUrl: this.options.serverUrl };
      if (scope === "client") delete next.clientInformation;
      if (scope === "tokens") delete next.tokens;
      return next.tokens || next.clientInformation ? next : undefined;
    });
  }

  private load(): Promise<OAuthCredentialPayload | undefined> {
    return this.options.store.get(this.options.serverName, this.options.serverUrl);
  }

  private async update(
    updater: (current: OAuthCredentialPayload | undefined) => OAuthCredentialPayload | undefined,
  ): Promise<void> {
    let failure: unknown;
    this.mutation = this.mutation.then(async () => {
      try {
        const next = updater(await this.load());
        if (next) await this.options.store.set(this.options.serverName, next);
        else await this.options.store.delete(this.options.serverName);
      } catch (error) {
        failure = error;
      }
    });
    await this.mutation;
    if (failure) throw failure;
  }
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function oauthCallbackPort(config: OAuthConfig): number {
  return config.callbackPort ?? DEFAULT_CALLBACK_PORT;
}
