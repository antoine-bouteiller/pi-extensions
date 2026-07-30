import { describe, expect, test } from "bun:test";
import backgroundPoll from "../index";

type Tool = {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: Record<string, any>,
  ) => Promise<any>;
};

type Handler = (event: unknown, ctx: Record<string, any>) => Promise<void> | void;

function setup(execResults: Array<{ stdout: string; stderr: string; code: number }>) {
  let tool: Tool | undefined;
  const handlers = new Map<string, Handler>();
  const messages: Array<{ message: Record<string, any>; options: Record<string, any> }> = [];
  let messageSent: (() => void) | undefined;
  const sent = new Promise<void>((resolve) => {
    messageSent = resolve;
  });

  backgroundPoll({
    registerTool: (definition: Tool) => {
      tool = definition;
    },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    exec: async () => execResults.shift() ?? { stdout: "", stderr: "not ready", code: 1 },
    sendMessage: (message: Record<string, any>, options: Record<string, any>) => {
      messages.push({ message, options });
      messageSent?.();
    },
  } as any);

  const statuses: unknown[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus: (_key: string, value: unknown) => statuses.push(value),
      notify: () => undefined,
    },
  };

  return { tool: tool!, handlers, messages, sent, statuses, ctx };
}

describe("background poll", () => {
  test("returns immediately and wakes the agent after a successful poll", async () => {
    const fixture = setup([
      { stdout: "", stderr: "pending", code: 1 },
      { stdout: "ready", stderr: "", code: 0 },
    ]);

    const result = await fixture.tool.execute(
      "call-1",
      {
        command: "check-status",
        label: "deployment",
        interval_seconds: 0,
        timeout_seconds: 10,
      },
      undefined,
      undefined,
      fixture.ctx,
    );

    expect(result.terminate).toBeTrue();
    expect(result.content[0].text).toContain("Stop now");

    await fixture.sent;
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.messages[0]!.message.content).toContain("Background poll completed: deployment");
    expect(fixture.messages[0]!.message.content).toContain("ready");
    expect(fixture.messages[0]!.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  test("aborts active polling when the session shuts down", async () => {
    const fixture = setup([{ stdout: "", stderr: "pending", code: 1 }]);

    await fixture.tool.execute(
      "call-2",
      {
        command: "check-status",
        interval_seconds: 60,
        timeout_seconds: 120,
      },
      undefined,
      undefined,
      fixture.ctx,
    );

    await fixture.handlers.get("session_shutdown")?.({}, fixture.ctx);
    await Bun.sleep(5);

    expect(fixture.messages).toHaveLength(0);
    expect(fixture.statuses.at(-1)).toBeUndefined();
  });
});
