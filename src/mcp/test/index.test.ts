import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  createMcpExtension,
  mcpPolicyFromEnvironment,
  readonlyMcpPolicy,
  unrestrictedMcpPolicy,
  type McpGatewayDependencies,
  type McpGatewayManager,
  type McpManagerCallbacks,
  type McpOperationOptions,
  type McpSearchOptions,
  type McpToolDescription,
} from "../index.js";
import { createFakePi } from "#test-utils/fake-pi";

interface RecordedCall {
  method: string;
  values: unknown[];
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createHarness(overrides: Partial<McpGatewayManager> = {}) {
  const calls: RecordedCall[] = [];
  let callbacks: McpManagerCallbacks | undefined;
  let loadCount = 0;
  const callResult: AgentToolResult<unknown> = {
    content: [{ type: "text", text: "called" }],
    details: { from: "manager" },
  };

  const manager: McpGatewayManager = {
    status() {
      calls.push({ method: "status", values: [] });
      return [
        { name: "zeta", status: "disconnected" },
        { name: "alpha", status: "connected" },
      ];
    },
    oauthServers() {
      calls.push({ method: "oauthServers", values: [] });
      return ["slack"];
    },
    async connect(server: string, options?: McpOperationOptions) {
      calls.push({ method: "connect", values: [server, options] });
    },
    async list(server: string, options?: McpOperationOptions) {
      calls.push({ method: "list", values: [server, options] });
      return [
        {
          name: `${server}_z`,
          description: "Last",
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
        {
          name: `${server}_a`,
          description: "First",
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ];
    },
    async search(query: string, options?: McpSearchOptions) {
      calls.push({ method: "search", values: [query, options] });
      return [
        {
          name: "z_tool",
          description: "Last",
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
        {
          name: "a_tool",
          description: "First",
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ];
    },
    async describe(tool: string, options?: McpOperationOptions): Promise<McpToolDescription> {
      calls.push({ method: "describe", values: [tool, options] });
      return {
        name: tool,
        server: options?.server ?? "resolved",
        description: "A useful tool",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true, destructiveHint: false },
      };
    },
    async call(tool: string, args: Record<string, unknown>, options?: McpOperationOptions) {
      calls.push({ method: "call", values: [tool, args, options] });
      return callResult;
    },
    async authenticate(server: string, options?: McpOperationOptions) {
      calls.push({ method: "authenticate", values: [server, options] });
    },
    async close() {
      calls.push({ method: "close", values: [] });
    },
    ...overrides,
  };

  const dependencies: McpGatewayDependencies<string> = {
    configPath: "/test-home/.config/mcp/mcp.json",
    async loadConfig() {
      loadCount += 1;
      return "config";
    },
    createManager(config, managerCallbacks) {
      expect(config).toBe("config");
      callbacks = managerCallbacks;
      return manager;
    },
  };
  const fixture = createFakePi();
  createMcpExtension(dependencies)(fixture.pi);

  async function start() {
    await fixture.emit("session_start", {}, context());
  }

  async function execute(params: Record<string, unknown>, signal?: AbortSignal) {
    const tool = fixture.state.tools.get("mcp");
    expect(tool).toBeDefined();
    const executeTool = tool?.execute as (
      id: string,
      input: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<AgentToolResult<unknown>>;
    return executeTool("call-1", params, signal);
  }

  async function invokeCommand(args = "", commandContext: unknown = context()) {
    const command = fixture.state.commands.get("mcp-auth");
    expect(command).toBeDefined();
    const handler = command?.handler as (args: string, ctx: unknown) => Promise<void>;
    return handler(args, commandContext);
  }

  return {
    fixture,
    manager,
    calls,
    callResult,
    dependencies,
    start,
    execute,
    invokeCommand,
    callbacks: () => callbacks,
    loadCount: () => loadCount,
  };
}

function context(statuses?: Array<{ key: string; value: unknown }>) {
  return {
    hasUI: Boolean(statuses),
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus(key: string, value: unknown) {
        statuses?.push({ key, value });
      },
    },
  };
}

function authContext(notifications: Array<{ message: string; level: string }>, selected?: string) {
  return {
    hasUI: true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      async select() {
        return selected;
      },
    },
  };
}

function callsFor(harness: ReturnType<typeof createHarness>, method: string): RecordedCall[] {
  return harness.calls.filter((call) => call.method === method);
}

describe("MCP gateway policy selection", () => {
  test("enables read-only policy only for PI_SUBAGENT_READONLY=1", () => {
    expect(mcpPolicyFromEnvironment({ PI_SUBAGENT_READONLY: "1" })).toBe(readonlyMcpPolicy);
    expect(mcpPolicyFromEnvironment({ PI_SUBAGENT_READONLY: "0" })).toBe(
      unrestrictedMcpPolicy,
    );
    expect(mcpPolicyFromEnvironment({})).toBe(unrestrictedMcpPolicy);
    expect(mcpPolicyFromEnvironment({ PI_SUBAGENT_READONLY: "true" })).toBe(
      unrestrictedMcpPolicy,
    );
  });

  test("allows annotated safe reads and exact DBX exceptions only", () => {
    const request = {
      server: "linear",
      remoteName: "get_issue",
      exposedName: "linear_get_issue",
      operation: "call" as const,
      annotations: { readOnlyHint: true, destructiveHint: false },
    };
    expect(readonlyMcpPolicy.allows(request)).toBeTrue();
    expect(
      readonlyMcpPolicy.allows({
        ...request,
        annotations: { readOnlyHint: true, destructiveHint: true },
      }),
    ).toBeFalse();
    expect(
      readonlyMcpPolicy.allows({
        ...request,
        server: "dbx",
        remoteName: "dbx_list_tables",
        annotations: {},
      }),
    ).toBeTrue();
    expect(
      readonlyMcpPolicy.allows({
        ...request,
        server: "dbx",
        remoteName: "list_tables",
        exposedName: "dbx_list_tables",
        annotations: {},
      }),
    ).toBeFalse();
    expect(
      readonlyMcpPolicy.allows({
        ...request,
        server: "dbx",
        remoteName: "dbx_execute_sql",
        annotations: {},
      }),
    ).toBeFalse();
    expect(
      readonlyMcpPolicy.allows({
        ...request,
        server: "dbx",
        remoteName: "dbx_list_tables",
        annotations: { readOnlyHint: false },
      }),
    ).toBeFalse();
  });
});

describe("MCP gateway registration and lifecycle", () => {
  test("registers one gateway tool and the MCP auth command immediately", () => {
    const harness = createHarness();

    expect([...harness.fixture.state.tools.keys()]).toEqual(["mcp"]);
    expect([...harness.fixture.state.commands.keys()]).toEqual(["mcp-auth"]);
    expect(harness.fixture.state.handlers.has("session_start")).toBeTrue();
    expect(harness.fixture.state.handlers.has("session_shutdown")).toBeTrue();
    expect(harness.loadCount()).toBe(0);
    expect(harness.calls).toEqual([]);
  });

  test("session_start loads and configures without touching a manager operation", async () => {
    const harness = createHarness();
    await harness.start();

    expect(harness.loadCount()).toBe(1);
    expect(harness.callbacks()).toBeDefined();
    expect(harness.calls).toEqual([]);
  });

  test("passes its configured policy into each process-local manager", async () => {
    const harness = createHarness();
    let receivedPolicy: unknown;
    harness.dependencies.policy = readonlyMcpPolicy;
    harness.dependencies.createManager = (_config, _callbacks, _pi, policy) => {
      receivedPolicy = policy;
      return harness.manager;
    };

    await harness.start();
    expect(receivedPolicy).toBe(readonlyMcpPolicy);
  });

  test("manager status callbacks show only connected count", async () => {
    const statuses: Array<{ key: string; value: unknown }> = [];
    const harness = createHarness();
    await harness.fixture.emit("session_start", {}, context(statuses));

    harness.callbacks()?.onStatusChange([
      { name: "one", status: "connected" },
      { name: "two", status: "disconnected" },
    ]);
    harness.callbacks()?.onStatusChange(0);

    expect(statuses).toEqual([
      { key: "mcp", value: "MCP: 1 connected" },
      { key: "mcp", value: undefined },
    ]);
  });

  test("empty input is metadata-only status with sorted servers and config path", async () => {
    const harness = createHarness();
    await harness.start();

    const result = await harness.execute({});

    expect(callsFor(harness, "status")).toHaveLength(1);
    expect(callsFor(harness, "connect")).toHaveLength(0);
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("MCP config: /test-home/.config/mcp/mcp.json"),
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text.indexOf("alpha: connected")).toBeLessThan(text.indexOf("zeta: disconnected"));
  });

  test("tool calls accept object args and preserve manager results", async () => {
    const harness = createHarness();
    await harness.start();
    const controller = new AbortController();

    const result = await harness.execute(
      { tool: "fff_read", args: { path: "README.md" }, server: "fff" },
      controller.signal,
    );

    expect(result).toBe(harness.callResult);
    expect(callsFor(harness, "call")[0]?.values).toEqual([
      "fff_read",
      { path: "README.md" },
      { server: "fff", signal: controller.signal },
    ]);
  });

  test("tool calls parse JSON object args and default omitted args", async () => {
    const harness = createHarness();
    await harness.start();

    await harness.execute({ tool: "one", args: '{"count":2}' });
    await harness.execute({ tool: "two" });

    expect(callsFor(harness, "call").map((call) => call.values[1])).toEqual([{ count: 2 }, {}]);
  });

  test("connect delegates the requested server and signal", async () => {
    const harness = createHarness();
    await harness.start();
    const controller = new AbortController();

    const result = await harness.execute({ connect: "linear" }, controller.signal);

    expect(callsFor(harness, "connect")[0]?.values).toEqual([
      "linear",
      { signal: controller.signal },
    ]);
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining('mcp({ server: "linear" })'),
    });
  });

  test("describe delegates resolution scope and renders call syntax", async () => {
    const harness = createHarness();
    await harness.start();
    const controller = new AbortController();

    const result = await harness.execute(
      { describe: "find_issue", server: "linear" },
      controller.signal,
    );

    expect(callsFor(harness, "describe")[0]?.values).toEqual([
      "find_issue",
      { server: "linear", signal: controller.signal },
    ]);
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining('mcp({ tool: "find_issue", args: { ... } })'),
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("[read-only, non-destructive]"),
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        annotations: { readOnlyHint: true, destructiveHint: false },
      }),
    );
  });

  test("search delegates regex, scope, signal, and cap then sorts results", async () => {
    const harness = createHarness();
    await harness.start();
    const controller = new AbortController();

    const result = await harness.execute(
      { search: "issue.*", regex: true, server: "linear" },
      controller.signal,
    );

    expect(callsFor(harness, "search")[0]?.values).toEqual([
      "issue.*",
      { server: "linear", regex: true, limit: 31, signal: controller.signal },
    ]);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text.indexOf("a_tool")).toBeLessThan(text.indexOf("z_tool"));
  });

  test("server-only input lists that server and sorts tools", async () => {
    const harness = createHarness();
    await harness.start();
    const controller = new AbortController();

    const result = await harness.execute({ server: "fff" }, controller.signal);

    expect(callsFor(harness, "list")[0]?.values).toEqual(["fff", { signal: controller.signal }]);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text.indexOf("fff_a")).toBeLessThan(text.indexOf("fff_z"));
  });

  test("mcp-auth authenticates an explicit server and infers the sole OAuth server", async () => {
    const harness = createHarness();
    const notifications: Array<{ message: string; level: string }> = [];
    await harness.start();

    await harness.invokeCommand(" slack ", authContext(notifications));
    await harness.invokeCommand("", authContext(notifications));

    expect(callsFor(harness, "authenticate").map((call) => call.values)).toEqual([
      ["slack", undefined],
      ["slack", undefined],
    ]);
    expect(notifications).toEqual([
      { message: "Authenticated and connected MCP server slack.", level: "info" },
      { message: "Authenticated and connected MCP server slack.", level: "info" },
    ]);
  });

  test("rejects ambiguous selectors and orphan modifiers before delegation", async () => {
    const harness = createHarness();
    await harness.start();

    await expect(harness.execute({ tool: "one", search: "two" })).rejects.toThrow(
      "Ambiguous mcp request",
    );
    await expect(harness.execute({ connect: "one", server: "two" })).rejects.toThrow(
      "connect already names the server",
    );
    await expect(harness.execute({ args: {} })).rejects.toThrow("args can only be used with tool");
    await expect(harness.execute({ regex: true })).rejects.toThrow(
      "regex can only be used with search",
    );
    expect(callsFor(harness, "call")).toHaveLength(0);
    expect(callsFor(harness, "search")).toHaveLength(0);
  });

  test("rejects malformed, scalar, array, and null string args", async () => {
    const harness = createHarness();
    await harness.start();

    await expect(harness.execute({ tool: "one", args: "{" })).rejects.toThrow("valid JSON");
    for (const args of ["null", "[]", "42", '"value"', null, [], 42]) {
      await expect(harness.execute({ tool: "one", args })).rejects.toThrow("must be a JSON object");
    }
    expect(callsFor(harness, "call")).toHaveLength(0);
  });

  test("session_shutdown awaits in-flight initialization cleanup and clears UI", async () => {
    const creation = deferred<McpGatewayManager>();
    const closeStarted = deferred<void>();
    const permitClose = deferred<void>();
    const harness = createHarness({
      async close() {
        closeStarted.resolve();
        await permitClose.promise;
      },
    });
    harness.dependencies.createManager = async (_config, managerCallbacks) => {
      harness.callbacks()?.onStatusChange(0);
      void managerCallbacks;
      return creation.promise;
    };
    // Re-register against the modified dependency object in a fresh fixture.
    const fixture = createFakePi();
    createMcpExtension(harness.dependencies)(fixture.pi);
    const statuses: Array<{ key: string; value: unknown }> = [];

    const starting = fixture.emit("session_start", {}, context(statuses));
    await Promise.resolve();
    const shuttingDown = fixture.emit("session_shutdown", {}, context(statuses));
    creation.resolve(harness.manager);
    await closeStarted.promise;

    let shutdownFinished = false;
    void shuttingDown.then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBeFalse();

    permitClose.resolve();
    await Promise.all([starting, shuttingDown]);
    expect(statuses.at(-1)).toEqual({ key: "mcp", value: undefined });
  });
});
