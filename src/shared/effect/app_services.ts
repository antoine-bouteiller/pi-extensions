import { Context, Effect, Layer, type ManagedRuntime } from 'effect'
import { type FileSystem } from 'effect/FileSystem'
import { type Path } from 'effect/Path'
import { type HttpClient } from 'effect/unstable/http'

import { resolveProfile } from '#features/sub_agents/model'
import { type SubagentOrchestrator, SubagentOrchestratorLive } from '#features/sub_agents/orchestrator'
import { ChildProcessLive } from '#features/sub_agents/process'
import { ProfileResolver, SubagentStoreLive } from '#features/sub_agents/store'
import { ProductionNotificationSinkLive } from '#features/sub_agents/tools'
import { type AgentActivityStore, type RunningAgent, runningAgents } from '#shared/state/agent_activity'
import { formatStatusText, publishStatus, type StatusEntry, type StatusItem, statusBar } from '#shared/state/status_bar'

import { Ui } from './pi_services.js'

interface StatusChannel {
  readonly set: (item: StatusItem) => Effect.Effect<void, never, Ui>
  readonly clear: Effect.Effect<void, never, Ui>
}

/*
 * Reads stay synchronous on purpose: the status panel calls them from TUI paint callbacks, which
 * cannot await. Only the parts that touch Pi's UI are effects.
 */
export interface StatusBarApi {
  readonly has: (key: string) => boolean
  readonly list: () => readonly StatusEntry[]
  readonly subscribe: (listener: () => void) => () => void
  readonly channel: (key: string, defaults?: Partial<StatusItem>) => StatusChannel
}

export class StatusBar extends Context.Service<StatusBar, StatusBarApi>()('pi-extensions/shared/effect/app_services/StatusBar') {}

export interface AgentActivityApi {
  readonly list: () => readonly RunningAgent[]
  readonly publish: (agents: readonly RunningAgent[]) => Effect.Effect<void>
  readonly subscribe: (listener: () => void) => () => void
}

export class AgentActivity extends Context.Service<AgentActivity, AgentActivityApi>()('pi-extensions/shared/effect/app_services/AgentActivity') {}

const statusChannel = (key: string, defaults: Partial<StatusItem> = {}): StatusChannel => ({
  clear: Effect.gen(function* () {
    const ui = yield* Ui
    publishStatus(key, undefined)
    // Guarding on hasUI, never on mode === 'tui', is what keeps RPC mode mirroring as it does today.
    if (yield* ui.hasUI) {
      yield* ui.setStatus(key, undefined)
    }
  }),
  set: (item) =>
    Effect.gen(function* () {
      const ui = yield* Ui
      const entry = { ...defaults, ...item }
      publishStatus(key, entry)
      if (yield* ui.hasUI) {
        yield* ui.setStatus(key, formatStatusText(entry))
      }
    }),
})

const agentActivityApi = (store: AgentActivityStore): AgentActivityApi => ({
  list: store.list,
  publish: (agents) =>
    Effect.sync(() => {
      store.publish(agents)
    }),
  subscribe: store.subscribe,
})

/**
 * Deliberately backed by the module-level singletons. Extensions load once per process and Node's
 * module cache is what makes `sub-agents` and `status-panel` observe the same data today. Layer
 * memoisation does not cross ManagedRuntime boundaries, so constructing fresh stores per runtime
 * would silently give each feature its own empty store, and the panel would render nothing.
 */
export const StatusBarLive: Layer.Layer<StatusBar> = Layer.succeed(StatusBar)({
  channel: statusChannel,
  has: statusBar.has,
  list: statusBar.list,
  subscribe: statusBar.subscribe,
})

export const AgentActivityLive: Layer.Layer<AgentActivity> = Layer.succeed(AgentActivity)(agentActivityApi(runningAgents))

const SubagentPortsLive = Layer.mergeAll(
  AgentActivityLive,
  ChildProcessLive,
  ProductionNotificationSinkLive,
  Layer.succeed(ProfileResolver)({ resolve: (key, snapshot) => Effect.succeed(resolveProfile(key, snapshot)) }),
  SubagentStoreLive
)

export const SubagentOrchestratorProductionLive = Layer.suspend(() => SubagentOrchestratorLive.pipe(Layer.provide(SubagentPortsLive)))

export type AppServices = FileSystem | Path | HttpClient.HttpClient | StatusBar | AgentActivity | SubagentOrchestrator

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>
