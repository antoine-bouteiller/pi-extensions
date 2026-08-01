import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSidebarLines, type SidebarState } from "../sidebar";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const state: SidebarState = {
  activity: "working",
  cwd: "/Users/example/pi-extensions",
  model: {
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
    thinking: "medium",
    contextTokens: 31_000,
    contextWindow: 272_000,
    contextPercent: 11.5,
  },
  git: {
    branch: "feature/sidebar",
    changedFiles: 4,
    pullRequest: null,
  },
  quota: {
    label: "anthropic",
    percent: 42.3,
    windows: [
      { label: "Session", percent: 42.3, resetsIn: "2h 14m" },
      { label: "Weekly", percent: 18, resetsIn: "4d 6h" },
    ],
  },
  agents: [],
  extensionStatuses: ["index ready"],
};

const withAgents = (count: number): SidebarState => ({
  ...state,
  agents: Array.from({ length: count }, (_, index) => ({
    name: `/scout-${index}`,
    profile: "scout",
    color: "accent" as const,
  })),
});

const ANSI_PATTERN = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsi(text: string) {
  return text.replace(ANSI_PATTERN, "");
}

describe("footer sidebar rendering", () => {
  test("renders the Atelier-style information hierarchy", () => {
    const lines = renderSidebarLines(state, theme, 44, 36, 0);
    const text = stripAnsi(lines.join("\n"));

    expect(lines).toHaveLength(36);
    expect(lines.every((line) => visibleWidth(line) <= 44)).toBeTrue();
    expect(lines.every((line) => stripAnsi(line).startsWith("│ "))).toBeTrue();
    expect(text).toContain("╭─ ✦ AGENT");
    expect(text).toContain("◆ Working");
    expect(text).toContain("gpt-5.6-sol");
    expect(text).toContain("╭─ ✦ CONTEXT");
    expect(text).toContain("31k / 272k");
    expect(text).toContain("11.5%");
    expect(text).toContain("╭─ ✦ WORKSPACE");
    expect(text).toContain("feature/sidebar");
    expect(text).toContain("4 files changed");
    expect(text).toContain("╭─ ✦ QUOTA");
  });

  test("renders session and weekly quota as matching bars with their time left", () => {
    const lines = renderSidebarLines(state, theme, 44, 36, 0).map(stripAnsi);
    const quotaIndex = lines.findIndex((line) => line.includes("QUOTA"));
    const [session, sessionMeter, weekly, weeklyMeter] = lines.slice(quotaIndex + 1, quotaIndex + 5);

    expect(session).toContain("Session");
    expect(session).toContain("42.3%");
    expect(sessionMeter).toMatch(/■+·+ +2h 14m/);
    expect(weekly).toContain("Weekly");
    expect(weekly).toContain("18.0%");
    expect(weeklyMeter).toMatch(/■+·+ +4d 6h/);
    expect(sessionMeter!.indexOf("2h 14m") + "2h 14m".length).toBe(
      weeklyMeter!.indexOf("4d 6h") + "4d 6h".length,
    );
  });

  test("falls back to a single labelled bar when the provider reports no windows", () => {
    const text = stripAnsi(
      renderSidebarLines(
        { ...state, quota: { label: "azure", percent: 71 } },
        theme,
        44,
        36,
        0,
      ).join("\n"),
    );

    expect(text).toContain("Azure");
    expect(text).toContain("71.0%");
  });

  test("pulses only the working Agent jewel", () => {
    const first = stripAnsi(renderSidebarLines(state, theme, 44, 20, 0).join("\n"));
    const second = stripAnsi(renderSidebarLines(state, theme, 44, 20, 400).join("\n"));

    expect(first).toContain("╭─ ✦ AGENT");
    expect(second).toContain("╭─ ✧ AGENT");
    expect(second).toContain("╭─ ✦ CONTEXT");
  });

  test("lists running subagents and hides the panel when none are running", () => {
    const text = stripAnsi(renderSidebarLines(withAgents(2), theme, 44, 36, 0).join("\n"));

    expect(text).toContain("╭─ ✦ SUBAGENTS");
    expect(text).toContain("▸ /scout-0");
    expect(text).toContain("▸ /scout-1");
    expect(text).toContain("scout");
    expect(stripAnsi(renderSidebarLines(state, theme, 44, 36, 0).join("\n"))).not.toContain(
      "SUBAGENTS",
    );
  });

  test("caps the subagent list so a large fan-out cannot crowd out other panels", () => {
    const text = stripAnsi(renderSidebarLines(withAgents(9), theme, 44, 40, 0).join("\n"));

    expect(text).toContain("▸ /scout-4");
    expect(text).not.toContain("▸ /scout-5");
    expect(text).toContain("+4 more");
  });

  test("keeps running subagents visible after other optional panels are dropped", () => {
    const text = stripAnsi(renderSidebarLines(withAgents(2), theme, 44, 20, 0).join("\n"));

    expect(text).toContain("SUBAGENTS");
    expect(text).not.toContain("QUOTA");
    expect(text).not.toContain("STATUS");
  });

  test("drops optional panels as terminal height contracts", () => {
    const text = stripAnsi(renderSidebarLines(state, theme, 44, 12, 0).join("\n"));

    expect(text).toContain("AGENT");
    expect(text).toContain("CONTEXT");
    expect(text).not.toContain("WORKSPACE");
    expect(text).not.toContain("QUOTA");
    expect(text).not.toContain("STATUS");
  });

  test("keeps output bounded at narrow sidebar widths", () => {
    const long: SidebarState = {
      ...state,
      cwd: `/Users/example/${"界".repeat(60)}`,
      model: { ...state.model, modelId: `model-${"x".repeat(100)}` },
      extensionStatuses: [`status ${"z".repeat(100)}`],
    };

    for (const width of [1, 2, 8, 28, 44]) {
      const lines = renderSidebarLines(long, theme, width, 24);
      expect(lines).toHaveLength(24);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBeTrue();
    }
    expect(stripAnsi(renderSidebarLines(long, theme, 28, 24).join("\n"))).toContain("◆ Working");
  });

  test("renders unavailable context explicitly", () => {
    const unavailable = {
      ...state,
      model: { ...state.model, contextTokens: null, contextPercent: null },
    };
    const text = stripAnsi(renderSidebarLines(unavailable, theme, 44, 20).join("\n"));

    expect(text).toContain("Context unavailable");
  });
});
