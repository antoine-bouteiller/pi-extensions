import { describe, expect, test } from "bun:test";
import  { type AgentToolResult } from "@earendil-works/pi-coding-agent";
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
import { createFakePi } from "#test-utils/fake_pi";

interface RecordedCall {
  method: string;
  values: unknown[];
}

const deferred = <Value,>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const createHarness = (overrides: Partial<McpGatewayManager> = {}) => {
  const calls: RecordedCall[] = [];
  let callbacks: McpManagerCallbacks | undefined;
  let loadCount = 0;
  const callResult: AgentToolResult<unknown> = {
    content: [{ text: "called", type: "text" }],
    details: { from: "manager" },
  };

  const manager: McpGatewayManager = {
    async authenticate(server: string, options?: McpOperationOptions) {
      calls.push({ method: "authenticate", values: [server, options] });
    },
    async call(tool: string, args: Record<string, unknown>, options?: McpOperationOptions) {
      calls.push({ method: "call", values: [tool, args, options] });
      return callResult;
    },
    async close() {
      calls.push({ method: "close", values: [] });
    },
    async connect(server: string, options?: McpOperationOptions) {
      calls.push({ method: "connect", values: [server, options] });
    },
    async describe(tool: string, options?: McpOperationOptions): Promise<McpToolDescription> {
      calls.push({ method: "describe", values: [tool, options] });
      return {
        annotations: { destructiveHint: false, readOnlyHint: true },
        description: "A useful tool",
        inputSchema: { type: "object" },
        name: tool,
        server: options?.server ?? "resolved",
      };
    },
    async list(server: string, options?: McpOperationOptions) {
      calls.push({ method: "list", values: [server, options] });
      return [
        {
          annotations: { destructiveHint: true, readOnlyHint: false },
          description: "Last",
          name: `${server}_z`,
        },
        {
          annotations: { destructiveHint: false, readOnlyHint: true },
          description: "First",
          name: `${server}_a`,
        },
      ];
    },
    oauthServers() {
      calls.push({ method: "oauthServers", values: [] });
      return ["slack"];
    },
    async search(query: string, options?: McpSearchOptions) {
      calls.push({ method: "search", values: [query, options] });
      return [
        {
          annotations: { destructiveHint: true, readOnlyHint: false },
          description: "Last",
          name: "z_tool",
        },
        {
          annotations: { destructiveHint: false, readOnlyHint: true },
          description: "First",
          name: "a_tool",
        },
      ];
    },
    status() {
      calls.push({ method: "status", values: [] });
      return [
        { name: "zeta", status: "disconnected" },
        { name: "alpha", status: "connected" },
      ];
    },
    ...overrides,
  };

  const dependencies: McpGatewayDependencies<string> = {
    configPath: "/test-home/.config/mcp/mcp.json",
    createManager(config, { callbacks: managerCallbacks }) {
      expect(config).toBe("config");
      callbacks = managerCallbacks;
      return manager;
    },
    async loadConfig() {
      loadCount += 1;
      return "config";
    },
  };
  const fixture = createFakePi();
  createMcpExtension(dependencies)(fixture.pi);

  const start = async () => {
    await fixture.emit("session_start", {}, context());
  };

  const execute = async (params: Record<string, unknown>, signal?: AbortSignal) => {
    const tool = fixture.state.tools.get("mcp");
    expect(tool).toBeDefined();
    const executeTool = tool?.execute as (
      id: string,
      input: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<AgentToolResult<unknown>>;
    return executeTool("call-1", params, signal);
  };

  const invokeCommand = async (args = "", commandContext: unknown = context()) => {
    const command = fixture.state.commands.get("mcp-auth");
    expect(command).toBeDefined();
    const handler = command?.handler as (args: string, ctx: unknown) => Promise<void>;
    return handler(args, commandContext);
  };

  return {
    callResult,
    callbacks: () => callbacks,
    calls,
    dependencies,
    execute,
    fixture,
    invokeCommand,
    loadCount: () => loadCount,
    manager,
    start,
  };
};

const context = (statuses?: { key: string; value: unknown }[]) => ({
  hasUI: Boolean(statuses),
  ui: {
    setStatus(key: string, value: unknown) {
      statuses?.push({ key, value });
    },
    theme: { fg: (_color: string, value: string) => value },
  },
});

const authContext = (notifications: { message: string; level: string }[], selected?: string) => ({
  hasUI: true,
  ui: {
    notify(message: string, level: string) {
      notifications.push({ level, message });
    },
    async select() {
      return selected;
    },
  },
});

const callsFor = (harness: ReturnType<typeof createHarness>, method: string): RecordedCall[] =>
  harness.calls.filter((call) => call.method === method);

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
      annotations: { destructiveHint: false, readOnlyHint: true },
      exposedName: "linear_get_issue",
      operation: "call" as const,
      remoteName: "get_issue",
      server: "linear",
    };
    expect(readonlyMcpPolicy.allows(request)).toBeTrue();
    expect(
      readonlyMcpPolicy.allows({
        ...request,
        annotations: { destructiveHint: true, readOnlyHint: true },
      }),
    ).toBeFalse();
    expect(
      readonlyMcpPolicy.allows({
        ...request,
        annotations: {},
        remoteName: "dbx_list_tables",
        server: "dbx",
      }),
    ).toBeTrue();
    expect(
      readonlyMcpPolicy.allows({
        ...request,
        annotations: {},
        exposedName: "dbx_list_tables",
        remoteName: "list_tables",
        server: "dbx",
      }),
    ).toBeFalse();
    expect(
      readonlyMcpPolicy.allows({
        ...request,
        annotations: {},
        remoteName: "dbx_execute_sql",
        server: "dbx",
      }),
    ).toBeFalse();
    expect(
      readonlyMcpPolicy.allows({
        ...request,
        annotations: { readOnlyHint: false },
        remoteName: "dbx_list_tables",
        server: "dbx",
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
    harness.dependencies.createManager = (_config, { policy }) => {
      receivedPolicy = policy;
      return harness.manager;
    };

    await harness.start();
    expect(receivedPolicy).toBe(readonlyMcpPolicy);
  });

  test("manager status callbacks show only connected count", async () => {
    const statuses: { key: string; value: unknown }[] = [];
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
      text: expect.stringContaining("MCP config: /test-home/.config/mcp/mcp.json"),
      type: "text",
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text.indexOf("alpha: connected")).toBeLessThan(text.indexOf("zeta: disconnected"));
  });

  test("tool calls accept object args and preserve manager results", async () => {
    const harness = createHarness();
    await harness.start();
    const controller = new AbortController();

    const result = await harness.execute(
      { args: { path: "README.md" }, server: "fff", tool: "fff_read" },
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

    await harness.execute({ args: '{"count":2}', tool: "one" });
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
      text: expect.stringContaining('mcp({ server: "linear" })'),
      type: "text",
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
      text: expect.stringContaining('mcp({ tool: "find_issue", args: { ... } })'),
      type: "text",
    });
    expect(result.content[0]).toEqual({
      text: expect.stringContaining("[read-only, non-destructive]"),
      type: "text",
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        annotations: { destructiveHint: false, readOnlyHint: true },
      }),
    );
  });

  test("search delegates regex, scope, signal, and cap then sorts results", async () => {
    const harness = createHarness();
    await harness.start();
    const controller = new AbortController();

    const result = await harness.execute(
      { regex: true, search: "issue.*", server: "linear" },
      controller.signal,
    );

    expect(callsFor(harness, "search")[0]?.values).toEqual([
      "issue.*",
      { limit: 31, regex: true, server: "linear", signal: controller.signal },
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
    const notifications: { message: string; level: string }[] = [];
    await harness.start();

    await harness.invokeCommand(" slack ", authContext(notifications));
    await harness.invokeCommand("", authContext(notifications));

    expect(callsFor(harness, "authenticate").map((call) => call.values)).toEqual([
      ["slack", undefined],
      ["slack", undefined],
    ]);
    expect(notifications).toEqual([
      { level: "info", message: "Authenticated and connected MCP server slack." },
      { level: "info", message: "Authenticated and connected MCP server slack." },
    ]);
  });

  test("rejects ambiguous selectors and orphan modifiers before delegation", async () => {
    const harness = createHarness();
    await harness.start();

    await expect(harness.execute({ search: "two", tool: "one" })).rejects.toThrow(
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

    await expect(harness.execute({ args: "{", tool: "one" })).rejects.toThrow("valid JSON");
    for (const args of ["null", "[]", "42", '"value"', JSON.parse("null") as unknown, [], 42]) {
      await expect(harness.execute({ args, tool: "one" })).rejects.toThrow("must be a JSON object");
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
    harness.dependencies.createManager = async (_config, managerContext) => {
      harness.callbacks()?.onStatusChange(0);
      void managerContext;
      return creation.promise;
    };
    // Re-register against the modified dependency object in a fresh fixture.
    const fixture = createFakePi();
    createMcpExtension(harness.dependencies)(fixture.pi);
    const statuses: { key: string; value: unknown }[] = [];

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
