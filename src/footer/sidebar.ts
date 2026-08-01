import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { getCapabilities, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GitInfoState, ModelInfoState, ProviderQuota, QuotaWindow } from "./state";
import type { RunningAgent } from "../shared/agent-activity";
import { formatDirectory, formatTokens } from "./render";
import { createSplitPaneController, type SplitPaneController } from "./split-pane";

export interface SidebarTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

export interface SidebarState {
  activity: "ready" | "working";
  cwd: string;
  model: ModelInfoState;
  git: GitInfoState;
  quota: ProviderQuota | null;
  agents: readonly RunningAgent[];
  extensionStatuses: readonly string[];
}

const MAX_AGENT_ROWS = 5;

type PaletteRole = "accent" | "primary" | "muted" | "dim" | "ready" | "working" | "context" | "warning" | "error";
type Rgb = readonly [number, number, number];

const COLORS: Record<PaletteRole, Rgb> = {
  accent: [177, 140, 255],
  primary: [212, 212, 212],
  muted: [128, 128, 128],
  dim: [102, 102, 102],
  ready: [110, 168, 254],
  working: [255, 159, 67],
  context: [110, 168, 254],
  warning: [255, 159, 67],
  error: [255, 93, 115],
};

const THEME_ROLES: Record<PaletteRole, string> = {
  accent: "accent",
  primary: "text",
  muted: "muted",
  dim: "dim",
  ready: "success",
  working: "warning",
  context: "thinkingLow",
  warning: "warning",
  error: "error",
};

function paint(theme: SidebarTheme, role: PaletteRole, text: string) {
  if (process.env.NO_COLOR !== undefined || !getCapabilities().trueColor)
    return theme.fg(THEME_ROLES[role]!, text);
  const [red, green, blue] = COLORS[role];
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}

function bold(theme: SidebarTheme, text: string) {
  return theme.bold?.(text) ?? text;
}

const ANSI_PATTERN = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");

function sanitize(text: string) {
  return [...text.replace(ANSI_PATTERN, "")]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function pad(text: string, width: number) {
  const content = truncateToWidth(text, Math.max(0, width), "");
  return `${content}${" ".repeat(Math.max(0, width - visibleWidth(content)))}`;
}

function spaced(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width, "");
  const leftWidth = Math.min(visibleWidth(left), Math.max(0, Math.floor(width * 0.55)));
  const fittedLeft = truncateToWidth(left, leftWidth, "");
  const fittedRight = truncateToWidth(right, Math.max(0, width - visibleWidth(fittedLeft) - 1), "");
  const gap = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight)));
  return truncateToWidth(`${fittedLeft}${gap}${fittedRight}`, width, "");
}

function panel(
  title: string,
  rows: readonly string[],
  width: number,
  theme: SidebarTheme,
  role: PaletteRole,
  jewel = "✦",
) {
  if (width <= 0) return [];
  const innerWidth = Math.max(0, width - 4);
  const safeTitle = sanitize(title).toUpperCase();
  const prefix = `╭─ ${jewel} `;
  const fill = "─".repeat(Math.max(0, width - visibleWidth(prefix) - visibleWidth(safeTitle) - 2));
  const top = truncateToWidth(
    `${paint(theme, role, prefix)}${bold(theme, paint(theme, role, safeTitle))} ${paint(theme, role, `${fill}╮`)}`,
    width,
    "",
  );
  const body = rows.map((row) =>
    truncateToWidth(
      `${paint(theme, "dim", "│")} ${pad(row, innerWidth)} ${paint(theme, "dim", "│")}`,
      width,
      "",
    ),
  );
  const bottom = paint(theme, "dim", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
  return [top, ...body, truncateToWidth(bottom, width, ""), ""];
}

function contextRole(percent: number | null): PaletteRole {
  if (percent === null || !Number.isFinite(percent)) return "dim";
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  return "context";
}

function agentRows(state: SidebarState, width: number, theme: SidebarTheme) {
  const working = state.activity === "working";
  const status = bold(
    theme,
    paint(theme, working ? "working" : "ready", `${working ? "◆ Working" : "● Ready"}`),
  );
  const model = paint(theme, "primary", sanitize(state.model.modelId) || "no model");
  const metadata = [state.model.provider, state.model.thinking]
    .map((value) => sanitize(value).toUpperCase())
    .filter(Boolean)
    .join(` ${paint(theme, "dim", "·")} `);
  return [spaced(status, model, width), metadata ? paint(theme, "muted", metadata) : paint(theme, "dim", "—")];
}

function contextRows(state: SidebarState, width: number, theme: SidebarTheme) {
  const { contextPercent, contextTokens, contextWindow } = state.model;
  if (contextPercent === null || contextTokens === null) return [paint(theme, "dim", "Context unavailable")];
  const role = contextRole(contextPercent);
  const usage = `${formatTokens(contextTokens)} / ${contextWindow > 0 ? formatTokens(contextWindow) : "—"}`;
  const percent = `${contextPercent.toFixed(1)}%`;
  const meterWidth = Math.max(1, Math.min(16, width - 2));
  const filled = Math.max(0, Math.min(meterWidth, Math.round((contextPercent / 100) * meterWidth)));
  const meter = `${paint(theme, "dim", "[")}${paint(theme, role, "■".repeat(filled))}${paint(
    theme,
    "dim",
    "·".repeat(meterWidth - filled),
  )}${paint(theme, "dim", "]")}`;
  return [spaced(paint(theme, role, usage), paint(theme, role, percent), width), meter];
}

function subagentRow(agent: RunningAgent, width: number, theme: SidebarTheme) {
  const marker = "▸ ";
  const profile = truncateToWidth(sanitize(agent.profile ?? ""), Math.floor(width * 0.4), "…");
  const nameWidth = width - visibleWidth(marker) - (profile ? visibleWidth(profile) + 1 : 0);
  const name = truncateToWidth(sanitize(agent.name), Math.max(0, nameWidth), "…");
  const gap = " ".repeat(
    Math.max(profile ? 1 : 0, width - visibleWidth(marker) - visibleWidth(name) - visibleWidth(profile)),
  );
  return truncateToWidth(
    `${paint(theme, "dim", marker)}${theme.fg(agent.color, name)}${gap}${paint(theme, "muted", profile)}`,
    width,
    "",
  );
}

function subagentRows(agents: readonly RunningAgent[], width: number, theme: SidebarTheme) {
  const shown = agents.slice(0, MAX_AGENT_ROWS);
  const rows = shown.map((agent) => subagentRow(agent, width, theme));
  if (agents.length > shown.length)
    rows.push(paint(theme, "dim", `+${agents.length - shown.length} more`));
  return rows;
}

function workspaceRows(state: SidebarState, theme: SidebarTheme) {
  const project = basename(state.cwd) || formatDirectory(state.cwd);
  const rows = [paint(theme, "primary", sanitize(project)), paint(theme, "muted", formatDirectory(state.cwd))];
  if (state.git.branch) {
    const fileLabel = state.git.changedFiles === 1 ? "file" : "files";
    const change = state.git.changedFiles > 0 ? `${state.git.changedFiles} ${fileLabel} changed` : "clean";
    rows.push(
      `${paint(theme, "accent", sanitize(state.git.branch))} ${paint(theme, "dim", "·")} ${paint(
        theme,
        state.git.changedFiles > 0 ? "warning" : "ready",
        change,
      )}`,
    );
  } else {
    rows.push(paint(theme, "dim", "not a Git repository"));
  }
  if (state.git.pullRequest) rows.push(paint(theme, "accent", `PR #${state.git.pullRequest.number}`));
  return rows;
}

function quotaPercent(percent: number) {
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
}

function quotaRole(percent: number): PaletteRole {
  return percent >= 90 ? "error" : percent >= 70 ? "warning" : "context";
}

function quotaWindowRows(window: QuotaWindow, width: number, theme: SidebarTheme) {
  const percent = quotaPercent(window.percent);
  const role = quotaRole(percent);
  const resetsIn = sanitize(window.resetsIn ?? "");
  const meterWidth = Math.max(1, Math.min(12, width - (resetsIn ? visibleWidth(resetsIn) + 1 : 0)));
  const filled = Math.max(0, Math.min(meterWidth, Math.round((percent / 100) * meterWidth)));
  const meter = `${paint(theme, role, "■".repeat(filled))}${paint(theme, "dim", "·".repeat(meterWidth - filled))}`;
  const header = spaced(
    paint(theme, role, sanitize(window.label)),
    paint(theme, role, `${percent.toFixed(1)}%`),
    width,
  );
  if (!resetsIn) return [header, meter];
  const gap = " ".repeat(Math.max(1, width - meterWidth - visibleWidth(resetsIn)));
  return [header, truncateToWidth(`${meter}${gap}${paint(theme, "muted", resetsIn)}`, width, "")];
}

function quotaRows(quota: ProviderQuota, width: number, theme: SidebarTheme) {
  const windows: readonly QuotaWindow[] = quota.windows?.length
    ? quota.windows
    : [{ label: quota.label === "anthropic" ? "Session" : "Azure", percent: quota.percent }];
  const rows = windows.flatMap((window) => quotaWindowRows(window, width, theme));
  if (!quota.windows?.length && quota.detail) rows.push(paint(theme, "muted", sanitize(quota.detail)));
  return rows;
}

function statusRows(statuses: readonly string[], theme: SidebarTheme) {
  return statuses.map((status) => paint(theme, "muted", sanitize(status))).filter((status) => sanitize(status));
}

interface PanelGroup {
  name: string;
  rows: string[];
  required: boolean;
  dropRank: number;
}

export function renderSidebarLines(
  state: SidebarState,
  theme: SidebarTheme,
  width: number,
  height: number,
  now = Date.now(),
) {
  const safeWidth = Math.max(0, Math.trunc(width));
  const safeHeight = Math.max(0, Math.trunc(height));
  if (safeWidth === 0 || safeHeight === 0) return [];
  const panelWidth = Math.max(0, safeWidth - 2);
  const rowWidth = Math.max(0, panelWidth - 4);
  const groups: PanelGroup[] = [
    {
      name: "agent",
      rows: panel("AGENT", agentRows(state, rowWidth, theme), panelWidth, theme, state.activity === "working" ? "working" : "ready", state.activity === "working" && Math.floor(now / 400) % 2 ? "✧" : "✦"),
      required: true,
      dropRank: Number.POSITIVE_INFINITY,
    },
    {
      name: "context",
      rows: panel("CONTEXT", contextRows(state, rowWidth, theme), panelWidth, theme, contextRole(state.model.contextPercent)),
      required: true,
      dropRank: Number.POSITIVE_INFINITY,
    },
    ...(state.agents.length > 0
      ? [
          {
            name: "subagents",
            rows: panel(
              "SUBAGENTS",
              subagentRows(state.agents, rowWidth, theme),
              panelWidth,
              theme,
              "accent",
            ),
            required: false,
            dropRank: 40,
          },
        ]
      : []),
    {
      name: "workspace",
      rows: panel("WORKSPACE", workspaceRows(state, theme), panelWidth, theme, "accent"),
      required: false,
      dropRank: 30,
    },
    ...(state.quota
      ? [{ name: "quota", rows: panel("QUOTA", quotaRows(state.quota, rowWidth, theme), panelWidth, theme, quotaRole(quotaPercent(state.quota.percent))), required: false, dropRank: 20 }]
      : []),
  ];
  const statuses = statusRows(state.extensionStatuses, theme);
  if (statuses.length > 0) {
    groups.push({
      name: "statuses",
      rows: panel("STATUS", statuses, panelWidth, theme, "muted"),
      required: false,
      dropRank: 10,
    });
  }

  let visible = groups;
  while (visible.flatMap((group) => group.rows).length > safeHeight) {
    const droppable = visible
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => !group.required)
      .sort((left, right) => left.group.dropRank - right.group.dropRank)[0];
    if (!droppable) break;
    visible = visible.filter((_, index) => index !== droppable.index);
  }
  const contentRows = visible.flatMap((group) => group.rows).slice(0, safeHeight);
  const divider = paint(theme, "dim", "│");
  return Array.from({ length: safeHeight }, (_, index) => {
    const content = truncateToWidth(contentRows[index] ?? "", panelWidth, "");
    return truncateToWidth(`${divider} ${pad(content, panelWidth)}`, safeWidth, "");
  });
}

export interface SidebarController {
  show(): void;
  hide(): void;
  isVisible(): boolean;
  requestRender(): void;
  dispose(): void;
}

interface SidebarControllerOptions {
  ctx: ExtensionContext;
  getState(): SidebarState;
  onError?(error: unknown): void;
}

export function createSidebarController(options: SidebarControllerOptions): SidebarController {
  let enabled = false;
  let disposed = false;
  let generation = 0;
  let overlayHandle: OverlayHandle | undefined;
  let requestOverlayRender: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const split: SplitPaneController = createSplitPaneController({ onError: options.onError });

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function startTimer() {
    if (timer || options.getState().activity !== "working") return;
    timer = setInterval(() => requestOverlayRender?.(), 400);
    timer.unref?.();
  }

  function hide() {
    if (!enabled && !overlayHandle) return;
    enabled = false;
    generation += 1;
    stopTimer();
    const handle = overlayHandle;
    overlayHandle = undefined;
    requestOverlayRender = undefined;
    handle?.hide();
    split.hide();
  }

  function show() {
    if (disposed || enabled || options.ctx.mode !== "tui") return;
    enabled = true;
    const currentGeneration = ++generation;
    split.show();
    try {
      const pending = options.ctx.ui.custom<void>(
        (tui, theme) => {
          let attached = true;
          try {
            split.attach(tui);
          } catch (error) {
            attached = false;
            options.onError?.(error);
            enabled = false;
            split.hide();
          }
          if (attached && enabled && generation === currentGeneration) {
            requestOverlayRender = () => tui.requestRender();
            startTimer();
          }
          return {
            render: (sidebarWidth: number) =>
              renderSidebarLines(options.getState(), theme, sidebarWidth, tui.terminal.rows),
            invalidate() {},
          } satisfies Component;
        },
        {
          overlay: true,
          overlayOptions: () => split.overlayOptions(),
          onHandle: (handle) => {
            if (enabled && generation === currentGeneration) overlayHandle = handle;
            else handle.hide();
          },
        },
      );
      void pending
        .catch((error: unknown) => options.onError?.(error))
        .finally(() => {
          if (generation !== currentGeneration) return;
          enabled = false;
          stopTimer();
          overlayHandle = undefined;
          requestOverlayRender = undefined;
          split.hide();
        });
    } catch (error) {
      enabled = false;
      split.hide();
      options.onError?.(error);
    }
  }

  return {
    show,
    hide,
    isVisible: () => enabled,
    requestRender() {
      if (requestOverlayRender) requestOverlayRender();
      else split.requestRender();
      if (options.getState().activity === "working") startTimer();
      else stopTimer();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      hide();
      split.dispose();
    },
  };
}
