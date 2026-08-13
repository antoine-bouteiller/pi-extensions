import { type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider } from '@earendil-works/pi-coding-agent'
import { Effect, Path, Ref } from 'effect'

import { type AppRuntime, AgentActivity, StatusBar } from '@/shared/effect/app_services.js'
import { azureQuota, writeSubagentAzureQuota } from '@/shared/state/azure_quota.js'
import { isEmptyString, isNullOrUndefined, isTrue } from '@/shared/utils/predicates.js'

import { renderFooterLines } from './footer.js'
import { fetchGitInfo } from './git.js'
import { makeQuotaPoller, quotaFromHeaders, type QuotaFetcher, type QuotaPoller } from './provider.js'
import { formatDirectory } from './render.js'
import { createSidebarController, type SidebarController } from './sidebar.js'
import { MIN_MAIN_WIDTH, MIN_SIDEBAR_WIDTH } from './split_pane.js'
import { emptyPanelState, type ModelInfoState, type PanelState } from './state.js'
import { collectStatuses } from './statuses.js'

const ANTHROPIC_QUOTA_REFRESH_MS = 15_000

export interface StatusPanelDependencies {
  fetchAnthropicQuota?: QuotaFetcher
}

/*
 * `after_provider_response`, `model_select`, and `thinking_level_select` payload types are not
 * re-exported from the package root, so these mirror the fields this panel reads structurally
 * rather than deep-importing an internal path.
 */
interface ProviderResponsePayload {
  readonly headers: Record<string, string>
}

interface ModelSelectPayload {
  readonly model: { readonly contextWindow: number; readonly id: string; readonly provider: string; readonly reasoning?: boolean }
}

interface ThinkingLevelSelectPayload {
  readonly level: string
}

export interface PanelControllerOptions {
  readonly dependencies: StatusPanelDependencies
  readonly pi: ExtensionAPI
  readonly runtime: AppRuntime
}

export interface PanelHandlers {
  readonly sessionStart: (event: unknown, ctx: ExtensionContext) => Effect.Effect<void>
  readonly modelSelect: (event: ModelSelectPayload, ctx: ExtensionContext) => Effect.Effect<void>
  readonly thinkingLevelSelect: (event: ThinkingLevelSelectPayload, ctx: ExtensionContext) => Effect.Effect<void>
  readonly agentStart: (event: unknown, ctx: ExtensionContext) => Effect.Effect<void>
  readonly turnEnd: (event: unknown, ctx: ExtensionContext) => Effect.Effect<void>
  readonly agentSettled: (event: unknown, ctx: ExtensionContext) => Effect.Effect<void>
  readonly afterProviderResponse: (event: ProviderResponsePayload, ctx: ExtensionContext) => Effect.Effect<void>
  readonly sessionShutdown: (event: unknown, ctx: ExtensionContext) => Effect.Effect<void>
}

export const recordSubagentQuota = (event: ProviderResponsePayload, ctx: ExtensionContext): Effect.Effect<void> => {
  const quota = quotaFromHeaders(ctx.model?.provider ?? '', event.headers)
  return quota === undefined ? Effect.void : writeSubagentAzureQuota(process.env.PI_SUBAGENT_OWNER_TOKEN ?? '', quota.percent)
}

export const makePanelController = ({ dependencies, pi, runtime }: PanelControllerOptions): PanelHandlers => {
  const agentActivity = runtime.runSync(AgentActivity)
  const path = runtime.runSync(Path.Path)
  const statusBar = runtime.runSync(StatusBar)
  const stateRef = Ref.makeUnsafe<PanelState>(emptyPanelState())

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
            if (quota === undefined) {
              delete quotas.anthropic
            } else {
              quotas.anthropic = quota
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
      if (anthropicQuotaBaseUrl !== undefined) {
        return
      }
      const baseUrl =
        (ctx.model?.provider === 'anthropic' ? ctx.model.baseUrl : undefined) ??
        ctx.modelRegistry?.getAvailable().find((model) => model.provider === 'anthropic')?.baseUrl
      if (isNullOrUndefined(baseUrl) || isEmptyString(baseUrl)) {
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
      thinking: isTrue(ctx.model?.reasoning) ? pi.getThinkingLevel() : 'off',
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
                width,
                path
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
          path,
        })
        requestRender = () => sidebar?.requestRender()
        sidebar.show()
        ctx.ui.setTitle(`pi · ${formatDirectory(ctx.cwd, path)}`)
      })
      yield* refreshModel(ctx)
      scheduleGitRefresh()
    })

  return {
    afterProviderResponse: (event, ctx) =>
      Effect.sync(() => {
        const quota = quotaFromHeaders(ctx.model?.provider ?? '', event.headers)
        if (quota !== undefined) {
          azureQuota.set(quota.percent)
        }
      }),
    agentSettled: (_event, ctx) =>
      Effect.gen(function* () {
        yield* updateState((state) => ({ ...state, activity: 'ready' }))
        yield* refreshModel(ctx)
      }),
    agentStart: () =>
      Effect.gen(function* () {
        yield* updateState((state) => ({ ...state, activity: 'working' }))
        requestRender?.()
      }),
    modelSelect: (event, ctx) =>
      Effect.gen(function* () {
        yield* updateState((state) => ({
          ...state,
          model: {
            ...state.model,
            contextWindow: event.model.contextWindow,
            modelId: event.model.id,
            provider: event.model.provider,
            thinking: isTrue(event.model.reasoning) ? pi.getThinkingLevel() : 'off',
          },
        }))
        yield* refreshModel(ctx)
        scheduleGitRefresh()
        yield* startAnthropicQuota(ctx)
      }),
    sessionShutdown: (_event, ctx) =>
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
      }),
    sessionStart: (_event, ctx) =>
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
      }),
    thinkingLevelSelect: (event) =>
      Effect.gen(function* () {
        yield* updateState((state) => ({ ...state, model: { ...state.model, thinking: event.level } }))
        requestRender?.()
      }),
    turnEnd: (_event, ctx) =>
      Effect.gen(function* () {
        yield* refreshModel(ctx)
        scheduleGitRefresh()
      }),
  }
}
