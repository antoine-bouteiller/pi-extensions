import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { emptyGitInfoState, emptyModelInfoState, type GitInfoState, type ModelInfoState, type ProviderQuota } from "./state";
import { columns, formatDirectory, formatTokens, progressBar, progressLine } from "./render";
import { fetchGitInfo } from "./git";
import { AnthropicQuotaPoller, quotaFromHeaders, type QuotaFetcher } from "./provider";
import { createSidebarController, type SidebarController, type SidebarState } from "./sidebar";
import { MIN_MAIN_WIDTH, MIN_SIDEBAR_WIDTH } from "./split-pane";
import { runningAgents } from "../shared/agent-activity";

const ANTHROPIC_QUOTA_REFRESH_MS = 15_000;

interface FooterDependencies {
  fetchAnthropicQuota?: QuotaFetcher;
}

export default function footer(pi: ExtensionAPI, dependencies: FooterDependencies = {}) {
  if (process.env.PI_SUBAGENT_OWNER_TOKEN !== undefined) return;

  let modelInfo: ModelInfoState = emptyModelInfoState();
  let gitInfo: GitInfoState = emptyGitInfoState();
  let providerQuota: ProviderQuota | null = null;
  let activity: SidebarState["activity"] = "ready";
  let sidebar: SidebarController | undefined;
  let footerData: ReadonlyFooterDataProvider | undefined;
  let requestRender: (() => void) | undefined;
  runningAgents.subscribe(() => requestRender?.());
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

  function extensionStatuses() {
    return Array.from(footerData?.getExtensionStatuses().entries() ?? [])
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, text]) => text.split("\n"));
  }

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    sidebar?.dispose();
    footerData = undefined;
    ctx.ui.setFooter((tui, theme, data: ReadonlyFooterDataProvider) => {
      footerData = data;
      const unsubscribe = data.onBranchChange?.(() => {
        void refreshGit();
        tui.requestRender();
      });
      return {
        render(width: number) {
          if (tui.terminal.columns >= MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH) return [];
          const directory = theme.fg("text", formatDirectory(ctx.cwd));
          const model = theme.fg("muted", `${modelInfo.modelId} · ${modelInfo.thinking}`);
          const percent = modelInfo.contextPercent ?? 0;
          const tokens = formatTokens(modelInfo.contextTokens ?? 0);
          const window = modelInfo.contextWindow > 0 ? formatTokens(modelInfo.contextWindow) : "?";
          const context = `Context: ${progressBar(percent, 8)} ${tokens}/${window} (${Math.round(percent)}%)`;
          const lines = [
            columns(directory, model, width),
            truncateToWidth(theme.fg("muted", context), width),
          ];
          if (gitInfo.branch) {
            const fileLabel = gitInfo.changedFiles === 1 ? "file" : "files";
            lines.push(
              truncateToWidth(
                theme.fg(
                  "muted",
                  `${gitInfo.branch} · ${gitInfo.changedFiles} ${fileLabel} changed`,
                ),
                width,
              ),
            );
          }
          if (providerQuota) {
            const label = providerQuota.label === "anthropic" ? "Session" : "Azure";
            lines.push(
              truncateToWidth(
                theme.fg(
                  "muted",
                  progressLine(label, providerQuota.percent, providerQuota.detail ?? "", 8),
                ),
                width,
              ),
            );
          }
          for (const status of extensionStatuses()) lines.push(truncateToWidth(status, width));
          return lines;
        },
        invalidate() {},
        dispose() {
          unsubscribe?.();
          if (footerData === data) footerData = undefined;
        },
      };
    });
    sidebar = createSidebarController({
      ctx,
      getState: () => ({
        activity,
        cwd: ctx.cwd,
        model: modelInfo,
        git: gitInfo,
        quota: providerQuota,
        agents: runningAgents.list(),
        extensionStatuses: extensionStatuses(),
      }),
      onError: () => undefined,
    });
    requestRender = () => sidebar?.requestRender();
    sidebar.show();
    ctx.ui.setTitle(`pi · ${formatDirectory(ctx.cwd)}`);
    refreshModel(ctx);
    void refreshGit();
  }

  pi.on("session_start", (_event, ctx) => {
    anthropicQuota.stop();
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    providerQuota = null;
    activity = "ready";
    install(ctx);
    if (ctx.mode !== "tui") refreshModel(ctx);
    if (ctx.mode === "tui" && ctx.model?.provider === "anthropic")
      anthropicQuota.start(ctx.model.baseUrl);
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
    if (ctx.mode === "tui" && event.model.provider === "anthropic")
      anthropicQuota.start(event.model.baseUrl);
  });
  pi.on("thinking_level_select", (event) => {
    modelInfo = { ...modelInfo, thinking: event.level };
    requestRender?.();
  });
  pi.on("agent_start", () => {
    activity = "working";
    requestRender?.();
  });
  pi.on("turn_end", (_event, ctx) => {
    refreshModel(ctx);
    void refreshGit();
  });
  pi.on("agent_settled", (_event, ctx) => {
    activity = "ready";
    refreshModel(ctx);
  });
  pi.on("after_provider_response", (event) => {
    const quota = quotaFromHeaders(modelInfo.provider, event.headers);
    if (quota) {
      providerQuota = quota;
      requestRender?.();
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    anthropicQuota.stop();
    sidebar?.dispose();
    sidebar = undefined;
    footerData = undefined;
    requestRender = undefined;
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
