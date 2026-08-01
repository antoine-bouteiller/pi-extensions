import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFakePi } from "#test-utils/fake-pi";
import footer from "../index";
import { columns, formatTokens, progressBar } from "../render";
import { emptyGitInfoState, emptyModelInfoState } from "../state";

const originalOwnerToken = process.env.PI_SUBAGENT_OWNER_TOKEN;

beforeEach(() => {
  delete process.env.PI_SUBAGENT_OWNER_TOKEN;
});

afterEach(() => {
  if (originalOwnerToken === undefined) delete process.env.PI_SUBAGENT_OWNER_TOKEN;
  else process.env.PI_SUBAGENT_OWNER_TOKEN = originalOwnerToken;
});

describe("footer registration", () => {
  test("does no work and registers no handlers in a subagent", () => {
    process.env.PI_SUBAGENT_OWNER_TOKEN = "owner-token";
    const { pi, state } = createFakePi();
    let dependencyReads = 0;
    const dependencies = {
      get fetchAnthropicQuota() {
        dependencyReads += 1;
        return async () => null;
      },
    };

    footer(pi, dependencies);

    expect(dependencyReads).toBe(0);
    expect(state.handlers.size).toBe(0);
  });

  test("registers the normal main-session lifecycle handlers", () => {
    const { pi, state } = createFakePi();

    footer(pi);

    expect([...state.handlers.keys()]).toEqual([
      "session_start",
      "model_select",
      "thinking_level_select",
      "agent_start",
      "turn_end",
      "agent_settled",
      "after_provider_response",
      "session_shutdown",
    ]);
  });
});

describe("footer formatting", () => {
  test("formats token counts and bounded progress bars", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12_400)).toBe("12k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(progressBar(-1, 4)).toBe("░░░░");
    expect(progressBar(150, 4)).toBe("▓▓▓▓");
  });

  test("keeps columns within the available width", () => {
    const rendered = columns("a very long branch name", "model/context", 20);
    expect(Bun.stringWidth(rendered)).toBeLessThanOrEqual(20);
  });

  test("creates independent empty state values", () => {
    expect(emptyModelInfoState().modelId).toBe("no-model");
    expect(emptyGitInfoState()).toEqual({ branch: null, changedFiles: 0, pullRequest: null });
  });

  test("moves footer information into a bounded right sidebar", async () => {
    const { pi, emit } = createFakePi();
    let renderFooter: ((width: number) => string[]) | undefined;
    let renderSidebar: ((width: number) => string[]) | undefined;
    let hiddenOverlays = 0;
    const tui = {
      requestRender() {},
      render: (_width: number) => [],
      terminal: { columns: 120, rows: 30 },
    };
    const theme = {
      fg: (_color: string, value: string) => value,
      bold: (value: string) => value,
    };
    const footerData = {
      getExtensionStatuses: () => new Map([["long-status", "a very long extension status"]]),
      onBranchChange: () => () => undefined,
    };
    const ui = {
      setFooter(factory?: (...args: unknown[]) => { render(width: number): string[] }) {
        if (!factory) {
          renderFooter = undefined;
          return;
        }
        const component = factory(tui, theme, footerData);
        renderFooter = (width) => component.render(width);
      },
      custom(
        factory: (...args: unknown[]) => { render(width: number): string[] },
        options: { onHandle?: (handle: { hide(): void }) => void },
      ) {
        return new Promise<void>((resolve) => {
          const component = factory(tui, theme, {}, resolve);
          renderSidebar = (width) => component.render(width);
          options.onHandle?.({
            hide() {
              hiddenOverlays += 1;
            },
          });
        });
      },
      setTitle() {},
    };
    const ctx = {
      mode: "tui",
      cwd: "/a/very/long/project/directory",
      model: { provider: "openai", id: "a-very-long-model-name", contextWindow: 200_000 },
      getContextUsage: () => ({ tokens: 12_345, contextWindow: 200_000, percent: 6.2 }),
      ui,
    };
    footer(pi);
    await emit("session_start", {}, ctx);

    expect(renderFooter?.(80)).toEqual([]);
    tui.terminal.columns = 80;
    expect(renderFooter?.(80).join("\n")).toContain("Context:");
    tui.terminal.columns = 120;
    expect(renderSidebar).toBeDefined();
    for (const width of [28, 36, 44]) {
      const lines = renderSidebar!(width);
      expect(lines).toHaveLength(30);
      expect(lines.every((line) => Bun.stringWidth(line) <= width)).toBeTrue();
    }
    expect(renderSidebar!(44).join("\n")).toContain("AGENT");
    expect(renderSidebar!(44).join("\n")).toContain("CONTEXT");
    await emit("session_shutdown", {}, ctx);
    expect(hiddenOverlays).toBe(1);
  });
});

describe("footer quota lifecycle", () => {
  function context(mode: "tui" | "rpc", provider = "anthropic") {
    return {
      mode,
      cwd: "/project",
      model: {
        provider,
        id: `${provider}-model`,
        contextWindow: 100_000,
        baseUrl: "http://127.0.0.1:3456",
      },
      getContextUsage: () => null,
      ui: {
        setHeader() {},
        setFooter() {},
        setTitle() {},
      },
    };
  }

  test("does not request Anthropic quota outside TUI mode", async () => {
    const { pi, emit } = createFakePi();
    const signals: AbortSignal[] = [];
    footer(pi, {
      fetchAnthropicQuota: (_baseUrl, signal) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
    });
    const ctx = context("rpc");

    await emit("session_start", {}, ctx);
    await emit("model_select", { model: ctx.model }, ctx);
    expect(signals).toHaveLength(0);
    await emit("session_shutdown", {}, ctx);
  });

  test("aborts quota requests on model changes and shutdown", async () => {
    const { pi, emit } = createFakePi();
    const baseUrls: string[] = [];
    const signals: AbortSignal[] = [];
    footer(pi, {
      fetchAnthropicQuota: (baseUrl, signal) => {
        baseUrls.push(baseUrl);
        signals.push(signal);
        return new Promise(() => undefined);
      },
    });
    const ctx = context("tui");

    await emit("session_start", {}, ctx);
    expect(signals).toHaveLength(1);
    ctx.model = { ...ctx.model, provider: "openai", id: "openai-model" };
    await emit("model_select", { model: ctx.model }, ctx);
    expect(signals[0]!.aborted).toBeTrue();

    ctx.model = { ...ctx.model, provider: "anthropic", id: "another-anthropic-model" };
    await emit("model_select", { model: ctx.model }, ctx);
    expect(signals).toHaveLength(2);
    expect(baseUrls).toEqual(["http://127.0.0.1:3456", "http://127.0.0.1:3456"]);
    await emit("session_shutdown", {}, ctx);
    expect(signals[1]!.aborted).toBeTrue();
  });
});
