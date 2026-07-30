import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth } from "@earendil-works/pi-tui";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  type GitInfoState,
  type ModelInfoState,
  type ProviderQuota,
} from "./state";
import {
  center,
  columns,
  DashboardTui,
  formatDirectory,
  formatTokens,
  gradientText,
  hideThemesSection,
  progressBar,
  progressLine,
  TITLE_LINES,
  BOLD,
  RESET,
} from "./render";
import { fetchGitInfo } from "./git";
import { AnthropicQuotaPoller, quotaFromHeaders, type QuotaFetcher } from "./provider";

const ANTHROPIC_QUOTA_REFRESH_MS = 15_000;

interface FooterDependencies {
  fetchAnthropicQuota?: QuotaFetcher;
}

export default function footer(pi: ExtensionAPI, dependencies: FooterDependencies = {}) {
  let title = "pi";
  let modelInfo: ModelInfoState = emptyModelInfoState();
  let gitInfo: GitInfoState = emptyGitInfoState();
  let providerQuota: ProviderQuota | null = null;
  let activeTui: DashboardTui | undefined;
  let requestRender: (() => void) | undefined;
  let themeRemovalTimers: Array<ReturnType<typeof setTimeout>> = [];
  const anthropicQuota = new AnthropicQuotaPoller(
    (quota) => {
      providerQuota = quota;
      requestRender?.();
    },
    {
      refreshMs: ANTHROPIC_QUOTA_REFRESH_MS,
      fetchQuota: dependencies.fetchAnthropicQuota,
    },
  );

  async function refreshGit() {
    gitInfo = await fetchGitInfo(pi);
    requestRender?.();
  }

  function refreshModel(ctx: ExtensionContext) {
    const model = ctx.model;
    const usage = ctx.getContextUsage();
    modelInfo = {
      ...modelInfo,
      provider: model?.provider ?? "",
      modelId: model?.id ?? "no-model",
      thinking: model?.reasoning ? pi.getThinkingLevel() : "off",
      contextTokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
      contextPercent: usage?.percent ?? null,
    };
    requestRender?.();
  }
  function scheduleThemeRemoval(tui: DashboardTui) {
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [0, 50, 250, 1_000].map((delay) =>
      setTimeout(() => {
        if (hideThemesSection(tui)) tui.requestRender(true);
      }, delay),
    );
  }
  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((tui) => {
      activeTui = tui;
      requestRender = () => tui.requestRender();
      scheduleThemeRemoval(tui);
      return {
        render(width: number) {
          const art = TITLE_LINES.map((line, row) =>
            center(gradientText(line, row * 0.045), width),
          );
          return ["", ...art, center(`${BOLD}${gradientText(title, 0.18)}${RESET}`, width), ""];
        },
        invalidate() {},
      };
    });
    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();
      return {
        invalidate() {},
        render(width: number) {
          const directory = theme.fg("text", formatDirectory(ctx.cwd));
          const fileLabel = gitInfo.changedFiles === 1 ? "file" : "files";
          let git = gitInfo.branch
            ? `${gitInfo.branch} · ${gitInfo.changedFiles} ${fileLabel} changed`
            : "";
          if (gitInfo.pullRequest) {
            const prLabel = `PR #${gitInfo.pullRequest.number}`;
            git += ` · ${getCapabilities().hyperlinks ? hyperlink(prLabel, gitInfo.pullRequest.url) : prLabel}`;
          }
          const contextPercent = modelInfo.contextPercent ?? 0;
          const contextWindow =
            modelInfo.contextWindow > 0 ? formatTokens(modelInfo.contextWindow) : "?";
          const contextTokens = formatTokens(modelInfo.contextTokens ?? 0);
          const context = `Context: ${progressBar(contextPercent, 10)} ${contextTokens}/${contextWindow} (${Math.round(contextPercent)}%)`;
          const model = `${modelInfo.modelId} · ${modelInfo.thinking}`;
          const limit = providerQuota
            ? progressLine(
                providerQuota.label === "anthropic" ? "Session" : "Azure",
                providerQuota.percent,
                providerQuota.detail ?? "",
              )
            : "";
          const lines = [
            columns(directory, theme.fg("muted", model), width),
            truncateToWidth(theme.fg("muted", limit ? `${context}  ${limit}` : context), width),
          ];
          if (git) lines.push(truncateToWidth(theme.fg("muted", git), width));
          const statusLines = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, text]) => text.split("\n"));
          for (const statusLine of statusLines)
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
          return lines;
        },
      };
    });
    ctx.ui.setTitle(`pi · ${title}`);
    refreshModel(ctx);
    void refreshGit();
  }

  pi.on("session_start", (_event, ctx) => {
    anthropicQuota.stop();
    title = formatDirectory(ctx.cwd);
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    providerQuota = null;
    install(ctx);
    if (ctx.mode !== "tui") refreshModel(ctx);
    if (ctx.mode === "tui" && ctx.model?.provider === "anthropic") anthropicQuota.start();
  });
  pi.on("model_select", (event, ctx) => {
    modelInfo = {
      ...modelInfo,
      provider: event.model.provider,
      modelId: event.model.id,
      thinking: event.model.reasoning ? pi.getThinkingLevel() : "off",
      contextWindow: event.model.contextWindow,
    };
    providerQuota = null;
    anthropicQuota.stop();
    refreshModel(ctx);
    void refreshGit();
    if (ctx.mode === "tui" && event.model.provider === "anthropic") anthropicQuota.start();
  });
  pi.on("thinking_level_select", (event) => {
    modelInfo = { ...modelInfo, thinking: event.level };
    requestRender?.();
  });
  pi.on("turn_end", (_event, ctx) => {
    refreshModel(ctx);
    void refreshGit();
  });
  pi.on("agent_settled", (_event, ctx) => refreshModel(ctx));
  pi.on("after_provider_response", (event) => {
    const quota = quotaFromHeaders(modelInfo.provider, event.headers);
    if (quota) {
      providerQuota = quota;
      requestRender?.();
    }
  });
  pi.on("resources_discover", () => {
    if (activeTui) scheduleThemeRemoval(activeTui);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    anthropicQuota.stop();
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [];
    activeTui = undefined;
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
