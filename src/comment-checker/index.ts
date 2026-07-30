import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";

const MAX_OUTPUT_BYTES = 64 * 1024;
const PROCESS_TIMEOUT_MS = 30_000;

type CheckerEdit = {
  old_string: string;
  new_string: string;
};

type HookInput = {
  session_id: string;
  tool_name: "Write" | "MultiEdit";
  transcript_path: string;
  cwd: string;
  hook_event_name: "PostToolUse";
  tool_input: {
    file_path: string;
    content?: string;
    edits?: CheckerEdit[];
  };
};

export type CheckerResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type CheckerRunner = (input: HookInput) => Promise<CheckerResult>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function hookInput(event: ToolResultEvent, ctx: ExtensionContext): HookInput | undefined {
  if (event.isError) return undefined;

  const input = record(event.input);
  if (!input || typeof input.path !== "string") return undefined;
  const path = input.path;

  const base = {
    session_id: ctx.sessionManager.getSessionId(),
    transcript_path: "",
    cwd: ctx.cwd,
    hook_event_name: "PostToolUse" as const,
  };

  if (event.toolName === "write" && typeof input.content === "string") {
    return {
      ...base,
      tool_name: "Write",
      tool_input: { file_path: path, content: input.content },
    };
  }

  if (event.toolName !== "edit" || !Array.isArray(input.edits)) return undefined;

  const edits = input.edits.flatMap((value): CheckerEdit[] => {
    const edit = record(value);
    return typeof edit?.oldText === "string" && typeof edit.newText === "string"
      ? [{ old_string: edit.oldText, new_string: edit.newText }]
      : [];
  });
  if (edits.length === 0) return undefined;

  return {
    ...base,
    tool_name: "MultiEdit",
    tool_input: { file_path: path, edits },
  };
}

export function runCommentChecker(input: HookInput): Promise<CheckerResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "comment-checker",
      ["check"],
      { maxBuffer: MAX_OUTPUT_BYTES, timeout: PROCESS_TIMEOUT_MS },
      (error, stdout, stderr) => {
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : error ? null : 0,
          stdout,
          stderr,
        });
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(input));
  });
}

export default function commentChecker(
  pi: ExtensionAPI,
  runner: CheckerRunner = runCommentChecker,
) {
  pi.on("tool_result", async (event, ctx) => {
    const input = hookInput(event, ctx);
    if (!input) return undefined;

    const result = await runner(input);
    if (result.exitCode !== 2) return undefined;

    const warning = (result.stderr || result.stdout).trim();
    if (!warning) return undefined;

    return {
      content: [...event.content, { type: "text" as const, text: `\n\n${warning}` }],
    };
  });
}
