import { type ExtensionAPI, type ExtensionContext, type ExtensionEvent, type ReadonlyFooterDataProvider } from '@earendil-works/pi-coding-agent'
import { Effect, Fiber, MutableRef, Path as PathService, Queue, type Scope } from 'effect'
import { type FileSystem } from 'effect/FileSystem'
import { type Path } from 'effect/Path'
import { type HttpClient } from 'effect/unstable/http'

import { AgentActivity, StatusBar, type AgentActivityApi, type StatusBarApi } from '#shared/effect/app_services'
import { azureQuota, writeSubagentAzureQuota } from '#shared/state/azure_quota'
import { isEmptyString, isNullOrUndefined, isTrue } from '#shared/utils/predicates'

import { renderFooterLines } from './footer.js'
import { fetchGitInfo } from './git.js'
import { makeQuotaPoller, quotaFromHeaders, type QuotaFetcher, type QuotaPoller } from './provider.js'
import { formatDirectory } from './render.js'
import { createSidebarController, type SidebarController } from './sidebar.js'
import { MIN_MAIN_WIDTH, MIN_SIDEBAR_WIDTH } from './split_pane.js'
import { emptyPanelState, type ModelInfoState, type PanelState, type ProviderQuota } from './state.js'
import { collectStatuses } from './statuses.js'

const ANTHROPIC_QUOTA_REFRESH_MS = 15_000
const REDRAW_MS = 400

export interface StatusPanelDependencies {
  fetchAnthropicQuota?: QuotaFetcher
}

/*
 * The individual payload interfaces are not re-exported from the package root, but the
 * `ExtensionEvent` union is, so each payload is narrowed by its own `type` discriminant instead of
 * being restated here.
 */
type PiEvent<Type extends ExtensionEvent['type']> = Extract<ExtensionEvent, { type: Type }>

export interface PanelControllerOptions {
  readonly dependencies: StatusPanelDependencies
  readonly pi: ExtensionAPI
}

export interface PanelHandlers {
  readonly sessionStart: (
    event: PiEvent<'session_start'>,
    ctx: ExtensionContext
  ) => Effect.Effect<void, never, HttpClient.HttpClient | AgentActivity | StatusBar | Path | Scope.Scope>
  readonly modelSelect: (event: PiEvent<'model_select'>, ctx: ExtensionContext) => Effect.Effect<void, never, HttpClient.HttpClient>
  readonly thinkingLevelSelect: (event: PiEvent<'thinking_level_select'>, ctx: ExtensionContext) => Effect.Effect<void>
  readonly agentStart: (event: PiEvent<'agent_start'>, ctx: ExtensionContext) => Effect.Effect<void>
  readonly turnEnd: (event: PiEvent<'turn_end'>, ctx: ExtensionContext) => Effect.Effect<void>
  readonly agentSettled: (event: PiEvent<'agent_settled'>, ctx: ExtensionContext) => Effect.Effect<void>
  readonly afterProviderResponse: (event: PiEvent<'after_provider_response'>, ctx: ExtensionContext) => Effect.Effect<void>
  readonly sessionShutdown: (event: PiEvent<'session_shutdown'>, ctx: ExtensionContext) => Effect.Effect<void>
}

export const recordSubagentQuota = (
  event: PiEvent<'after_provider_response'>,
  ctx: ExtensionContext
): Effect.Effect<void, never, FileSystem | Path> => {
  const quota = quotaFromHeaders(ctx.model?.provider ?? '', event.headers)
  return quota === undefined ? Effect.void : writeSubagentAzureQuota(process.env.PI_SUBAGENT_OWNER_TOKEN ?? '', quota.percent)
}

export const makePanelController = ({ dependencies, pi }: PanelControllerOptions): PanelHandlers => {
  const panelState = MutableRef.make<PanelState>(emptyPanelState())

  let sidebar: SidebarController | undefined
  let footerData: ReadonlyFooterDataProvider | undefined
  let requestRender: (() => void) | undefined
  let anthropicQuotaBaseUrl: string | undefined
  let unsubscribeAzureQuota: (() => void) | undefined
  let unsubscribeAgentActivity: (() => void) | undefined
  let unsubscribeStatusBar: (() => void) | undefined
  let sessionScope: Scope.Scope | undefined
  let gitRefreshRequests: Queue.Queue<void> | undefined
  let redrawFiber: Fiber.Fiber<never> | undefined

  const getState = (): PanelState => MutableRef.get(panelState)
  const setState = (updater: (state: PanelState) => PanelState): void => {
    MutableRef.update(panelState, updater)
  }
  const updateState = (updater: (state: PanelState) => PanelState): Effect.Effect<void> => Effect.sync(() => setState(updater))
  const setQuota = (label: 'anthropic' | 'azure', quota: ProviderQuota | undefined): void => {
    setState((state) => {
      const quotas = { ...state.quotas }
      if (quota === undefined) {
        delete quotas[label]
      } else {
        quotas[label] = quota
      }
      return { ...state, quotas }
    })
    requestRender?.()
  }
  const syncAzureQuota = (): void => {
    const percent = azureQuota.get()
    setQuota('azure', percent === undefined ? undefined : { label: 'azure', percent })
  }

  const anthropicQuota: QuotaPoller = makeQuotaPoller((quota) => Effect.sync(() => setQuota('anthropic', quota)), {
    fetchQuota: dependencies.fetchAnthropicQuota,
    refreshMs: ANTHROPIC_QUOTA_REFRESH_MS,
  })

  const startAnthropicQuota = (ctx: ExtensionContext): Effect.Effect<void, never, HttpClient.HttpClient> =>
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

  /** Fire-and-forget by design, like the original `void refreshGit()`: forked in the session scope so it keeps running after the triggering hook's effect completes, and still ends with the session. */
  const scheduleGitRefresh = (): Effect.Effect<void> =>
    sessionScope === undefined ? Effect.void : Effect.forkIn(refreshGit(), sessionScope).pipe(Effect.asVoid)

  const stopRedraw: Effect.Effect<void> = Effect.suspend(() => {
    const fiber = redrawFiber
    redrawFiber = undefined
    return fiber === undefined ? Effect.void : Fiber.interrupt(fiber)
  })

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

  const install = (ctx: ExtensionContext, path: Path, agentActivity: AgentActivityApi): Effect.Effect<void> =>
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
            if (gitRefreshRequests !== undefined) {
              Queue.offerUnsafe(gitRefreshRequests, undefined)
            }
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
              sessionId: ctx.sessionManager?.getSessionId() ?? undefined,
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
      yield* scheduleGitRefresh()
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
        yield* stopRedraw
        yield* updateState((state) => ({ ...state, activity: 'ready' }))
        yield* refreshModel(ctx)
      }),
    agentStart: () =>
      Effect.gen(function* () {
        yield* updateState((state) => ({ ...state, activity: 'working' }))
        requestRender?.()
        const scope = sessionScope
        if (scope === undefined || redrawFiber !== undefined) {
          return
        }
        redrawFiber = yield* Effect.forkIn(Effect.forever(Effect.sleep(REDRAW_MS).pipe(Effect.andThen(Effect.sync(() => requestRender?.())))), scope)
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
        yield* scheduleGitRefresh()
        yield* startAnthropicQuota(ctx)
      }),
    sessionShutdown: (_event, ctx) =>
      Effect.gen(function* () {
        yield* stopRedraw
        yield* anthropicQuota.stop
        anthropicQuotaBaseUrl = undefined
        gitRefreshRequests = undefined
        sessionScope = undefined
        unsubscribeAzureQuota?.()
        unsubscribeAzureQuota = undefined
        unsubscribeAgentActivity?.()
        unsubscribeAgentActivity = undefined
        unsubscribeStatusBar?.()
        unsubscribeStatusBar = undefined
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
        const agentActivity: AgentActivityApi = yield* AgentActivity
        const statusBar: StatusBarApi = yield* StatusBar
        const path = yield* PathService.Path
        sessionScope = yield* Effect.scope
        yield* stopRedraw
        yield* anthropicQuota.stop
        anthropicQuotaBaseUrl = undefined
        unsubscribeAzureQuota?.()
        unsubscribeAgentActivity?.()
        unsubscribeStatusBar?.()
        azureQuota.set(undefined)
        MutableRef.set(panelState, emptyPanelState())
        unsubscribeAzureQuota = azureQuota.subscribe(syncAzureQuota)
        unsubscribeAgentActivity = agentActivity.subscribe(() => requestRender?.())
        unsubscribeStatusBar = statusBar.subscribe(() => requestRender?.())
        const requests = yield* Queue.sliding<void>(1)
        gitRefreshRequests = requests
        yield* Effect.forkIn(Effect.forever(Queue.take(requests).pipe(Effect.andThen(refreshGit()))), sessionScope)
        yield* install(ctx, path, agentActivity)
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
        yield* scheduleGitRefresh()
      }),
  }
}
