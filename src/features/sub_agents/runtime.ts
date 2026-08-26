import { Effect, Layer, ManagedRuntime } from 'effect'

import { AgentActivityLive } from '#shared/effect/app_services'

import { resolveProfile } from './model.js'
import { type SubagentOrchestrator, SubagentOrchestratorLive } from './orchestrator.js'
import { ChildProcessLive } from './process.js'
import { ProfileResolver, SubagentStoreLive } from './store.js'
import { ProductionNotificationSinkLive } from './tools.js'

const SubagentPortsLive = Layer.mergeAll(
  AgentActivityLive,
  ChildProcessLive,
  ProductionNotificationSinkLive,
  Layer.succeed(ProfileResolver)({ resolve: (key, snapshot) => Effect.succeed(resolveProfile(key, snapshot)) }),
  SubagentStoreLive
)

const SubagentOrchestratorProductionLive = Layer.suspend(() => SubagentOrchestratorLive.pipe(Layer.provide(SubagentPortsLive)))

export type SubagentRuntime = ManagedRuntime.ManagedRuntime<SubagentOrchestrator, never>

let productionRuntime: SubagentRuntime | undefined

export const getOrCreateSubagentRuntime = (): SubagentRuntime => (productionRuntime ??= ManagedRuntime.make(SubagentOrchestratorProductionLive))
