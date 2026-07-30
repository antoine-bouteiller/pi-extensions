import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { boundGatewayOutput, type GatewayContent } from "./output.js";
import {
  KeychainCredentialError,
  createKeychainCredentialStore,
  type CredentialStore,
} from "./keychain.js";
import {
  KeychainOAuthProvider,
  createOAuthState,
  oauthCallbackPort,
  startOAuthCallback,
  type OpenUrl,
} from "./oauth.js";
import type { McpServerMap, McpServerStatus, ServerConfig } from "./types.js";

const CONNECT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;

interface ToolMetadata {
  name: string;
  server: string;
  remoteName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface ClientLike {
  connect(
    transport: Transport,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<void>;
  close(): Promise<void>;
  getInstructions(): string | undefined;
  listTools(
    params?: { cursor?: string },
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;
    nextCursor?: string;
  }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    schema: undefined,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<unknown>;
}

interface ConnectedServer {
  client: ClientLike;
  transport: Transport;
  tools: ToolMetadata[];
  instructions?: string;
}

interface AuthenticationRuntime {
  promise: Promise<void>;
  controller: AbortController;
  waiters: number;
}

interface ServerRuntime {
  name: string;
  config: ServerConfig;
  status: McpServerStatus;
  error?: string;
  connection?: ConnectedServer;
  connecting?: Promise<ConnectedServer>;
  connectingController?: AbortController;
  connectWaiters: number;
}

export interface McpManagerOptions {
  onStatusChange?: (
    statuses: ReadonlyArray<{ name: string; status: McpServerStatus; error?: string }>,
  ) => void;
  openUrl: OpenUrl;
  credentialStore?: CredentialStore;
  createClient?: (serverName: string) => ClientLike;
  createTransport?: (
    serverName: string,
    config: Exclude<ServerConfig, { type?: undefined }>,
    kind: "stdio" | "streamable-http" | "sse",
    authProvider?: OAuthClientProvider,
  ) => Transport;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

class PendingAuthorization extends Error {
  constructor(
    readonly client: ClientLike,
    readonly transport: Transport & { finishAuth?: (code: string) => Promise<void> },
  ) {
    super("OAuth authorization is required");
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeOperationError(error: unknown, operation: string, server: string): Error {
  if (isAbort(error)) {
    const cancelled = new Error(`MCP ${operation} was cancelled`);
    cancelled.name = "AbortError";
    return cancelled;
  }
  if (error instanceof KeychainCredentialError) {
    return new KeychainCredentialError(error.message.slice(0, 500));
  }
  if (isAuthorizationFailure(error)) {
    return new Error(
      `Authentication is required for MCP server ${JSON.stringify(server)}; run /mcp-auth ${server}.`,
    );
  }
  const message = errorMessage(error);
  if (
    /^(MCP tool-name collision|MCP server-name collision|MCP server .* repeated a tools cursor|OAuth callback|Could not start the OAuth callback|The MCP HTTP transport cannot|Invalid MCP search)/.test(
      message,
    )
  ) {
    return new Error(message.slice(0, 500));
  }
  return new Error(`MCP ${operation} failed for server ${JSON.stringify(server)}`);
}

function isSafeSearchRegex(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > 128 || /\\[1-9]/.test(pattern)) return false;
  // Accept only a fixed-width subset plus one `.*` wildcard. Excluding groups,
  // alternation, and other repetition keeps evaluation linear in candidate size.
  const remainder = pattern.replace(/\\./g, "").replace(/\[(?:\\.|[^\]\\])*\]/g, "");
  const wildcards = remainder.match(/\.\*/g)?.length ?? 0;
  return wildcards <= 1 && !/(?:[+*?{}()|]|\[|\])/.test(remainder.replace(".*", ""));
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted ||
    (error instanceof Error &&
      (error.name === "AbortError" || /cancelled|aborted/i.test(error.message))),
  );
}

function isAuthorizationFailure(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) ||
    (error instanceof Error &&
      /unauthori[sz]ed|mcp-auth|authentication is required/i.test(error.message))
  );
}

function isLegacyTransportCandidate(error: unknown): boolean {
  return (
    error instanceof StreamableHTTPError &&
    ((error.code !== undefined && [400, 404, 405, 406, 415].includes(error.code)) ||
      (error.code === -1 && /unexpected content type/i.test(error.message)))
  );
}

export function sanitizeToolPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized || "_";
}

function inheritedEnvironment(
  configured: Record<string, string> | undefined,
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[name] = value;
  }
  return { ...inherited, ...configured };
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0]!;
  return AbortSignal.any(present);
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function convertToolResult(result: unknown): { content: GatewayContent[]; isError: boolean } {
  if (typeof result !== "object" || result === null) {
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
  }
  const value = result as {
    isError?: boolean;
    content?: unknown[];
    structuredContent?: Record<string, unknown>;
    toolResult?: unknown;
  };
  if ("toolResult" in value && value.content === undefined) {
    return {
      content: [{ type: "text", text: JSON.stringify(value.toolResult, null, 2) }],
      isError: false,
    };
  }

  const converted: GatewayContent[] = [];
  for (const item of value.content ?? []) {
    if (typeof item !== "object" || item === null || !("type" in item)) continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      converted.push({ type: "text", text: block.text });
    } else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      converted.push({ type: "image", data: block.data, mimeType: block.mimeType });
    } else if (block.type === "resource" && typeof block.resource === "object" && block.resource) {
      const resource = block.resource as Record<string, unknown>;
      if (typeof resource.text === "string") {
        converted.push({ type: "text", text: resource.text });
      }
    }
  }
  if (value.structuredContent !== undefined) {
    converted.push({ type: "text", text: JSON.stringify(value.structuredContent, null, 2) });
  }
  return {
    content:
      converted.length > 0
        ? converted
        : [{ type: "text", text: "(MCP tool returned no supported content)" }],
    isError: value.isError === true,
  };
}

export class McpManager {
  private readonly runtimes = new Map<string, ServerRuntime>();
  private readonly lifecycle = new AbortController();
  private readonly credentialStore: CredentialStore;
  private readonly createClient: (serverName: string) => ClientLike;
  private readonly createTransport: NonNullable<McpManagerOptions["createTransport"]>;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly authentications = new Set<Promise<void>>();
  private readonly authenticationByServer = new Map<string, AuthenticationRuntime>();
  private closed = false;

  constructor(
    config: McpServerMap,
    private readonly options: McpManagerOptions,
  ) {
    this.credentialStore = options.credentialStore ?? createKeychainCredentialStore();
    this.createClient =
      options.createClient ??
      (() => new Client({ name: "pi-mcp-gateway", version: "1.0.0" }) as ClientLike);
    this.createTransport = options.createTransport ?? this.defaultTransport.bind(this);
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

    for (const [name, serverConfig] of Object.entries(config)) {
      this.runtimes.set(name, {
        name,
        config: serverConfig,
        status: serverConfig.disabled ? "disabled" : "disconnected",
        connectWaiters: 0,
      });
    }
  }

  status(): ReadonlyArray<{ name: string; status: McpServerStatus; error?: string }> {
    return [...this.runtimes.values()].map((runtime) => ({
      name: runtime.name,
      status: runtime.status,
      ...(runtime.error ? { error: runtime.error } : {}),
    }));
  }

  oauthServers(): readonly string[] {
    return [...this.runtimes.values()]
      .filter(
        (runtime) =>
          runtime.status !== "disabled" &&
          runtime.config.type === "http" &&
          runtime.config.oauth !== undefined,
      )
      .map((runtime) => runtime.name)
      .sort((left, right) => left.localeCompare(right));
  }

  async connect(server: string, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    const runtime = this.runtime(server);
    if (runtime.connection) return runtime.connection;
    if (!runtime.connecting) {
      runtime.status = "connecting";
      runtime.error = undefined;
      this.notify();
      runtime.connectingController = new AbortController();
      runtime.connecting = this.establish(
        runtime,
        undefined,
        false,
        runtime.connectingController.signal,
      )
        .then(async (connection) => {
          runtime.connection = connection;
          try {
            this.validateGlobalCollisions();
          } catch (error) {
            runtime.connection = undefined;
            await connection.client.close().catch(() => undefined);
            throw error;
          }
          runtime.status = "connected";
          runtime.error = undefined;
          this.notify();
          return connection;
        })
        .catch((error) => {
          const publicError = safeOperationError(error, "connection", runtime.name);
          runtime.status = isAuthorizationFailure(error) ? "needs-auth" : "failed";
          runtime.error = publicError.message;
          this.notify();
          throw publicError;
        })
        .finally(() => {
          runtime.connecting = undefined;
          runtime.connectingController = undefined;
        });
    }
    runtime.connectWaiters += 1;
    try {
      return await waitWithSignal(runtime.connecting, options.signal);
    } finally {
      runtime.connectWaiters -= 1;
      if (runtime.connectWaiters === 0 && !runtime.connection) {
        runtime.connectingController?.abort();
      }
    }
  }

  async list(
    server: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<readonly ToolMetadata[]> {
    const connection = (await this.connect(server, options)) as ConnectedServer;
    return connection.tools.map((tool) => ({ ...tool }));
  }

  async search(
    query: string,
    options: { server?: string; regex?: boolean; limit?: number; signal?: AbortSignal } = {},
  ): Promise<readonly ToolMetadata[]> {
    const runtimes = options.server
      ? [this.runtime(options.server)]
      : [...this.runtimes.values()].filter((runtime) => runtime.status !== "disabled");
    const settled = await Promise.allSettled(
      runtimes.map((runtime) => this.list(runtime.name, { signal: options.signal })),
    );
    const tools = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    if (tools.length === 0) {
      const firstFailure = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (firstFailure) throw firstFailure.reason;
    }

    let matches: ToolMetadata[];
    if (options.regex) {
      if (!isSafeSearchRegex(query)) {
        throw new Error(
          "Invalid MCP search regular expression: use at most 128 characters without lookarounds, backreferences, or quantified groups",
        );
      }
      let expression: RegExp;
      try {
        expression = new RegExp(query, "i");
      } catch (error) {
        throw new Error(`Invalid MCP search regular expression: ${errorMessage(error)}`);
      }
      matches = tools.filter((tool) =>
        expression.test(`${tool.name}\n${(tool.description ?? "").slice(0, 2048)}`),
      );
    } else {
      const needle = query.toLocaleLowerCase();
      matches = tools.filter((tool) =>
        `${tool.name}\n${(tool.description ?? "").slice(0, 2048)}`
          .toLocaleLowerCase()
          .includes(needle),
      );
    }
    return matches
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, options.limit ?? 30);
  }

  async describe(
    tool: string,
    options: { server?: string; signal?: AbortSignal } = {},
  ): Promise<ToolMetadata> {
    return { ...(await this.resolveTool(tool, options)) };
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    options: { server?: string; signal?: AbortSignal } = {},
  ): Promise<AgentToolResult<unknown>> {
    const metadata = await this.resolveTool(tool, options);
    const runtime = this.runtime(metadata.server);
    let result: unknown;
    try {
      result = await runtime.connection!.client.callTool(
        { name: metadata.remoteName, arguments: args },
        undefined,
        { signal: options.signal, timeout: this.requestTimeoutMs },
      );
    } catch (error) {
      throw safeOperationError(error, "tool call", metadata.server);
    }
    const converted = convertToolResult(result);
    const bounded = await boundGatewayOutput(converted.content);
    if (converted.isError) {
      const errorText = bounded.content
        .filter(
          (block): block is Extract<GatewayContent, { type: "text" }> => block.type === "text",
        )
        .map((block) => block.text)
        .join("\n")
        .trim();
      throw new Error(errorText || "The MCP tool reported an error");
    }
    return {
      content: bounded.content,
      details: {
        server: metadata.server,
        tool: metadata.name,
        ...bounded.details,
      },
    };
  }

  authenticate(server: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    let authentication = this.authenticationByServer.get(server);
    if (!authentication) {
      const controller = new AbortController();
      const promise = this.authenticateServer(server, { signal: controller.signal });
      authentication = { promise, controller, waiters: 0 };
      this.authentications.add(promise);
      this.authenticationByServer.set(server, authentication);
      void promise
        .finally(() => {
          this.authentications.delete(promise);
          if (this.authenticationByServer.get(server)?.promise === promise) {
            this.authenticationByServer.delete(server);
          }
        })
        .catch(() => undefined);
    }

    authentication.waiters += 1;
    return waitWithSignal(authentication.promise, options.signal).finally(() => {
      authentication.waiters -= 1;
      if (authentication.waiters === 0 && this.authenticationByServer.has(server)) {
        authentication.controller.abort();
      }
    });
  }

  private async authenticateServer(
    server: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const runtime = this.runtime(server);
    if (runtime.connecting) {
      try {
        await waitWithSignal(runtime.connecting, options.signal);
      } catch (error) {
        if (!isAuthorizationFailure(error) && runtime.status !== "needs-auth") throw error;
      }
    }
    if (runtime.config.type !== "http" || !runtime.config.oauth) {
      throw new Error(`MCP server ${JSON.stringify(server)} does not have OAuth configured`);
    }
    if (runtime.connection) return;

    const operation = new AbortController();
    const signal = combineSignals(this.lifecycle.signal, operation.signal, options.signal);
    const state = createOAuthState();
    const callback = await startOAuthCallback({
      port: oauthCallbackPort(runtime.config.oauth),
      redirectUri: runtime.config.oauth.redirectUri,
      expectedState: state,
      signal,
    });
    const provider = new KeychainOAuthProvider({
      serverName: runtime.name,
      serverUrl: runtime.config.url,
      config: runtime.config.oauth,
      store: this.credentialStore,
      interactive: true,
      state,
      openUrl: this.options.openUrl,
      signal,
    });

    runtime.status = "connecting";
    runtime.error = undefined;
    this.notify();
    let pending: PendingAuthorization | undefined;
    try {
      try {
        const connected = await this.establish(runtime, provider, true, signal);
        runtime.connection = connected;
        try {
          this.validateGlobalCollisions();
        } catch (error) {
          runtime.connection = undefined;
          await connected.client.close().catch(() => undefined);
          throw error;
        }
        runtime.status = "connected";
        this.notify();
        return;
      } catch (error) {
        if (!(error instanceof PendingAuthorization)) throw error;
        pending = error;
      }

      const code = await callback.waitForCode();
      if (!pending.transport.finishAuth) {
        throw new Error("The MCP HTTP transport cannot complete OAuth authorization");
      }
      await pending.transport.finishAuth(code);
      await pending.client.close().catch(() => undefined);
      pending = undefined;
      runtime.status = "disconnected";
      await this.connect(runtime.name, { signal });
    } catch (error) {
      const publicError = safeOperationError(error, "authentication", runtime.name);
      runtime.status = isAuthorizationFailure(error) ? "needs-auth" : "failed";
      runtime.error = publicError.message;
      this.notify();
      throw publicError;
    } finally {
      operation.abort();
      if (pending) await pending.client.close().catch(() => undefined);
      await callback.close();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifecycle.abort();
    const pendingConnections = [...this.runtimes.values()]
      .map((runtime) => runtime.connecting)
      .filter((connection): connection is Promise<ConnectedServer> => connection !== undefined);
    await Promise.allSettled([...pendingConnections, ...this.authentications]);
    const connections = [...this.runtimes.values()]
      .map((runtime) => runtime.connection)
      .filter((connection): connection is ConnectedServer => connection !== undefined);
    await Promise.allSettled(connections.map((connection) => connection.client.close()));
    for (const runtime of this.runtimes.values()) {
      runtime.connection = undefined;
      runtime.connecting = undefined;
      runtime.connectingController = undefined;
      runtime.connectWaiters = 0;
      runtime.error = undefined;
      runtime.status = runtime.config.disabled ? "disabled" : "disconnected";
    }
    this.notify();
  }

  private runtime(name: string): ServerRuntime {
    if (this.closed) throw new Error("MCP manager is closed");
    const runtime = this.runtimes.get(name);
    if (!runtime) throw new Error(`Unknown MCP server ${JSON.stringify(name)}`);
    if (runtime.status === "disabled")
      throw new Error(`MCP server ${JSON.stringify(name)} is disabled`);
    return runtime;
  }

  private async resolveTool(
    requested: string,
    options: { server?: string; signal?: AbortSignal },
  ): Promise<ToolMetadata> {
    if (options.server) {
      const tools = await this.list(options.server, { signal: options.signal });
      const matches = tools.filter(
        (tool) => tool.name === requested || tool.remoteName === requested,
      );
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) throw new Error(`Ambiguous MCP tool ${JSON.stringify(requested)}`);
      throw new Error(`MCP tool ${JSON.stringify(requested)} was not found on ${options.server}`);
    }

    const prefixed = [...this.runtimes.values()]
      .filter((runtime) => runtime.status !== "disabled")
      .map((runtime) => ({ runtime, prefix: `${sanitizeToolPart(runtime.name)}_` }))
      .filter(({ prefix }) => requested.startsWith(prefix))
      .sort((left, right) => right.prefix.length - left.prefix.length);
    if (prefixed.length > 0) {
      const longest = prefixed[0]!.prefix.length;
      const targets = prefixed.filter(({ prefix }) => prefix.length === longest);
      if (targets.length > 1) {
        throw new Error(`MCP server-name collision while resolving ${JSON.stringify(requested)}`);
      }
      const tools = await this.list(targets[0]!.runtime.name, { signal: options.signal });
      const match = tools.find((tool) => tool.name === requested);
      if (match) return match;
      throw new Error(`Unknown MCP tool ${JSON.stringify(requested)}`);
    }

    const all = await this.search("", { signal: options.signal, limit: Number.MAX_SAFE_INTEGER });
    const matches = all.filter((tool) => tool.name === requested || tool.remoteName === requested);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous MCP tool ${JSON.stringify(requested)}; use its exposed server-prefixed name`,
      );
    }
    throw new Error(`Unknown MCP tool ${JSON.stringify(requested)}`);
  }

  private async establish(
    runtime: ServerRuntime,
    overrideProvider?: OAuthClientProvider,
    retainAuthorization = false,
    overrideSignal?: AbortSignal,
  ): Promise<ConnectedServer> {
    if (runtime.config.type === undefined) throw new Error("Disabled MCP server has no transport");
    const timeout = AbortSignal.timeout(this.connectTimeoutMs);
    const signal = combineSignals(this.lifecycle.signal, timeout, overrideSignal);
    const provider =
      overrideProvider ??
      (runtime.config.type === "http" && runtime.config.oauth
        ? new KeychainOAuthProvider({
            serverName: runtime.name,
            serverUrl: runtime.config.url,
            config: runtime.config.oauth,
            store: this.credentialStore,
          })
        : undefined);

    if (runtime.config.type === "stdio") {
      return this.connectTransport(runtime, "stdio", provider, signal, retainAuthorization);
    }

    try {
      return await this.connectTransport(
        runtime,
        "streamable-http",
        provider,
        signal,
        retainAuthorization,
      );
    } catch (error) {
      if (
        error instanceof PendingAuthorization ||
        isAbort(error, signal) ||
        !isLegacyTransportCandidate(error)
      ) {
        throw error;
      }
      return this.connectTransport(runtime, "sse", provider, signal, retainAuthorization);
    }
  }

  private async connectTransport(
    runtime: ServerRuntime,
    kind: "stdio" | "streamable-http" | "sse",
    provider: OAuthClientProvider | undefined,
    signal: AbortSignal,
    retainAuthorization: boolean,
  ): Promise<ConnectedServer> {
    if (runtime.config.type === undefined) throw new Error("Disabled MCP server has no transport");
    const client = this.createClient(runtime.name);
    const transport = this.createTransport(runtime.name, runtime.config, kind, provider);
    try {
      await waitWithSignal(
        client.connect(transport, { signal, timeout: this.connectTimeoutMs }),
        signal,
      );
      const tools = await this.loadTools(runtime.name, client, signal);
      return { client, transport, tools, instructions: client.getInstructions() };
    } catch (error) {
      if (retainAuthorization && isAuthorizationFailure(error)) {
        throw new PendingAuthorization(
          client,
          transport as Transport & { finishAuth?: (code: string) => Promise<void> },
        );
      }
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async loadTools(
    server: string,
    client: ClientLike,
    signal: AbortSignal,
  ): Promise<ToolMetadata[]> {
    const tools: ToolMetadata[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (cursor) {
        if (cursors.has(cursor)) throw new Error(`MCP server ${server} repeated a tools cursor`);
        cursors.add(cursor);
      }
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        signal,
        timeout: this.requestTimeoutMs,
      });
      for (const tool of page.tools) {
        const name = `${sanitizeToolPart(server)}_${sanitizeToolPart(tool.name)}`;
        if (names.has(name)) {
          throw new Error(`MCP tool-name collision on ${server}: ${JSON.stringify(name)}`);
        }
        names.add(name);
        tools.push({
          name,
          server,
          remoteName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  private validateGlobalCollisions(): void {
    const names = new Map<string, string>();
    for (const runtime of this.runtimes.values()) {
      for (const tool of runtime.connection?.tools ?? []) {
        const previous = names.get(tool.name);
        if (previous && previous !== runtime.name) {
          throw new Error(
            `MCP tool-name collision: servers ${JSON.stringify(previous)} and ${JSON.stringify(runtime.name)} both expose ${JSON.stringify(tool.name)}`,
          );
        }
        names.set(tool.name, runtime.name);
      }
    }
  }

  private notify(): void {
    this.options.onStatusChange?.(this.status());
  }

  private defaultTransport(
    _serverName: string,
    config: Exclude<ServerConfig, { type?: undefined }>,
    kind: "stdio" | "streamable-http" | "sse",
    authProvider?: OAuthClientProvider,
  ): Transport {
    if (kind === "stdio" && config.type === "stdio") {
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: inheritedEnvironment(config.env),
        stderr: "ignore",
      });
    }
    if (config.type !== "http") throw new Error(`Cannot use ${kind} for a stdio server`);
    const requestInit: RequestInit = { headers: new Headers(config.headers) };
    if (kind === "streamable-http") {
      return new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider,
        requestInit,
      });
    }
    return new SSEClientTransport(new URL(config.url), {
      authProvider,
      requestInit,
    });
  }
}
