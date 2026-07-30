import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
  ALL_PATTERNS,
  COMMAND_EXCERPT_CONTEXT_LINES,
  COMMAND_EXCERPT_MAX_LENGTH,
  SAFETY_STATUS_KEY,
} from "./constants";
import { isProtectedPath } from "../shared/protected-paths";

function commandExcerpt(command: string, pattern: RegExp): string {
  const lines = command.split(/\r?\n/);
  const matchedIndex = Math.max(
    0,
    lines.findIndex((line) => pattern.test(line)),
  );
  const start = Math.max(0, matchedIndex - COMMAND_EXCERPT_CONTEXT_LINES);
  const end = Math.min(lines.length, matchedIndex + COMMAND_EXCERPT_CONTEXT_LINES + 1);
  return lines
    .slice(start, end)
    .map((line, offset) => {
      const lineNumber = start + offset + 1;
      const marker = start + offset === matchedIndex ? ">" : " ";
      const displayed =
        line.length > COMMAND_EXCERPT_MAX_LENGTH
          ? `${line.slice(0, COMMAND_EXCERPT_MAX_LENGTH)}…`
          : line;
      return `${marker} ${lineNumber}: ${displayed}`;
    })
    .join("\n");
}

async function confirmRisk(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  label: string,
  message: string,
): Promise<{ block: true; reason: string } | undefined> {
  if (!ctx.hasUI) return { block: true, reason: `${label} blocked (non-interactive mode)` };

  pi.events.emit("herdr:blocked", { active: true, label });
  try {
    const allowed = await ctx.ui.confirm(`⚠️ ${label}`, `${message}\n\nAllow this operation?`);
    return allowed ? undefined : { block: true, reason: `${label} — blocked by user` };
  } finally {
    pi.events.emit("herdr:blocked", { active: false });
  }
}

export default function safetyGuard(pi: ExtensionAPI) {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Rule dispatch is intentionally centralized
  pi.on("tool_call", async (event, ctx) => {
    let command: string | undefined;
    if (isToolCallEventType("bash", event)) {
      command = event.input.command;
    } else if (event.toolName === "background_poll") {
      const input = event.input as { command?: unknown };
      if (typeof input.command === "string") command = input.command;
    }

    if (command !== undefined) {
      // This scanner catches common command spellings for UX and policy
      // guidance. It is intentionally not presented as a shell parser or
      // sandbox; destructive custom tools must enforce safety themselves.
      for (const rule of ALL_PATTERNS) {
        if (!rule.pattern.test(command)) continue;
        if (rule.severity === "critical") {
          if (ctx.hasUI) ctx.ui.notify(`🚫 Blocked: ${rule.label}`, "error");
          return {
            block: true,
            reason: `CRITICAL (best-effort command policy): ${rule.label} — recognized command blocked`,
          };
        }

        return confirmRisk(
          pi,
          ctx,
          rule.label,
          `Category: ${rule.category}\n\n${commandExcerpt(command, rule.pattern)}`,
        );
      }
      return undefined;
    }

    let protectedOperation: "edit" | "read" | "write" | undefined;
    let protectedPath: string | undefined;
    if (isToolCallEventType("read", event)) {
      protectedOperation = "read";
      protectedPath = event.input.path;
    } else if (isToolCallEventType("write", event)) {
      protectedOperation = "write";
      protectedPath = event.input.path;
    } else if (isToolCallEventType("edit", event)) {
      protectedOperation = "edit";
      protectedPath = event.input.path;
    }

    if (
      protectedOperation === undefined ||
      protectedPath === undefined ||
      !(await isProtectedPath(protectedPath, ctx.cwd))
    ) {
      return undefined;
    }

    const label = `Protected file ${protectedOperation}`;
    return confirmRisk(pi, ctx, label, `${protectedOperation} ${protectedPath}`);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus(SAFETY_STATUS_KEY, ctx.ui.theme.fg("success", "🛡️ cmd-guard"));
    }
  });
}
