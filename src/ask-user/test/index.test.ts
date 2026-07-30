import { describe, expect, test } from "bun:test";
import {
  CURSOR_MARKER,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { createFakePi } from "#test-utils/fake-pi";
import askUser from "../index";

type AskUserTool = {
  execute: (
    toolCallId: string,
    params: {
      question: string;
      options: Array<{ label: string; description?: string }>;
    },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: Record<string, any>,
  ) => Promise<any>;
};

type PromptComponent = Component & Focusable;

const params = {
  question: "When should this ship?",
  options: [{ label: "Now" }, { label: "Tomorrow" }],
};

function setup() {
  let component: PromptComponent | undefined;
  let customCalls = 0;
  const tui = {
    requestRender: () => undefined,
    terminal: { rows: 24 },
  };
  const theme = {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  const ui = {
    custom: (factory: (...args: any[]) => PromptComponent) => {
      customCalls++;
      return new Promise<unknown>((resolve) => {
        component = factory(tui, theme, {}, resolve);
      });
    },
  };

  const fakePi = createFakePi();
  askUser(fakePi.pi);
  const tool = fakePi.state.tools.get("ask_user") as unknown as AskUserTool;

  return {
    tool,
    tuiContext: { mode: "tui", ui },
    nonTuiContext: { mode: "rpc", ui },
    get component() {
      return component!;
    },
    get customCalls() {
      return customCalls;
    },
  };
}

function type(component: PromptComponent, text: string) {
  for (const character of text) component.handleInput?.(character);
}

describe("ask_user tool behavior", () => {
  test("returns the selected answer and option number", async () => {
    const fixture = setup();
    const pending = fixture.tool.execute(
      "call-1",
      params,
      undefined,
      undefined,
      fixture.tuiContext,
    );

    fixture.component.handleInput?.("2");
    const result = await pending;

    expect(result.content[0].text).toBe("User selected option 2: Tomorrow");
    expect(result.details).toMatchObject({
      answer: "Tomorrow",
      wasCustom: false,
      cancelled: false,
    });
  });

  test("reports dismissal without selecting an answer", async () => {
    const fixture = setup();
    const pending = fixture.tool.execute(
      "call-2",
      params,
      undefined,
      undefined,
      fixture.tuiContext,
    );

    fixture.component.handleInput?.("\x1b");
    const result = await pending;

    expect(result.content[0].text).toContain("User dismissed the question");
    expect(result.details).toMatchObject({ answer: null, cancelled: true });
  });

  test("reports cancellation when aborted while the prompt is open", async () => {
    const fixture = setup();
    const controller = new AbortController();
    const pending = fixture.tool.execute(
      "call-3",
      params,
      controller.signal,
      undefined,
      fixture.tuiContext,
    );

    controller.abort();
    const result = await pending;

    expect(result.content[0].text).toBe("Cancelled");
    expect(result.details).toMatchObject({ answer: null, cancelled: true });
  });

  test("submits trimmed custom input", async () => {
    const fixture = setup();
    const pending = fixture.tool.execute(
      "call-4",
      params,
      undefined,
      undefined,
      fixture.tuiContext,
    );

    fixture.component.handleInput?.("3");
    type(fixture.component, "  Wait until Friday  ");
    fixture.component.handleInput?.("\r");
    const result = await pending;

    expect(result.content[0].text).toBe("User wrote their own answer: Wait until Friday");
    expect(result.details).toMatchObject({
      answer: "Wait until Friday",
      wasCustom: true,
      cancelled: false,
    });
  });

  test("returns a plain-text fallback without opening UI outside TUI mode", async () => {
    const fixture = setup();
    const result = await fixture.tool.execute(
      "call-5",
      params,
      undefined,
      undefined,
      fixture.nonTuiContext,
    );

    expect(result.content[0].text).toContain("Ask the user in plain text instead");
    expect(result.details).toMatchObject({ answer: null, cancelled: true });
    expect(fixture.customCalls).toBe(0);
  });
});

describe("ask_user prompt component", () => {
  test("propagates focus to the embedded editor for IME cursor positioning", async () => {
    const fixture = setup();
    const pending = fixture.tool.execute(
      "call-6",
      params,
      undefined,
      undefined,
      fixture.tuiContext,
    );

    fixture.component.focused = true;
    fixture.component.handleInput?.("3");

    expect(fixture.component.render(40).join("\n")).toContain(CURSOR_MARKER);

    fixture.component.handleInput?.("\x1b");
    fixture.component.handleInput?.("\x1b");
    await pending;
  });

  test("wraps wide Unicode content and invalidates its cache when width changes", async () => {
    const fixture = setup();
    const pending = fixture.tool.execute(
      "call-7",
      {
        question: "界界界界",
        options: [
          { label: "A long first option", description: "A long explanatory description" },
          { label: "Second option" },
        ],
      },
      undefined,
      undefined,
      fixture.tuiContext,
    );

    fixture.component.render(40);
    const narrowLines = fixture.component.render(8);

    expect(narrowLines.every((line) => visibleWidth(line) <= 8)).toBeTrue();
    expect(narrowLines.join("").match(/界/g)).toHaveLength(4);

    fixture.component.handleInput?.("\x1b");
    await pending;
  });
});
