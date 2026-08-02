import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
  type ThemeColor,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Text, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
  AgentManager,
  type AgentCompletionEvent,
  type AgentInfo,
  type AgentListEntry,
  type AgentManagerOptions,
  writeFullToolOutput,
} from "./core.js";
import {
  AGENT_PROFILE_NAMES,
  configuredProfileColor,
  getAgentProfilesDescription,
  persistedProfileColor,
  type AgentProfileName,
} from "./profiles.js";
import { SubagentPeekOverlay } from "./peek.js";
import { runningAgents } from "../shared/agent_activity.js";

const textResult = <TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> => ({
  content: [{ text, type: "text" as const }],
  details,
});

interface BoundedText {
  text: string;
  fullOutputPath?: string;
  truncated?: true;
}

const boundedText = (
  text: string,
  maxBytes = DEFAULT_MAX_BYTES,
  maxLines = DEFAULT_MAX_LINES,
): BoundedText => {
  const truncation = truncateHead(text, { maxBytes, maxLines });
  if (!truncation.truncated) {return { text };}
  const fullOutputPath = writeFullToolOutput(text);
  const notice = `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
  return { fullOutputPath, text: truncation.content + notice, truncated: true };
};

const boundedTextResult = <TDetails extends Record<string, unknown>>(
  text: string,
  details: TDetails,
): AgentToolResult<TDetails & { fullOutputPath?: string; truncated?: true }> => {
  const bounded = boundedText(text);
  if (!bounded.truncated) {return textResult(bounded.text, details);}
  return textResult(bounded.text, {
    ...details,
    fullOutputPath: bounded.fullOutputPath,
    truncated: true,
  });
};

const cleanTarget = (target: string): string => target.trim().replace(/^\/+/, "");

const parseTargets = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.map((target) => cleanTarget(String(target))).filter(Boolean)
    : undefined;

const parentSessionId = (ctx: ExtensionContext): string => {
  const id = ctx.sessionManager.getSessionId();
  if (!id) {throw new Error("The parent Pi session has no session id.");}
  return String(id);
};

const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {return `${seconds}s`;}
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {return `${minutes}m`;}
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {return `${hours}h`;}
  return `${Math.floor(hours / 24)}d`;
};

const runtimeLabel = (info: AgentInfo): string => {
  const start = info.startedAt || info.createdAt;
  const final = ["completed", "failed", "interrupted"].includes(info.status);
  const end = final ? info.completedAt || info.updatedAt || Date.now() : Date.now();
  return formatDuration(end - start);
};

/** Tool results are rendered from the same shape `execute()` returns; some hosts add `isError`. */
type RenderableToolResult<TDetails> = AgentToolResult<TDetails> & { isError?: boolean };

interface CompletionMessageDetails {
  agent_name: string;
  status: string;
  profile?: string;
  color: ThemeColor;
  is_readonly?: boolean;
  fullOutputPath?: string;
}

const DELEGATION_GUIDANCE = `

## Subagent delegation

Subagents are available through \`spawn_agent\`. Prefer delegating over doing context-heavy work yourself, and spawn generously:

- Delegate by default for read-heavy work: codebase exploration, "where is X handled", library and API research, log or test-output triage, and pre-implementation reconnaissance. A \`scout\` or \`librarian\` run costs one short report instead of dozens of tool results in your own context.
- Parallelize. Independent questions should become several agents spawned in the same response, not a sequence of your own searches.
- Do not block. \`spawn_agent\` returns as soon as the child accepts its task and completions arrive on their own, so keep working; reach for \`wait_agent\`/\`wait_all_agents\` only when your next step depends on a result and no useful work remains.
- Hand scoped implementation work to \`implementer\`, and use \`reviewer\` for a fresh-context check of a plan or a finished change.
- Write self-contained tasks. Children share none of your conversation, so state the goal, the relevant paths, and the shape of the answer you want back.

Keep work in your own context when it is a couple of tool calls, when it depends on conversation history that is expensive to restate, or when the user is waiting on one quick answer. Available profiles: ${AGENT_PROFILE_NAMES.join(", ")}.`;

type PiExtensionContext = ExtensionContext | ExtensionCommandContext;

const subAgentsExtension = (pi: ExtensionAPI, managerOptions: AgentManagerOptions = {}): void => {
  const widgetKey = "pi-codex-subagents";
  const completionMessageType = "pi-codex-subagent-completion";
  let activeContext: PiExtensionContext | undefined;
  const activeAgents = new Map<string, { profile?: string; color: ThemeColor }>();

  const isCurrentSession = (parentId: string) => {
    try {
      return activeContext && parentSessionId(activeContext) === parentId;
    } catch {
      return false;
    }
  };

  const refreshAgentWidget = () => {
    runningAgents.publish(
      [...activeAgents.entries()].map(([name, metadata]) => ({ name, ...metadata })),
    );
    if (!activeContext || activeContext.mode !== "tui") {return;}
    const running = [...activeAgents.entries()];
    if (!running.length) {
      activeContext.ui.setWidget(widgetKey, undefined);
      return;
    }
    activeContext.ui.setWidget(widgetKey, (_tui: TUI, theme: Theme) => ({
      invalidate() { /* Widget has no cached state to invalidate. */ },
      render(width: number) {
        const marker = "◌ ";
        const suffix = " · /subagents";
        if (width <= visibleWidth(marker) + visibleWidth(suffix)) {
          return [truncateToWidth(theme.fg("dim", "/subagents"), width, "")];
        }
        const [[name, metadata]] = running;
        const label =
          running.length === 1
            ? theme.fg(
                metadata.color,
                `${metadata.profile ? `[${metadata.profile}] ` : ""}${name} running`,
              )
            : running
                .map(([agentName, agent]) =>
                  theme.fg(
                    agent.color,
                    `${agent.profile ? `[${agent.profile}] ` : ""}${agentName}`,
                  ),
                )
                .join(theme.fg("dim", " · "));
        const available = width - visibleWidth(marker) - visibleWidth(suffix);
        const clippedLabel = truncateToWidth(label, available, "…");
        return [theme.fg("accent", marker) + clippedLabel + theme.fg("dim", suffix)];
      },
    }));
  };

  const deliverCompletion = (event: AgentCompletionEvent) => {
    if (!isCurrentSession(event.parentSessionId)) {return;}
    const payload = JSON.stringify(
      {
        agent_name: event.agentName,
        status: event.status,
        ...(event.finalResponse === undefined ? {} : { final_response: event.finalResponse }),
        ...(event.error ? { error: event.error } : {}),
        ...(event.profile ? { profile: event.profile } : {}),
        color: event.color,
        ...(event.isReadonly === undefined ? {} : { is_readonly: event.isReadonly }),
      },
      undefined,
      2,
    );
    const bounded = boundedText(payload, DEFAULT_MAX_BYTES - 1024, DEFAULT_MAX_LINES - 4);
    pi.sendMessage(
      {
        content: `<subagent_notification>\n${bounded.text}\n</subagent_notification>`,
        customType: completionMessageType,
        details: {
          agent_name: event.agentName,
          status: event.status,
          ...(event.profile ? { profile: event.profile } : {}),
          color: event.color,
          ...(event.isReadonly === undefined ? {} : { is_readonly: event.isReadonly }),
          ...(bounded.fullOutputPath ? { fullOutputPath: bounded.fullOutputPath } : {}),
        },
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  };

  const manager = new AgentManager({
    ...managerOptions,
    onActivityChange: (event) => {
      if (!isCurrentSession(event.parentSessionId)) {return;}
      if (event.active)
        {activeAgents.set(event.agentName, { color: event.color, profile: event.profile });}
      else {activeAgents.delete(event.agentName);}
      refreshAgentWidget();
    },
    onUnclaimedCompletion: deliverCompletion,
  });

  const colorForTarget = (target: string): ThemeColor => {
    if (!activeContext) {return "muted";}
    try {
      const info = manager.getAgentInfo(cleanTarget(target), parentSessionId(activeContext));
      return persistedProfileColor(info.profile, info.color);
    } catch {
      return "muted";
    }
  };

  const coloredTargets = (targets: string[], theme: Theme): string =>
    targets.map((target) => theme.fg(colorForTarget(target), target)).join(",");

  pi.registerMessageRenderer<CompletionMessageDetails>(
    completionMessageType,
    (message, { expanded }, theme) => {
      const status = message.details?.status;
      let statusColor: ThemeColor;
      if (status === "completed") {
        statusColor = "success";
      } else if (status === "failed") {
        statusColor = "error";
      } else {
        statusColor = "warning";
      }
      const identityColor = persistedProfileColor(
        message.details?.profile,
        message.details?.color,
      );
      let text =
        theme.fg(statusColor, `${status === "completed" ? "✓" : "✗"} `) +
        theme.fg(identityColor, message.details?.agent_name || "subagent") +
        theme.fg(statusColor, ` ${status || "finished"}`);
      if (expanded && typeof message.content === "string")
        {text += `\n${theme.fg("dim", message.content)}`;}
      return new Text(text, 0, 0);
    },
  );

  const spawnAgentParameters = Type.Object({
    agent_type: StringEnum(AGENT_PROFILE_NAMES, {
      description: "Required source-defined agent profile.",
    }),
    message: Type.String({ description: "Initial task for the new agent." }),
    task_name: Type.String({
      description:
        "Task name for the new agent. Use letters, digits, underscores, dashes, and optional slash path separators.",
    }),
  });
  type SpawnAgentParams = Static<typeof spawnAgentParameters>;
  type SpawnAgentResultDetails = Awaited<ReturnType<AgentManager["spawnAgent"]>>;

  const spawnAgentTool = {
    get description() {
      return `Spawn a fresh-context Pi subagent using a required source-defined profile. Children rediscover configured global and project extensions normally while skills, prompt templates, and context files remain isolated. Each profile fixes its model, thinking level, prompt, read-only metadata, and model-callable tool boundary.

Returns after the child accepts its initial task. Continue with independent work instead of waiting; the child's final response will be delivered automatically when ready. Use \`wait_agent\` or \`wait_all_agents\` only when your next action depends on the subagent response and you have no useful work to do meanwhile.

Available agent profiles:
${getAgentProfilesDescription()}`;
    },
    async execute(
      _toolCallId: string,
      params: SpawnAgentParams,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<SpawnAgentResultDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      const currentModel = ctx.model;
      if (!currentModel?.provider || !currentModel?.id)
        {throw new Error("spawn_agent failed: the parent has no active provider/model pair.");}
      const availableModels = ctx.modelRegistry.getAvailable();
      if (!Array.isArray(availableModels))
        {throw new Error("spawn_agent failed: authenticated model availability is unavailable.");}
      try {
        const result = await manager.spawnAgent({
          agent_type: params.agent_type as AgentProfileName,
          availableModels: availableModels.map((model) => ({
            id: String(model.id),
            provider: String(model.provider),
          })),
          cwd: ctx.cwd,
          message: params.message,
          parentModel: { id: currentModel.id, provider: currentModel.provider },
          parentSessionFile: ctx.sessionManager.getSessionFile(),
          parentSessionId: parentSessionId(ctx),
          task_name: params.task_name,
        });
        return textResult(`Spawned ${result.task_name}.`, result);
      } catch (error) {
        throw new Error(
          `spawn_agent failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error },
        );
      }
    },
    label: "Spawn Agent",
    name: "spawn_agent",
    parameters: spawnAgentParameters,
    renderCall(args: SpawnAgentParams, theme: Theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("spawn_agent ")) +
          theme.fg("text", args.task_name || "?") +
          theme.fg(
            configuredProfileColor(args.agent_type),
            args.agent_type ? ` [${args.agent_type}]` : "",
          ),
        0,
        0,
      );
    },
    renderResult(
      result: RenderableToolResult<SpawnAgentResultDetails>,
      _options: ToolRenderResultOptions,
      theme: Theme,
    ) {
      if (result.isError) {
        const [firstContent] = result.content;
        const failureText = firstContent?.type === "text" ? firstContent.text : "failed";
        return new Text(theme.fg("error", `✗ ${failureText}`), 0, 0);
      }
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg(
            persistedProfileColor(result.details?.profile, result.details?.color),
            result.details?.task_name || "spawned",
          ),
        0,
        0,
      );
    },
  };

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    activeAgents.clear();
    await manager.ready();
    if (activeContext !== ctx) {return;}
    for (const entry of manager.listAgents(undefined, parentSessionId(ctx))) {
      if (entry.agent_status === "starting" || entry.agent_status === "running")
        {activeAgents.set(entry.agent_name, { color: entry.color, profile: entry.profile });}
    }
    refreshAgentWidget();
  });

  pi.on("before_agent_start", (event) => {
    if (process.env.PI_SUBAGENT_OWNER_TOKEN !== undefined) {return;}
    return { systemPrompt: event.systemPrompt + DELEGATION_GUIDANCE };
  });

  pi.on("session_shutdown", async () => {
    if (activeContext?.mode === "tui") {activeContext.ui.setWidget(widgetKey, undefined);}
    activeContext = undefined;
    activeAgents.clear();
    refreshAgentWidget();
    await manager.shutdown();
  });

  pi.registerTool(spawnAgentTool);

  pi.registerTool({
    description:
      "Wait for one session-owned agent completion, or for the next completion if targets is omitted. Use only when your next action depends on that response; otherwise continue working and let completion arrive automatically. Returns one final response. Use wait_all_agents when every target must finish.",
    async execute(
      _id: string,
      params,
      signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      try {
        const result = await manager.waitAgent(
          parentSessionId(ctx),
          parseTargets(params.targets),
          signal,
        );
        return boundedTextResult(JSON.stringify(result, undefined, 2), {
          event: result.event,
          message: result.message,
        });
      } catch (error) {
        if (signal?.aborted) {throw error;}
        throw new Error(
          `wait_agent failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error },
        );
      }
    },
    label: "Wait Agent",
    name: "wait_agent",
    parameters: Type.Object({
      targets: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Agent task names to wait on. Omit to wait for the next completion in this parent session.",
        }),
      ),
    }),
    renderCall(args, theme: Theme) {
      const targets = Array.isArray(args.targets) && args.targets.length ? args.targets : [];
      return new Text(
        theme.fg("toolTitle", theme.bold("wait_agent ")) +
          (targets.length ? coloredTargets(targets, theme) : theme.fg("muted", "any")),
        0,
        0,
      );
    },
    renderResult(result: RenderableToolResult<unknown>, _options: ToolRenderResultOptions, theme: Theme) {
      if (result.isError) {return new Text(theme.fg("error", "✗ wait failed"), 0, 0);}
      const details = result.details as { event?: AgentCompletionEvent; message?: string } | undefined;
      const event = details?.event;
      if (!event) {return new Text(theme.fg("success", details?.message || "done"), 0, 0);}
      let statusColor: ThemeColor;
      if (event.status === "completed") {
        statusColor = "success";
      } else if (event.status === "failed") {
        statusColor = "error";
      } else {
        statusColor = "warning";
      }
      return new Text(
        theme.fg(statusColor, event.status === "completed" ? "✓ " : "✗ ") +
          theme.fg(persistedProfileColor(event.profile, event.color), event.agentName) +
          theme.fg(statusColor, ` ${event.status}`),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    description:
      "Wait until all targeted session-owned agents reach a final status. Use only when your next action depends on every response; otherwise continue working and let completions arrive automatically. Returns their final text responses.",
    async execute(
      _id: string,
      params,
      signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      try {
        const result = await manager.waitAllAgents(
          parentSessionId(ctx),
          parseTargets(params.targets),
          signal,
        );
        return boundedTextResult(JSON.stringify(result, undefined, 2), {
          message: result.message,
          responses: result.responses,
        });
      } catch (error) {
        if (signal?.aborted) {throw error;}
        throw new Error(
          `wait_all_agents failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error },
        );
      }
    },
    label: "Wait All Agents",
    name: "wait_all_agents",
    parameters: Type.Object({
      targets: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Agent task names to wait for. Omit to wait for agents spawned by this extension instance.",
        }),
      ),
    }),
    renderCall(args, theme: Theme) {
      const targets = Array.isArray(args.targets) && args.targets.length ? args.targets : [];
      return new Text(
        theme.fg("toolTitle", theme.bold("wait_all_agents ")) +
          (targets.length ? coloredTargets(targets, theme) : theme.fg("muted", "all")),
        0,
        0,
      );
    },
    renderResult(result: RenderableToolResult<{ message?: string }>, _options: ToolRenderResultOptions, theme: Theme) {
      if (result.isError) {return new Text(theme.fg("error", "✗ wait failed"), 0, 0);}
      return new Text(theme.fg("success", result.details?.message || "done"), 0, 0);
    },
  });

  pi.registerTool({
    description:
      "List agents owned by the current parent session. Set include_all only for an explicit read-only historical listing across parent sessions.",
    async execute(
      _id: string,
      params,
      _signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const agents = manager.listAgents(
        params.path_prefix,
        parentSessionId(ctx),
        params.include_all === true,
      );
      return boundedTextResult(JSON.stringify({ agents }, undefined, 2), { agents });
    },
    label: "List Agents",
    name: "list_agents",
    parameters: Type.Object({
      include_all: Type.Optional(
        Type.Boolean({
          description:
            "Include agents from all parent sessions and show parent_session_id. Default false.",
        }),
      ),
      path_prefix: Type.Optional(
        Type.String({ description: "Task-path prefix filter without a trailing slash." }),
      ),
    }),
    renderCall(_args, theme: Theme) {
      return new Text(theme.fg("toolTitle", theme.bold("list_agents")), 0, 0);
    },
    renderResult(
      result: RenderableToolResult<{ agents?: unknown[] }>,
      options: ToolRenderResultOptions,
      theme: Theme,
    ) {
      const agents = result.details?.agents || [];
      if (!options.expanded)
        {return new Text(
          theme.fg("success", `✓ ${agents.length} agent${agents.length === 1 ? "" : "s"}`),
          0,
          0,
        );}
      const [firstContent] = result.content;
      const text = firstContent?.type === "text" ? firstContent.text : undefined;
      return new Text(text || JSON.stringify({ agents }, undefined, 2), 0, 0);
    },
  });

  pi.registerTool({
    description:
      "Read one current-session agent's latest final raw text response. Tool calls and intermediate assistant text are excluded.",
    async execute(
      _id: string,
      params,
      _signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      try {
        const result = manager.readAgentResponse(cleanTarget(params.target), parentSessionId(ctx));
        return boundedTextResult(JSON.stringify(result, undefined, 2), {
          agent_name: result.agent_name,
          color: result.color,
          is_readonly: result.is_readonly,
          profile: result.profile,
          status: result.status,
        });
      } catch (error) {
        throw new Error(
          `read_agent_response failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error },
        );
      }
    },
    label: "Read Agent Response",
    name: "read_agent_response",
    parameters: Type.Object({
      target: Type.String({ description: "Session-owned agent task name." }),
    }),
    renderCall(args, theme: Theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("read_agent_response ")) +
          theme.fg(colorForTarget(args.target || ""), args.target || "?"),
        0,
        0,
      );
    },
    renderResult(
      result: RenderableToolResult<{ profile?: string; color?: ThemeColor; agent_name?: string }>,
      _options: ToolRenderResultOptions,
      theme: Theme,
    ) {
      if (result.isError) {return new Text(theme.fg("error", "✗ read failed"), 0, 0);}
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg(
            persistedProfileColor(result.details?.profile, result.details?.color),
            result.details?.agent_name || "response",
          ),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    description:
      "Send a message to a session-owned agent. Steers the current run when active; otherwise starts a new turn.",
    async execute(
      _id: string,
      params,
      _signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      try {
        const result = await manager.sendMessage(
          parentSessionId(ctx),
          cleanTarget(params.target),
          params.message,
        );
        const info = manager.getAgentInfo(cleanTarget(params.target), parentSessionId(ctx));
        return textResult(
          result.delivery === "steer"
            ? "Message steered into the running agent."
            : "Message started a new agent turn.",
          {
            ...result,
            color: persistedProfileColor(info.profile, info.color),
            is_readonly: info.isReadonly,
            profile: info.profile,
            target: params.target,
          },
        );
      } catch (error) {
        throw new Error(
          `send_message failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error },
        );
      }
    },
    label: "Send Message",
    name: "send_message",
    parameters: Type.Object({
      message: Type.String({ description: "Message text to send." }),
      target: Type.String({ description: "Session-owned agent task name." }),
    }),
    renderCall(args, theme: Theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("send_message ")) +
          theme.fg(colorForTarget(args.target || ""), args.target || "?"),
        0,
        0,
      );
    },
    renderResult(
      result: RenderableToolResult<{
        delivery?: "steer" | "prompt";
        profile?: string;
        color?: ThemeColor;
        target?: string;
      }>,
      _options: ToolRenderResultOptions,
      theme: Theme,
    ) {
      if (result.isError) {return new Text(theme.fg("error", "✗ send failed"), 0, 0);}
      return new Text(
        theme.fg("success", result.details?.delivery === "steer" ? "✓ steered " : "✓ started ") +
          theme.fg(
            persistedProfileColor(result.details?.profile, result.details?.color),
            result.details?.target || "agent",
          ),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    description:
      "Abort a session-owned agent's current turn while keeping its session available for later send_message calls.",
    async execute(
      _id: string,
      params,
      _signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      try {
        const sessionId = parentSessionId(ctx);
        const target = cleanTarget(params.target);
        const result = await manager.interruptAgent(sessionId, target);
        const info = manager.getAgentInfo(target, sessionId);
        return textResult("Interrupt request handled.", {
          ...result,
          color: persistedProfileColor(info.profile, info.color),
          is_readonly: info.isReadonly,
          profile: info.profile,
          target: params.target,
        });
      } catch (error) {
        throw new Error(
          `interrupt_agent failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error },
        );
      }
    },
    label: "Interrupt Agent",
    name: "interrupt_agent",
    parameters: Type.Object({
      target: Type.String({ description: "Session-owned agent task name." }),
    }),
    renderCall(args, theme: Theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("interrupt_agent ")) +
          theme.fg(colorForTarget(args.target || ""), args.target || "?"),
        0,
        0,
      );
    },
    renderResult(
      result: RenderableToolResult<{
        profile?: string;
        color?: ThemeColor;
        target?: string;
        previous_status?: string;
      }>,
      _options: ToolRenderResultOptions,
      theme: Theme,
    ) {
      if (result.isError) {return new Text(theme.fg("error", "✗ interrupt failed"), 0, 0);}
      return new Text(
        theme.fg("warning", "↯ ") +
          theme.fg(
            persistedProfileColor(result.details?.profile, result.details?.color),
            result.details?.target || "agent",
          ) +
          theme.fg("warning", ` previous: ${result.details?.previous_status || "unknown"}`),
        0,
        0,
      );
    },
  });

  interface OpenAgentOverlayOptions {
    ctx: PiExtensionContext;
    task: string;
    scopeId?: string;
    includeAll?: boolean;
  }

  const openAgentOverlay = async (options: OpenAgentOverlayOptions): Promise<void> => {
    const { ctx, task } = options;
    const scopeId = options.scopeId ?? parentSessionId(ctx);
    const includeAll = options.includeAll ?? false;
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Subagent overlays require interactive TUI mode.", "warning");
      return;
    }
    let info: AgentInfo;
    try {
      info = manager.getAgentInfo(task, scopeId);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }

    while (true) {
      const navigation = await ctx.ui.custom<"previous" | "next" | undefined>(
        (tui, theme, _keybindings, done) => new SubagentPeekOverlay({ done, info, theme, tui }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "right-center",
            margin: { bottom: 2, right: 2, top: 2 },
            maxHeight: 60,
            minWidth: 50,
            width: "45%",
          },
        },
      );
      if (navigation !== "previous" && navigation !== "next") {return;}

      const currentSessionId = parentSessionId(ctx);
      const entries = manager.listAgents(undefined, currentSessionId, includeAll);
      if (entries.length < 2) {return;}
      const currentIndex = entries.findIndex(
        (entry) =>
          entry.agent_name === info.canonicalName &&
          (entry.parent_session_id || currentSessionId) === info.parentSessionId,
      );
      if (currentIndex === -1) {return;}
      const offset = navigation === "next" ? 1 : -1;
      const next = entries[(currentIndex + offset + entries.length) % entries.length];
      info = manager.getAgentInfo(next.agent_name, next.parent_session_id || currentSessionId);
    }
  };

  interface PickedAgent {
    task: string;
    parentSessionId: string;
    includeAll: boolean;
  }

  const pickAgent = async (ctx: PiExtensionContext): Promise<PickedAgent | undefined> => {
    const currentSessionId = parentSessionId(ctx);
    return await ctx.ui.custom<PickedAgent | undefined>((tui, theme, _keybindings, done) => {
      let selected = 0;
      let showAll = false;
      let cached: string[] | undefined;
      const fg = theme.fg.bind(theme);
      const pageSize = 10;
      const refresh = () => {
        cached = undefined;
        tui.requestRender();
      };
      const agents = () => manager.listAgents(undefined, currentSessionId, showAll);
      const renderAgentRow = (entry: AgentListEntry, index: number, width: number): string[] => {
        const info = manager.getAgentInfo(
          entry.agent_name,
          entry.parent_session_id || currentSessionId,
        );
        const pointer = index === selected ? fg("accent", "› ") : "  ";
        const name = truncateToWidth(entry.agent_name, 28).padEnd(28);
        const sessionId = entry.parent_session_id || "";
        const parent = showAll ? ` ${sessionId.slice(-8)}` : "";
        let statusColor: ThemeColor;
        if (entry.agent_status === "failed") {
          statusColor = "error";
        } else if (entry.agent_status === "completed") {
          statusColor = "success";
        } else {
          statusColor = "warning";
        }
        const rowLines = [
          `${pointer}${fg(persistedProfileColor(info.profile, info.color), name)} ${fg(
            statusColor,
            entry.agent_status.padEnd(11),
          )} ${fg("dim", `${runtimeLabel(info)}${parent}`)}`,
        ];
        if (entry.last_task_message) {
          rowLines.push(
            `  ${fg(
              "dim",
              truncateToWidth(
                entry.last_task_message.replaceAll(/\s+/g, " "),
                Math.max(20, width - 4),
              ),
            )}`,
          );
        }
        return rowLines;
      };
      return {
        handleInput(data: string) {
          const entries = agents();
          if (matchesKey(data, "escape") || data === "q") {
            done(undefined);
            return;
          }
          if (matchesKey(data, "tab") || data === "\t") {
            showAll = !showAll;
            selected = 0;
            refresh();
            return;
          }
          if (data === "r") {
            refresh();
            return;
          }
          if (matchesKey(data, "down") || data === "j") {
            selected = Math.min(entries.length - 1, selected + 1);
            refresh();
            return;
          }
          if (matchesKey(data, "up") || data === "k") {
            selected = Math.max(0, selected - 1);
            refresh();
            return;
          }
          if (matchesKey(data, "return") && entries[selected]) {
            done({
              includeAll: showAll,
              parentSessionId: entries[selected].parent_session_id || currentSessionId,
              task: entries[selected].agent_name,
            });
          }
        },
        invalidate() {
          cached = undefined;
        },
        render(width: number): string[] {
          if (cached) {return cached;}
          const entries = agents();
          if (selected >= entries.length) {selected = Math.max(0, entries.length - 1);}
          const scopeLabel = showAll ? "all sessions" : "this session";
          const lines = [
            fg("accent", "─".repeat(width)),
            fg("accent", theme.bold(" Subagents")) +
              fg("dim", ` (${entries.length}, ${scopeLabel})`),
            "",
          ];
          if (!entries.length)
            {lines.push(
              fg(
                "dim",
                showAll
                  ? "No subagents found."
                  : "No subagents for this session. Press tab to show all.",
              ),
            );}
          const viewStart =
            entries.length > pageSize
              ? Math.max(
                  0,
                  Math.min(selected - Math.floor(pageSize / 2), entries.length - pageSize),
                )
              : 0;
          const viewEnd = Math.min(viewStart + pageSize, entries.length);
          if (viewStart > 0) {lines.push(fg("dim", `  ↑ ${viewStart} more`));}
          for (let index = viewStart; index < viewEnd; index++) {
            lines.push(...renderAgentRow(entries[index], index, width));
          }
          if (viewEnd < entries.length)
            {lines.push(fg("dim", `  ↓ ${entries.length - viewEnd} more`));}
          lines.push(
            "",
            fg("dim", "enter: open  tab: this/all sessions  r: refresh  q/esc: close"),
          );
          cached = lines;
          return lines;
        },
      };
    });
  };

  pi.registerCommand("subagent", {
    description: "Browse subagents, or open one directly. Usage: /subagent [task-name]",
    handler: async (args, ctx) => {
      const task = args?.trim().replace(/^\//, "");
      if (task) {
        await openAgentOverlay({ ctx, task });
        return;
      }
      const selected = await pickAgent(ctx);
      if (selected)
        {await openAgentOverlay({
          ctx,
          includeAll: selected.includeAll,
          scopeId: selected.parentSessionId,
          task: selected.task,
        });}
    },
  });

  const browseAgents = async (ctx: PiExtensionContext): Promise<void> => {
    const selected = await pickAgent(ctx);
    if (selected)
      {await openAgentOverlay({
        ctx,
        includeAll: selected.includeAll,
        scopeId: selected.parentSessionId,
        task: selected.task,
      });}
  };

  pi.registerCommand("agents", {
    description: "Browse subagents",
    handler: async (_args, ctx) => browseAgents(ctx),
  });

  pi.registerCommand("subagents", {
    description: "Browse subagents",
    handler: async (_args, ctx) => browseAgents(ctx),
  });
};

export default subAgentsExtension;
