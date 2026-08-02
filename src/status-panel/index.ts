import { type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider } from '@earendil-works/pi-coding-agent'

import { runningAgents } from '../shared/agent_activity'
import { statusBar } from '../shared/status_bar'
import { renderFooterLines } from './footer'
import { fetchGitInfo } from './git'
import { AnthropicQuotaPoller, quotaFromHeaders, type QuotaFetcher } from './provider'
import { formatDirectory } from './render'
import { createSidebarController, type SidebarController, type SidebarState } from './sidebar'
import { MIN_MAIN_WIDTH, MIN_SIDEBAR_WIDTH } from './split_pane'
import { emptyGitInfoState, emptyModelInfoState, type GitInfoState, type ModelInfoState, type ProviderQuota } from './state'
import { collectStatuses } from './statuses'

const ANTHROPIC_QUOTA_REFRESH_MS = 15_000

interface StatusPanelDependencies {
  fetchAnthropicQuota?: QuotaFetcher
}

export default function statusPanel(pi: ExtensionAPI, dependencies: StatusPanelDependencies = {}) {
  if (process.env.PI_SUBAGENT_OWNER_TOKEN !== undefined) {
    return
  }

  let modelInfo: ModelInfoState = emptyModelInfoState()
  let gitInfo: GitInfoState = emptyGitInfoState()
  let providerQuota: ProviderQuota | undefined
  let activity: SidebarState['activity'] = 'ready'
  let sidebar: SidebarController | undefined
  let footerData: ReadonlyFooterDataProvider | undefined
  let requestRender: (() => void) | undefined
  runningAgents.subscribe(() => requestRender?.())
  statusBar.subscribe(() => requestRender?.())
  const anthropicQuota = new AnthropicQuotaPoller(
    (quota) => {
      providerQuota = quota
      requestRender?.()
    },
    {
      fetchQuota: dependencies.fetchAnthropicQuota,
      refreshMs: ANTHROPIC_QUOTA_REFRESH_MS,
    }
  )

  const refreshGit = async () => {
    gitInfo = await fetchGitInfo(pi)
    requestRender?.()
  }

  const applyModelInfo = (ctx: ExtensionContext) => {
    const { model } = ctx
    const usage = ctx.getContextUsage()
    return {
      ...modelInfo,
      contextPercent: usage?.percent ?? undefined,
      contextTokens: usage?.tokens ?? undefined,
      contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
      modelId: model?.id ?? 'no-model',
      provider: model?.provider ?? '',
      thinking: model?.reasoning ? pi.getThinkingLevel() : 'off',
    }
  }

  const refreshModel = (ctx: ExtensionContext) => {
    modelInfo = applyModelInfo(ctx)
    requestRender?.()
  }

  const install = (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') {
      return
    }
    sidebar?.dispose()
    footerData = undefined
    ctx.ui.setFooter((tui, theme, data: ReadonlyFooterDataProvider) => {
      footerData = data
      const unsubscribe = data.onBranchChange?.(() => {
        void refreshGit()
        tui.requestRender()
      })
      return {
        dispose() {
          unsubscribe?.()
          if (footerData === data) {
            footerData = undefined
          }
        },
        invalidate() {
          /* Empty */
        },
        render(width: number) {
          if (tui.terminal.columns >= MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH) {
            return []
          }
          return renderFooterLines(
            {
              cwd: ctx.cwd,
              git: gitInfo,
              model: modelInfo,
              quota: providerQuota,
              statuses: collectStatuses(footerData),
            },
            theme,
            width
          )
        },
      }
    })
    sidebar = createSidebarController({
      ctx,
      getState: () => ({
        activity,
        agents: runningAgents.list(),
        cwd: ctx.cwd,
        extensionStatuses: collectStatuses(footerData),
        git: gitInfo,
        model: modelInfo,
        quota: providerQuota,
      }),
      onError: () => undefined,
    })
    requestRender = () => sidebar?.requestRender()
    sidebar.show()
    ctx.ui.setTitle(`pi · ${formatDirectory(ctx.cwd)}`)
    refreshModel(ctx)
    void refreshGit()
  }

  pi.on('session_start', (_event, ctx) => {
    anthropicQuota.stop()
    modelInfo = emptyModelInfoState()
    gitInfo = emptyGitInfoState()
    providerQuota = undefined
    activity = 'ready'
    install(ctx)
    if (ctx.mode !== 'tui') {
      refreshModel(ctx)
    }
    if (ctx.mode === 'tui' && ctx.model?.provider === 'anthropic') {
      anthropicQuota.start(ctx.model.baseUrl)
    }
  })
  pi.on('model_select', (event, ctx) => {
    modelInfo = {
      ...modelInfo,
      contextWindow: event.model.contextWindow,
      modelId: event.model.id,
      provider: event.model.provider,
      thinking: event.model.reasoning ? pi.getThinkingLevel() : 'off',
    }
    providerQuota = undefined
    anthropicQuota.stop()
    refreshModel(ctx)
    void refreshGit()
    if (ctx.mode === 'tui' && event.model.provider === 'anthropic') {
      anthropicQuota.start(event.model.baseUrl)
    }
  })
  pi.on('thinking_level_select', (event) => {
    modelInfo = { ...modelInfo, thinking: event.level }
    requestRender?.()
  })
  pi.on('agent_start', () => {
    activity = 'working'
    requestRender?.()
  })
  pi.on('turn_end', (_event, ctx) => {
    refreshModel(ctx)
    void refreshGit()
  })
  pi.on('agent_settled', (_event, ctx) => {
    activity = 'ready'
    refreshModel(ctx)
  })
  pi.on('after_provider_response', (event) => {
    const quota = quotaFromHeaders(modelInfo.provider, event.headers)
    if (quota) {
      providerQuota = quota
      requestRender?.()
    }
  })
  pi.on('session_shutdown', (_event, ctx) => {
    anthropicQuota.stop()
    sidebar?.dispose()
    sidebar = undefined
    footerData = undefined
    requestRender = undefined
    if (ctx.mode === 'tui') {
      ctx.ui.setFooter(undefined)
    }
  })
}
