import { type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider } from '@earendil-works/pi-coding-agent'
import { Effect, Ref } from 'effect'

import { type AppRuntime, AgentActivity, StatusBar } from '@/shared/effect/app_services.js'
import { makeEventHandler } from '@/shared/effect/runtime.js'
import { azureQuota, writeSubagentAzureQuota } from '@/shared/state/azure_quota.js'

import { renderFooterLines } from './footer.js'
import { fetchGitInfo } from './git.js'
import { makeQuotaPoller, quotaFromHeaders, type QuotaFetcher, type QuotaPoller } from './provider.js'
import { formatDirectory } from './render.js'
import { createSidebarController, type SidebarController } from './sidebar.js'
import { MIN_MAIN_WIDTH, MIN_SIDEBAR_WIDTH } from './split_pane.js'
import { emptyPanelState, type ModelInfoState, type PanelState } from './state.js'
import { collectStatuses } from './statuses.js'

const ANTHROPIC_QUOTA_REFRESH_MS = 15_000

interface StatusPanelDependencies {
  fetchAnthropicQuota?: QuotaFetcher
}

export const register = (pi: ExtensionAPI, runtime: AppRuntime, dependencies: StatusPanelDependencies = {}): void => {
  if (process.env.PI_SUBAGENT_OWNER_TOKEN !== undefined) {
    pi.on('after_provider_response', (event, ctx) => {
      const quota = quotaFromHeaders(ctx.model?.provider ?? '', event.headers)
      if (quota) {
        writeSubagentAzureQuota(process.env.PI_SUBAGENT_OWNER_TOKEN ?? '', quota.percent)
      }
    })
    return
  }

  const agentActivity = runtime.runSync(AgentActivity)
  const statusBar = runtime.runSync(StatusBar)
  const stateRef = Effect.runSync(Ref.make<PanelState>(emptyPanelState()))

  let sidebar: SidebarController | undefined
  let footerData: ReadonlyFooterDataProvider | undefined
  let requestRender: (() => void) | undefined
  let anthropicQuotaBaseUrl: string | undefined
  let unsubscribeAzureQuota: (() => void) | undefined
  agentActivity.subscribe(() => requestRender?.())
  statusBar.subscribe(() => requestRender?.())

  const getState = (): PanelState => Effect.runSync(Ref.get(stateRef))
  const updateState = (updater: (state: PanelState) => PanelState): Effect.Effect<void> => Ref.update(stateRef, updater)
  const syncAzureQuota = (): void => {
    const percent = azureQuota.get()
    Effect.runSync(
      updateState((state) => {
        const quotas = { ...state.quotas }
        if (percent === undefined) {
          delete quotas.azure
        } else {
          quotas.azure = { label: 'azure', percent }
        }
        return { ...state, quotas }
      })
    )
    requestRender?.()
  }

  const anthropicQuota: QuotaPoller = Effect.runSync(
    makeQuotaPoller(
      (quota) => {
        Effect.runSync(
          updateState((state) => {
            const quotas = { ...state.quotas }
            if (quota) {
              quotas.anthropic = quota
            } else {
              delete quotas.anthropic
            }
            return { ...state, quotas }
          })
        )
        requestRender?.()
      },
      {
        fetchQuota: dependencies.fetchAnthropicQuota,
        refreshMs: ANTHROPIC_QUOTA_REFRESH_MS,
      }
    )
  )

  const startAnthropicQuota = (ctx: ExtensionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (ctx.mode !== 'tui') {
        return
      }
      if (anthropicQuotaBaseUrl) {
        return
      }
      const baseUrl =
        (ctx.model?.provider === 'anthropic' ? ctx.model.baseUrl : undefined) ??
        ctx.modelRegistry?.getAvailable().find((model) => model.provider === 'anthropic')?.baseUrl
      if (!baseUrl) {
        return
      }
      anthropicQuotaBaseUrl = baseUrl
      yield* anthropicQuota.start(baseUrl)
    })

  /** Fire-and-forget by design, like the original `void refreshGit()`: forked detached so it keeps running after the triggering hook's effect completes, instead of being interrupted with it. */
  const scheduleGitRefresh = (): void => {
    Effect.runFork(Effect.forkDetach(refreshGit()))
  }

  const refreshGit = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const git = yield* fetchGitInfo(pi)
      yield* updateState((state) => ({ ...state, git }))
      requestRender?.()
    })

  const applyModelInfo = (ctx: ExtensionContext, model: ModelInfoState): ModelInfoState => {
    const usage = ctx.getContextUsage()
    return {
      ...model,
      contextPercent: usage?.percent ?? undefined,
      contextTokens: usage?.tokens ?? undefined,
      contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
      modelId: ctx.model?.id ?? 'no-model',
      provider: ctx.model?.provider ?? '',
      thinking: ctx.model?.reasoning ? pi.getThinkingLevel() : 'off',
    }
  }

  const refreshModel = (ctx: ExtensionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* updateState((state) => ({ ...state, model: applyModelInfo(ctx, state.model) }))
      requestRender?.()
    })

  const install = (ctx: ExtensionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (ctx.mode !== 'tui') {
        return
      }
      sidebar?.dispose()
      footerData = undefined
      yield* Effect.sync(() => {
        ctx.ui.setFooter((tui, theme, data: ReadonlyFooterDataProvider) => {
          footerData = data
          const unsubscribe = data.onBranchChange?.(() => {
            scheduleGitRefresh()
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
              const state = getState()
              return renderFooterLines(
                {
                  cwd: ctx.cwd,
                  git: state.git,
                  model: state.model,
                  quotas: state.quotas,
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
          getState: () => {
            const state = getState()
            return {
              activity: state.activity,
              agents: agentActivity.list(),
              cwd: ctx.cwd,
              extensionStatuses: collectStatuses(footerData),
              git: state.git,
              model: state.model,
              quotas: state.quotas,
            }
          },
          onError: () => undefined,
        })
        requestRender = () => sidebar?.requestRender()
        sidebar.show()
        ctx.ui.setTitle(`pi · ${formatDirectory(ctx.cwd)}`)
      })
      yield* refreshModel(ctx)
      scheduleGitRefresh()
    })

  pi.on(
    'session_start',
    makeEventHandler(runtime)((_event, ctx) =>
      Effect.gen(function* () {
        yield* anthropicQuota.stop
        anthropicQuotaBaseUrl = undefined
        unsubscribeAzureQuota?.()
        azureQuota.set(undefined)
        yield* Ref.set(stateRef, emptyPanelState())
        unsubscribeAzureQuota = azureQuota.subscribe(syncAzureQuota)
        yield* install(ctx)
        if (ctx.mode !== 'tui') {
          yield* refreshModel(ctx)
        }
        yield* startAnthropicQuota(ctx)
      })
    )
  )
  pi.on(
    'model_select',
    makeEventHandler(runtime)((event, ctx) =>
      Effect.gen(function* () {
        yield* updateState((state) => ({
          ...state,
          model: {
            ...state.model,
            contextWindow: event.model.contextWindow,
            modelId: event.model.id,
            provider: event.model.provider,
            thinking: event.model.reasoning ? pi.getThinkingLevel() : 'off',
          },
        }))
        yield* refreshModel(ctx)
        scheduleGitRefresh()
        yield* startAnthropicQuota(ctx)
      })
    )
  )
  pi.on(
    'thinking_level_select',
    makeEventHandler(runtime)((event, _ctx) =>
      Effect.gen(function* () {
        yield* updateState((state) => ({ ...state, model: { ...state.model, thinking: event.level } }))
        requestRender?.()
      })
    )
  )
  pi.on(
    'agent_start',
    makeEventHandler(runtime)((_event, _ctx) =>
      Effect.gen(function* () {
        yield* updateState((state) => ({ ...state, activity: 'working' }))
        requestRender?.()
      })
    )
  )
  pi.on(
    'turn_end',
    makeEventHandler(runtime)((_event, ctx) =>
      Effect.gen(function* () {
        yield* refreshModel(ctx)
        scheduleGitRefresh()
      })
    )
  )
  pi.on(
    'agent_settled',
    makeEventHandler(runtime)((_event, ctx) =>
      Effect.gen(function* () {
        yield* updateState((state) => ({ ...state, activity: 'ready' }))
        yield* refreshModel(ctx)
      })
    )
  )
  pi.on(
    'after_provider_response',
    makeEventHandler(runtime)((event, ctx) =>
      Effect.sync(() => {
        const quota = quotaFromHeaders(ctx.model?.provider ?? '', event.headers)
        if (quota) {
          azureQuota.set(quota.percent)
        }
      })
    )
  )
  pi.on(
    'session_shutdown',
    makeEventHandler(runtime)((_event, ctx) =>
      Effect.gen(function* () {
        yield* anthropicQuota.stop
        anthropicQuotaBaseUrl = undefined
        unsubscribeAzureQuota?.()
        unsubscribeAzureQuota = undefined
        sidebar?.dispose()
        sidebar = undefined
        footerData = undefined
        requestRender = undefined
        if (ctx.mode === 'tui') {
          ctx.ui.setFooter(undefined)
        }
      })
    )
  )
}
