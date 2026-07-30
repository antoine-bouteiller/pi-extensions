import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { loadGlobalMcpConfig } from "./config.js";
import { boundGatewayOutput } from "./output.js";

const SEARCH_RESULT_LIMIT = 30;
const SEARCH_FETCH_LIMIT = SEARCH_RESULT_LIMIT + 1;
const LIST_RESULT_LIMIT = 30;
const STATUS_KEY = "mcp";

const McpGatewayParameters = Type.Object({
  tool: Type.Optional(Type.String({ description: "Exposed MCP tool name to call." })),
  args: Type.Optional(
    Type.Union([
      Type.Record(Type.String(), Type.Unknown()),
      Type.String({ description: "A JSON object encoded as a string." }),
    ]),
  ),
  connect: Type.Optional(Type.String({ description: "MCP server name to connect." })),
  describe: Type.Optional(Type.String({ description: "Exposed MCP tool name to describe." })),
  search: Type.Optional(Type.String({ description: "Text or regular expression to search for." })),
  regex: Type.Optional(Type.Boolean({ description: "Interpret search as a regular expression." })),
  server: Type.Optional(Type.String({ description: "Limit an operation to one MCP server." })),
});

export interface McpServerStatus {
  name: string;
  status: "disconnected" | "connecting" | "connected" | "needs-auth" | "failed" | "disabled";
  error?: string;
}

export interface McpToolSummary {
  name: string;
  server?: string;
  description?: string;
}

export interface McpToolDescription extends McpToolSummary {
  inputSchema?: unknown;
}

export interface McpOperationOptions {
  server?: string;
  signal?: AbortSignal;
}

export interface McpSearchOptions extends McpOperationOptions {
  regex?: boolean;
  limit?: number;
}

/** The deliberately small manager surface consumed by the gateway. */
export interface McpGatewayManager {
  status(): readonly McpServerStatus[] | Promise<readonly McpServerStatus[]>;
  oauthServers(): readonly string[];
  connect(server: string, options?: McpOperationOptions): Promise<unknown>;
  list(server: string, options?: McpOperationOptions): Promise<readonly McpToolSummary[]>;
  search(query: string, options?: McpSearchOptions): Promise<readonly McpToolSummary[]>;
  describe(tool: string, options?: McpOperationOptions): Promise<McpToolDescription>;
  call(
    tool: string,
    args: Record<string, unknown>,
    options?: McpOperationOptions,
  ): Promise<AgentToolResult<unknown>>;
  authenticate(server: string, options?: McpOperationOptions): Promise<unknown>;
  close(): Promise<void>;
}

export type McpStatusUpdate = number | readonly McpServerStatus[];

export interface McpManagerCallbacks {
  onStatusChange(update: McpStatusUpdate): void;
}

export interface McpGatewayDependencies<TConfig = unknown> {
  configPath: string;
  loadConfig(): Promise<TConfig>;
  createManager(
    config: TConfig,
    callbacks: McpManagerCallbacks,
    pi: ExtensionAPI,
  ): McpGatewayManager | Promise<McpGatewayManager>;
}

async function textResult(text: string, details?: unknown): Promise<AgentToolResult<unknown>> {
  const bounded = await boundGatewayOutput([{ type: "text", text }]);
  return {
    content: bounded.content,
    details: {
      ...(details && typeof details === "object" ? details : {}),
      outputTruncated: bounded.details.truncated,
      ...(bounded.details.fullOutputPath ? { fullOutputPath: bounded.details.fullOutputPath } : {}),
    },
  };
}

function parseArgs(args: unknown): Record<string, unknown> {
  let parsed = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args) as unknown;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`mcp args must be valid JSON: ${reason}`);
    }
  }

  if (parsed === undefined) return {};
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("mcp args must be a JSON object, not an array, scalar, or null");
  }
  return parsed as Record<string, unknown>;
}

function compareNames(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name);
}

function compactDescription(description: string | undefined): string {
  if (!description) return "";
  const singleLine = description.replace(/\s+/g, " ").trim();
  return singleLine.length <= 160 ? singleLine : `${singleLine.slice(0, 157)}...`;
}

function formatTools(tools: readonly McpToolSummary[], heading: string): string {
  const sorted = [...tools].sort(compareNames);
  if (sorted.length === 0) return `${heading}\n(no tools found)`;
  return [
    heading,
    ...sorted.map((tool) => {
      const description = compactDescription(tool.description);
      return `- ${tool.name}${description ? ` — ${description}` : ""}`;
    }),
    "",
    'Call with: mcp({ tool: "<tool-name>", args: { ... } })',
  ].join("\n");
}

function connectedCount(update: McpStatusUpdate): number {
  return typeof update === "number"
    ? update
    : update.filter((server) => server.status === "connected").length;
}

function updateUiStatus(ctx: ExtensionContext, update: McpStatusUpdate): void {
  if (!ctx.hasUI) return;
  const count = connectedCount(update);
  ctx.ui.setStatus(
    STATUS_KEY,
    count > 0 ? ctx.ui.theme.fg("muted", `MCP: ${count} connected`) : undefined,
  );
}

function validateSelectors(params: {
  tool?: string;
  connect?: string;
  describe?: string;
  search?: string;
  server?: string;
  args?: unknown;
  regex?: boolean;
}): void {
  const selectors = [
    params.tool === undefined ? undefined : "tool",
    params.connect === undefined ? undefined : "connect",
    params.describe === undefined ? undefined : "describe",
    params.search === undefined ? undefined : "search",
  ].filter((selector): selector is string => selector !== undefined);

  if (selectors.length > 1) {
    throw new Error(`Ambiguous mcp request: choose only one of ${selectors.join(", ")}`);
  }
  if (params.connect !== undefined && params.server !== undefined) {
    throw new Error("Ambiguous mcp request: connect already names the server; omit server");
  }
  if (params.args !== undefined && params.tool === undefined) {
    throw new Error("mcp args can only be used with tool");
  }
  if (params.regex !== undefined && params.search === undefined) {
    throw new Error("mcp regex can only be used with search");
  }
}

/** Build the extension with injectable config and manager dependencies for isolated tests. */
export function createMcpExtension<TConfig>(dependencies: McpGatewayDependencies<TConfig>) {
  return function mcpGateway(pi: ExtensionAPI): void {
    let manager: McpGatewayManager | undefined;
    let initialization: Promise<void> | undefined;
    let lifecycleGeneration = 0;

    async function requireManager(): Promise<McpGatewayManager> {
      if (initialization) await initialization;
      if (!manager) {
        throw new Error("MCP is not initialized. Start or reload the Pi session and try again.");
      }
      return manager;
    }

    pi.registerTool({
      name: "mcp",
      label: "MCP Gateway",
      description:
        "Access configured remote MCP capabilities through one lazy gateway. Use Pi's native tools directly whenever possible. Search or describe unfamiliar MCP tools before calling them.",
      promptSnippet: "Search and call configured remote MCP capabilities on demand",
      promptGuidelines: [
        "Use native Pi tools directly. Use mcp only for capabilities supplied by configured remote MCP servers.",
        "Search and describe unfamiliar MCP tools before calling them; MCP servers connect lazily only when requested.",
      ],
      parameters: McpGatewayParameters,

      async execute(_toolCallId, params, signal) {
        validateSelectors(params);
        const activeManager = await requireManager();

        if (params.tool !== undefined) {
          return activeManager.call(params.tool, parseArgs(params.args), {
            server: params.server,
            signal,
          });
        }

        if (params.connect !== undefined) {
          await activeManager.connect(params.connect, { signal });
          return textResult(
            `Connected MCP server ${params.connect}.\nList tools with: mcp({ server: ${JSON.stringify(params.connect)} })`,
            { server: params.connect },
          );
        }

        if (params.describe !== undefined) {
          const description = await activeManager.describe(params.describe, {
            server: params.server,
            signal,
          });
          const summary = compactDescription(description.description);
          const lines = [
            description.name,
            ...(description.server ? [`Server: ${description.server}`] : []),
            ...(summary ? [summary] : []),
            `Input schema: ${JSON.stringify(description.inputSchema ?? {})}`,
            `Call with: mcp({ tool: ${JSON.stringify(description.name)}, args: { ... } })`,
          ];
          return textResult(lines.join("\n"), {
            tool: description.name,
            server: description.server,
          });
        }

        if (params.search !== undefined) {
          const matches = await activeManager.search(params.search, {
            server: params.server,
            regex: params.regex ?? false,
            limit: SEARCH_FETCH_LIMIT,
            signal,
          });
          const capped = [...matches].sort(compareNames).slice(0, SEARCH_RESULT_LIMIT);
          return textResult(formatTools(capped, `MCP search results (${capped.length}):`), {
            query: params.search,
            regex: params.regex ?? false,
            server: params.server,
            tools: capped.map((tool) => ({ name: tool.name, server: tool.server })),
            resultsTruncated: matches.length > capped.length,
          });
        }

        if (params.server !== undefined) {
          const tools = await activeManager.list(params.server, { signal });
          const sorted = [...tools].sort(compareNames);
          const capped = sorted.slice(0, LIST_RESULT_LIMIT);
          return textResult(
            formatTools(
              capped,
              `MCP tools on ${params.server} (${capped.length} of ${sorted.length}):`,
            ),
            {
              server: params.server,
              tools: capped.map((tool) => ({ name: tool.name, server: tool.server })),
              resultsTruncated: sorted.length > capped.length,
            },
          );
        }

        const servers = [...(await activeManager.status())].sort(compareNames);
        const lines = [
          `MCP config: ${dependencies.configPath}`,
          ...(servers.length === 0
            ? ["(no configured servers)"]
            : servers.map(
                (server) =>
                  `- ${server.name}: ${server.status}${server.error ? ` — ${server.error}` : ""}`,
              )),
          "",
          'List one server with: mcp({ server: "<server-name>" })',
        ];
        return textResult(lines.join("\n"), {
          configPath: dependencies.configPath,
          serverCount: servers.length,
          servers: servers.slice(0, 30).map((server) => ({
            name: server.name.slice(0, 128),
            status: server.status,
          })),
          resultsTruncated: servers.length > 30,
        });
      },
    });

    pi.registerCommand("mcp-auth", {
      description: "Authenticate an OAuth-enabled MCP server. Usage: /mcp-auth [server]",
      getArgumentCompletions(prefix) {
        if (!manager) return null;
        const items = manager
          .oauthServers()
          .filter((server) => server.startsWith(prefix))
          .sort((left, right) => left.localeCompare(right))
          .map((server) => ({ value: server, label: server }));
        return items.length > 0 ? items : null;
      },
      handler: async (args, ctx) => {
        try {
          const activeManager = await requireManager();
          let server = args.trim();
          if (!server) {
            const servers = [...activeManager.oauthServers()].sort((left, right) =>
              left.localeCompare(right),
            );
            if (servers.length === 0) {
              ctx.ui.notify("No OAuth-enabled MCP servers are configured.", "error");
              return;
            }
            if (servers.length === 1) {
              server = servers[0]!;
            } else {
              const selected = await ctx.ui.select("Authenticate MCP server", servers);
              if (!selected) return;
              server = selected;
            }
          }

          await activeManager.authenticate(server);
          ctx.ui.notify(`Authenticated and connected MCP server ${server}.`, "info");
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(reason, "error");
        }
      },
    });

    pi.on("session_start", (_event, ctx) => {
      const generation = ++lifecycleGeneration;
      const previousManager = manager;
      manager = undefined;

      const start = async () => {
        if (previousManager) await previousManager.close();
        const config = await dependencies.loadConfig();
        const candidate = await dependencies.createManager(
          config,
          {
            onStatusChange(update) {
              if (generation === lifecycleGeneration) updateUiStatus(ctx, update);
            },
          },
          pi,
        );

        if (generation !== lifecycleGeneration) {
          await candidate.close();
          return;
        }
        manager = candidate;
      };

      initialization = start();
      return initialization;
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      ++lifecycleGeneration;
      try {
        await initialization?.catch(() => undefined);
        const activeManager = manager;
        manager = undefined;
        if (activeManager) await activeManager.close();
      } finally {
        initialization = undefined;
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    });
  };
}

const globalConfigPath = join(homedir(), ".config", "mcp", "mcp.json");

const productionDependencies: McpGatewayDependencies<
  Awaited<ReturnType<typeof loadGlobalMcpConfig>>
> = {
  configPath: globalConfigPath,
  loadConfig: loadGlobalMcpConfig,
  async createManager(config, callbacks, pi) {
    // Keep the manager behind the session lifecycle boundary: importing this entrypoint and
    // registering the gateway must not initialize MCP SDK transports or native OAuth storage.
    const managerModulePath = "./manager.js";
    const { McpManager: Manager } = (await import(managerModulePath)) as {
      McpManager: new (
        loadedConfig: Awaited<ReturnType<typeof loadGlobalMcpConfig>>,
        options: {
          onStatusChange(update: McpStatusUpdate): void;
          openUrl(url: string, signal?: AbortSignal): Promise<void>;
        },
      ) => McpGatewayManager;
    };
    return new Manager(config, {
      onStatusChange: callbacks.onStatusChange,
      async openUrl(url: string, signal?: AbortSignal) {
        const result = await pi.exec("/usr/bin/open", [url], { signal });
        if (result.code !== 0) {
          throw new Error(`Could not open the OAuth authorization page: ${result.stderr.trim()}`);
        }
      },
    });
  },
};

export default createMcpExtension(productionDependencies);
