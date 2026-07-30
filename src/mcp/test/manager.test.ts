import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeychainCredentialError, type CredentialStore } from "../keychain.js";
import { McpManager } from "../manager.js";

class FakeTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  closed = 0;
  constructor(
    readonly kind: "stdio" | "streamable-http" | "sse",
    readonly provider?: OAuthClientProvider,
    public finish?: (code: string) => void,
  ) {}
  async start() {}
  async send(_message: JSONRPCMessage) {}
  async close() {
    this.closed += 1;
  }
  async finishAuth(code: string) {
    this.finish?.(code);
  }
}

interface FakePage {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
  nextCursor?: string;
}

function harness(
  options: {
    config?: Record<string, any>;
    pages?: Record<string, FakePage>;
    connect?: (transport: FakeTransport, provider?: OAuthClientProvider) => Promise<void>;
    call?: (params: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
    callResult?: unknown;
    openUrl?: (url: string, signal?: AbortSignal) => Promise<void>;
    credentialStore?: CredentialStore;
  } = {},
) {
  const calls = {
    clients: 0,
    connects: [] as string[],
    lists: [] as Array<string | undefined>,
    toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
    closes: 0,
    transports: [] as FakeTransport[],
    keychainReads: 0,
  };
  const pages = options.pages ?? {
    root: {
      tools: [
        {
          name: "echo",
          description: "Echo text",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    },
  };

  const manager = new McpManager(
    options.config ?? { local: { type: "stdio", command: "fixture" } },
    {
      openUrl: options.openUrl ?? (async () => undefined),
      credentialStore: options.credentialStore ?? {
        async get() {
          calls.keychainReads += 1;
          return undefined;
        },
        async set() {},
        async delete() {},
      },
      createTransport(_name, _config, kind, provider) {
        const transport = new FakeTransport(kind, provider);
        calls.transports.push(transport);
        return transport as any;
      },
      createClient() {
        calls.clients += 1;
        return {
          async connect(transport: FakeTransport) {
            calls.connects.push(transport.kind);
            await options.connect?.(transport, transport.provider);
          },
          async close() {
            calls.closes += 1;
          },
          getInstructions() {
            return "fixture instructions";
          },
          async listTools(params?: { cursor?: string }) {
            calls.lists.push(params?.cursor);
            return pages[params?.cursor ?? "root"]!;
          },
          async callTool(params: { name: string; arguments: Record<string, unknown> }) {
            calls.toolCalls.push(params);
            if (options.call) return options.call(params);
            return options.callResult ?? { content: [{ type: "text", text: "ok" }] };
          },
        } as any;
      },
    },
  );
  return { manager, calls };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("MCP manager", () => {
  test("construction and status are metadata-only", () => {
    const fixture = harness({
      config: {
        local: { type: "stdio", command: "fixture" },
        remote: { type: "http", url: "https://example.test/mcp", oauth: {} },
        off: { disabled: true },
      },
    });

    expect(fixture.manager.status()).toEqual([
      { name: "local", status: "disconnected" },
      { name: "remote", status: "disconnected" },
      { name: "off", status: "disabled" },
    ]);
    expect(fixture.manager.oauthServers()).toEqual(["remote"]);
    expect(fixture.calls.clients).toBe(0);
    expect(fixture.calls.connects).toEqual([]);
    expect(fixture.calls.keychainReads).toBe(0);
  });

  test("the first concurrent list shares one lazy stdio connection", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = harness({ connect: async () => gate });

    const first = fixture.manager.list("local");
    const second = fixture.manager.list("local");
    await Promise.resolve();
    expect(fixture.calls.clients).toBe(1);
    release();

    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two);
    expect(fixture.calls.connects).toEqual(["stdio"]);
    expect(fixture.calls.lists).toEqual([undefined]);
  });

  test("falls back from compatible Streamable HTTP failures only", async () => {
    for (const fallbackError of [
      new StreamableHTTPError(405, "method not allowed"),
      new StreamableHTTPError(-1, "Unexpected content type: text/event-stream"),
    ]) {
      const fixture = harness({
        config: { remote: { type: "http", url: "https://example.test/mcp" } },
        connect: async (transport) => {
          if (transport.kind === "streamable-http") throw fallbackError;
        },
      });
      await fixture.manager.list("remote");
      expect(fixture.calls.connects).toEqual(["streamable-http", "sse"]);
    }

    for (const error of [new UnauthorizedError(), new StreamableHTTPError(500, "broken")]) {
      const blocked = harness({
        config: { remote: { type: "http", url: "https://example.test/mcp" } },
        connect: async () => {
          throw error;
        },
      });
      await expect(blocked.manager.list("remote")).rejects.toThrow();
      expect(blocked.calls.connects).toEqual(["streamable-http"]);
    }
  });

  test("loads every page, sanitizes names, searches, describes, and calls scoped tools", async () => {
    const fixture = harness({
      config: { "my server": { type: "stdio", command: "fixture" } },
      pages: {
        root: {
          tools: [{ name: "first.tool", description: "Alpha", inputSchema: { type: "object" } }],
          nextCursor: "two",
        },
        two: {
          tools: [{ name: "second-tool", description: "Beta", inputSchema: { type: "object" } }],
        },
      },
      callResult: {
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "AA==", mimeType: "image/png" },
          { type: "resource", resource: { uri: "x://one", text: "embedded" } },
        ],
        structuredContent: { answer: 42 },
      },
    });

    const listed = await fixture.manager.list("my server");
    expect(listed.map((tool) => tool.name)).toEqual([
      "my_server_first_tool",
      "my_server_second-tool",
    ]);
    expect(fixture.calls.lists).toEqual([undefined, "two"]);
    expect((await fixture.manager.search("beta"))[0]?.name).toBe("my_server_second-tool");
    expect((await fixture.manager.describe("my_server_first_tool")).remoteName).toBe("first.tool");

    const result = await fixture.manager.call(
      "second-tool",
      { value: true },
      { server: "my server" },
    );
    expect(fixture.calls.toolCalls).toEqual([{ name: "second-tool", arguments: { value: true } }]);
    expect(result.content).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "text", text: "embedded" },
      { type: "text", text: '{\n  "answer": 42\n}' },
    ]);
  });

  test("reports sanitized collisions, repeated cursors, invalid regex, and MCP errors", async () => {
    const collision = harness({
      pages: {
        root: {
          tools: [
            { name: "a.b", inputSchema: { type: "object" } },
            { name: "a_b", inputSchema: { type: "object" } },
          ],
        },
      },
    });
    await expect(collision.manager.list("local")).rejects.toThrow("collision");

    const cursor = harness({
      pages: {
        root: { tools: [], nextCursor: "again" },
        again: { tools: [], nextCursor: "again" },
      },
    });
    await expect(cursor.manager.list("local")).rejects.toThrow("repeated a tools cursor");

    const regex = harness();
    for (const unsafe of ["[", "a*a*a*a*a*a*a*a*b", "(a+)+$"]) {
      await expect(regex.manager.search(unsafe, { regex: true })).rejects.toThrow(
        "regular expression",
      );
    }

    const toolError = harness({
      callResult: { isError: true, content: [{ type: "text", text: "remote failed" }] },
    });
    await expect(toolError.manager.call("local_echo", {})).rejects.toThrow("remote failed");

    const oversizedError = harness({
      callResult: {
        isError: true,
        content: [{ type: "text", text: "x".repeat(DEFAULT_MAX_BYTES * 2) }],
      },
    });
    try {
      await oversizedError.manager.call("local_echo", {});
      throw new Error("expected oversized MCP error");
    } catch (error) {
      const message = (error as Error).message;
      expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(message).toContain("Full output saved to:");
    }
  });

  test("completes an explicit callback-driven OAuth flow and reconnects", async () => {
    const port = await freePort();
    let authorized = false;
    const opened: string[] = [];
    const fixture = harness({
      config: {
        slack: {
          type: "http",
          url: "https://mcp.slack.test/mcp",
          oauth: { clientId: "client", callbackPort: port },
        },
      },
      openUrl: async (authorizationUrl) => {
        opened.push(authorizationUrl);
        const state = new URL(authorizationUrl).searchParams.get("state");
        void fetch(`http://localhost:${port}/callback?code=oauth-code&state=${state}`);
      },
      connect: async (transport, provider) => {
        if (authorized) return;
        if (!provider) throw new Error("provider missing");
        provider.saveCodeVerifier("verifier");
        const state = await provider.state?.();
        await provider.redirectToAuthorization(
          new URL(`https://auth.test/start?state=${encodeURIComponent(state ?? "")}`),
        );
        transport.finish = (code: string) => {
          expect(code).toBe("oauth-code");
          authorized = true;
        };
        throw new UnauthorizedError();
      },
    });

    await fixture.manager.authenticate("slack");
    expect(opened).toHaveLength(1);
    expect(fixture.manager.status()[0]?.status).toBe("connected");
    expect(fixture.calls.connects).toEqual(["streamable-http", "streamable-http"]);
  });

  test("keeps shared OAuth alive while another authentication waiter remains", async () => {
    const port = await freePort();
    let authorized = false;
    let openedUrl = "";
    let signalBrowserOpened!: () => void;
    const browserOpened = new Promise<void>((resolve) => {
      signalBrowserOpened = resolve;
    });
    const fixture = harness({
      config: {
        slack: {
          type: "http",
          url: "https://mcp.slack.test/mcp",
          oauth: { clientId: "client", callbackPort: port },
        },
      },
      openUrl: async (authorizationUrl) => {
        openedUrl = authorizationUrl;
        signalBrowserOpened();
      },
      connect: async (transport, provider) => {
        if (authorized) return;
        const state = await provider?.state?.();
        await provider?.redirectToAuthorization(
          new URL(`https://auth.test/start?state=${encodeURIComponent(state ?? "")}`),
        );
        transport.finish = () => {
          authorized = true;
        };
        throw new UnauthorizedError();
      },
    });

    const firstController = new AbortController();
    const first = fixture.manager.authenticate("slack", { signal: firstController.signal }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await browserOpened;
    const second = fixture.manager.authenticate("slack");
    firstController.abort();
    const state = new URL(openedUrl).searchParams.get("state");
    await fetch(`http://localhost:${port}/callback?code=oauth-code&state=${state}`);

    expect(await first).toBeInstanceOf(Error);
    await second;
    expect(fixture.manager.status()[0]?.status).toBe("connected");
    expect(fixture.calls.connects).toEqual(["streamable-http", "streamable-http"]);
  });

  test("closes a directly authenticated connection when exposed names collide", async () => {
    const port = await freePort();
    const fixture = harness({
      config: {
        "same.name": { type: "stdio", command: "fixture" },
        same_name: {
          type: "http",
          url: "https://mcp.example.test/mcp",
          oauth: { clientId: "client", callbackPort: port },
        },
      },
    });
    await fixture.manager.connect("same.name");
    await expect(fixture.manager.authenticate("same_name")).rejects.toThrow("collision");
    expect(fixture.manager.status().find((server) => server.name === "same_name")?.status).toBe(
      "failed",
    );
    expect(fixture.calls.closes).toBe(1);
  });

  test("uses the real SDK over stdio and terminates the fixture on close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-mcp-manager-test-"));
    const marker = join(directory, "pid");
    const fixturePath = fileURLToPath(new URL("./fixtures/stdio-fixture.ts", import.meta.url));
    const manager = new McpManager(
      {
        fixture: {
          type: "stdio",
          command: process.execPath,
          args: [fixturePath],
          env: { PI_MCP_FIXTURE_PID: marker },
        },
      },
      { openUrl: async () => undefined },
    );

    const tools = await manager.list("fixture");
    expect(tools.map((tool) => tool.name)).toEqual(["fixture_echo_fixture"]);
    const result = await manager.call("fixture_echo_fixture", { value: "hello" });
    expect(result.content[0]).toEqual({ type: "text", text: "fixture:hello" });
    const pid = Number(await readFile(marker, "utf8"));

    await manager.close();
    await Bun.sleep(20);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("redacts transport and SDK request errors from status and callers", async () => {
    const transport = harness({
      config: { remote: { type: "http", url: "https://example.test/mcp" } },
      connect: async () => {
        throw new StreamableHTTPError(500, "response leaked bearer secret-token");
      },
    });
    await expect(transport.manager.connect("remote")).rejects.not.toThrow("secret-token");
    expect(JSON.stringify(transport.manager.status())).not.toContain("secret-token");

    const request = harness({
      call: async () => {
        throw new Error("SDK failure leaked client_secret=secret-token");
      },
    });
    await expect(request.manager.call("local_echo", {})).rejects.not.toThrow("secret-token");

    const keychain = harness({
      config: {
        remote: { type: "http", url: "https://example.test/mcp", oauth: {} },
      },
      credentialStore: {
        async get() {
          throw new KeychainCredentialError(
            "macOS Keychain lookup failed. Ensure Keychain is available and unlocked, then retry.",
          );
        },
        async set() {},
        async delete() {},
      },
      connect: async (_transport, provider) => {
        await provider?.tokens();
      },
    });
    await expect(keychain.manager.connect("remote")).rejects.toThrow(
      "Ensure Keychain is available and unlocked",
    );
  });

  test("cancelling the sole connection waiter aborts and closes the shared attempt", async () => {
    const fixture = harness({ connect: () => new Promise<void>(() => undefined) });
    const controller = new AbortController();
    const connecting = fixture.manager.connect("local", { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(connecting).rejects.toThrow();
    await Bun.sleep(0);
    expect(fixture.calls.closes).toBe(1);
  });

  test("close aborts and awaits an in-flight connection", async () => {
    const fixture = harness({ connect: () => new Promise<void>(() => undefined) });
    const connecting = fixture.manager.connect("local");
    await Promise.resolve();
    await fixture.manager.close();
    await expect(connecting).rejects.toThrow();
    expect(fixture.calls.closes).toBe(1);
  });

  test("close is idempotent and closes connected clients", async () => {
    const fixture = harness();
    await fixture.manager.connect("local");
    await fixture.manager.close();
    await fixture.manager.close();
    expect(fixture.calls.closes).toBe(1);
    expect(fixture.manager.status()).toEqual([{ name: "local", status: "disconnected" }]);
  });
});
