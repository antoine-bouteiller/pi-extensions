import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const DEFAULT_INTERVAL_SECONDS = 10;
const DEFAULT_TIMEOUT_SECONDS = 60 * 60;
const POLL_COMMAND_TIMEOUT_MS = 30_000;

const BackgroundPollParams = Type.Object({
  command: Type.String({
    description:
      "Shell command to run repeatedly. Exit 0 means the awaited result is ready; any other exit code retries.",
  }),
  label: Type.Optional(
    Type.String({ description: "Short description of the result being awaited." }),
  ),
  interval_seconds: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 3600,
      description: `Seconds between attempts (default: ${DEFAULT_INTERVAL_SECONDS}).`,
    }),
  ),
  timeout_seconds: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 86_400,
      description: `Maximum total wait in seconds (default: ${DEFAULT_TIMEOUT_SECONDS}).`,
    }),
  ),
});

export type BackgroundPollInput = Static<typeof BackgroundPollParams>;

interface PollTask {
  controller: AbortController;
  label: string;
}

interface PollResultDetails {
  taskId: string;
  label: string;
  command: string;
  attempts: number;
  elapsedMs: number;
  outcome: "completed" | "timed-out" | "error";
  exitCode?: number;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);

    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }

    signal.addEventListener("abort", done, { once: true });
  });
}

function formatOutput(stdout: string, stderr: string): string {
  const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
  if (!output) return "(command produced no output)";

  const truncated = truncateTail(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncated.truncated) return truncated.content;

  return `${truncated.content}\n\n[Output truncated to the last ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}).]`;
}

export default function backgroundPoll(pi: ExtensionAPI) {
  const tasks = new Map<string, PollTask>();
  let shuttingDown = false;

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const count = tasks.size;
    ctx.ui.setStatus(
      "background-poll",
      count > 0
        ? ctx.ui.theme.fg("muted", `⏳ ${count} background poll${count === 1 ? "" : "s"}`)
        : undefined,
    );
  }

  function wakeAgent(details: PollResultDetails, output: string, ctx: ExtensionContext): void {
    if (shuttingDown) return;

    const headline =
      details.outcome === "completed"
        ? `Background poll completed: ${details.label}`
        : details.outcome === "timed-out"
          ? `Background poll timed out: ${details.label}`
          : `Background poll failed: ${details.label}`;

    pi.sendMessage(
      {
        customType: "background-poll-result",
        content: `${headline}\nTask: ${details.taskId}\nAttempts: ${details.attempts}\n\n${output}`,
        display: true,
        details,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );

    if (ctx.hasUI) {
      ctx.ui.notify(headline, details.outcome === "completed" ? "info" : "warning");
    }
  }

  async function runPoll(
    taskId: string,
    params: BackgroundPollInput,
    ctx: ExtensionContext,
  ): Promise<void> {
    const task = tasks.get(taskId);
    if (!task) return;

    const startedAt = Date.now();
    const timeoutMs = (params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    const intervalMs = (params.interval_seconds ?? DEFAULT_INTERVAL_SECONDS) * 1000;
    let attempts = 0;
    let lastOutput = "(no poll attempt completed)";

    try {
      while (!task.controller.signal.aborted) {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= timeoutMs) {
          wakeAgent(
            {
              taskId,
              label: task.label,
              command: params.command,
              attempts,
              elapsedMs,
              outcome: "timed-out",
            },
            lastOutput,
            ctx,
          );
          return;
        }

        attempts += 1;
        const result = await pi.exec("sh", ["-lc", params.command], {
          signal: task.controller.signal,
          timeout: Math.min(POLL_COMMAND_TIMEOUT_MS, Math.max(1, timeoutMs - elapsedMs)),
        });
        if (task.controller.signal.aborted) return;

        lastOutput = formatOutput(result.stdout, result.stderr);
        if (result.code === 0) {
          wakeAgent(
            {
              taskId,
              label: task.label,
              command: params.command,
              attempts,
              elapsedMs: Date.now() - startedAt,
              outcome: "completed",
              exitCode: result.code,
            },
            lastOutput,
            ctx,
          );
          return;
        }

        await sleep(
          Math.min(intervalMs, Math.max(1, timeoutMs - (Date.now() - startedAt))),
          task.controller.signal,
        );
      }
    } catch (error) {
      if (task.controller.signal.aborted) return;
      wakeAgent(
        {
          taskId,
          label: task.label,
          command: params.command,
          attempts,
          elapsedMs: Date.now() - startedAt,
          outcome: "error",
        },
        error instanceof Error ? error.message : String(error),
        ctx,
      );
    } finally {
      tasks.delete(taskId);
      updateStatus(ctx);
    }
  }

  pi.registerTool({
    name: "background_poll",
    label: "Background Poll",
    description:
      "Register a shell command that is polled in the background until it exits successfully. The current agent run can end completely; completion, timeout, or failure automatically wakes the agent with the final output. Output is truncated to 50KB or 2000 lines.",
    promptSnippet:
      "Wait for an asynchronous condition without repeatedly polling or keeping the agent running",
    promptGuidelines: [
      "Use background_poll for long-running external work that can be checked with a repeatable shell command. Make the command exit 0 only when the awaited result is ready, then end the response; background_poll wakes the agent automatically.",
      "Do not manually poll after registering background_poll. Call background_poll in a tool-only turn after finishing all other immediate work so the agent can stop until the result arrives.",
    ],
    parameters: BackgroundPollParams,

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Background poll registration was cancelled");
      if (shuttingDown) throw new Error("Cannot register a background poll during shutdown");

      const taskId = `poll-${toolCallId}`;
      const label = params.label?.trim() || params.command;
      const controller = new AbortController();
      tasks.set(taskId, { controller, label });
      updateStatus(ctx);
      void runPoll(taskId, params, ctx);

      return {
        content: [
          {
            type: "text",
            text: `Registered background poll ${taskId} (${label}). Stop now; the agent will be woken automatically when it completes, times out, or fails. Do not poll it manually.`,
          },
        ],
        details: {
          taskId,
          label,
          command: params.command,
          intervalSeconds: params.interval_seconds ?? DEFAULT_INTERVAL_SECONDS,
          timeoutSeconds: params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
        },
        terminate: true,
      };
    },
  });

  pi.on("session_start", () => {
    shuttingDown = false;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    for (const task of tasks.values()) task.controller.abort();
    tasks.clear();
    updateStatus(ctx);
  });
}
