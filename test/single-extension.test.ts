import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Runs in a child process so importing sub-agents here does not populate the module cache
// before src/sub-agents/test/core.test.ts installs its mock (see extension-registration.test.ts).
describe("bundled single extension", () => {
  test("registers every first-party tool and lifecycle handler through one factory", async () => {
    const modulePath = fileURLToPath(new URL("../extension.ts", import.meta.url));
    const script = `
      const toolNames = [];
      const handlerNames = new Set();
      const target = {
        registerTool(tool) { toolNames.push(tool.name); },
        registerCommand() {},
        registerMessageRenderer() {},
        registerEntryRenderer() {},
        registerShortcut() {},
        registerFlag() {},
        registerProvider() {},
        on(name) { handlerNames.add(name); },
        events: { on() {}, emit() {} },
        async exec() { return { stdout: "", stderr: "", code: 0, killed: false }; },
        sendMessage() {},
        getThinkingLevel: () => "off",
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools() {},
      };
      const pi = new Proxy(target, {
        get(object, property, receiver) {
          if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
          return () => undefined;
        },
      });

      const { default: extension } = await import(${JSON.stringify(modulePath)});
      if (typeof extension !== "function") process.exit(1);
      await extension(pi);
      console.log(JSON.stringify({ tools: toolNames.sort(), handlers: [...handlerNames].sort() }));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    expect(exitCode, await new Response(child.stderr).text()).toBe(0);

    const result = JSON.parse(stdout.trim());
    expect(result.tools).toEqual([
      "ask_user",
      "background_poll",
      "hashline_read",
      "hashline_write",
      "interrupt_agent",
      "list_agents",
      "mcp",
      "read_agent_response",
      "safe_rm",
      "send_message",
      "spawn_agent",
      "wait_agent",
      "wait_all_agents",
      "webfetch",
    ]);
    for (const handler of ["session_start", "session_shutdown", "tool_call", "tool_result"]) {
      expect(result.handlers, handler).toContain(handler);
    }
  });
});
