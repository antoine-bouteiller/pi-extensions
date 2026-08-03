import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Layer, ManagedRuntime } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import { AgentActivityLive, type AppRuntime, type AppServices, StatusBarLive } from '@/shared/effect/app_services.js'

/**
 * Composed once, as a module constant: `ManagedRuntime.make` memoises layer construction by
 * reference identity, so every feature using this exact value shares the services it builds
 * (notably `StatusBar`/`AgentActivity`) instead of each getting its own copy. Every member must
 * remain synchronously constructible because status-panel resolves its paint-loop stores with
 * `runtime.runSync` during registration.
 */
const AppLayer: Layer.Layer<AppServices> = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  FetchHttpClient.layer,
  StatusBarLive,
  AgentActivityLive
)

let processRuntime: AppRuntime | undefined

/**
 * One process-wide runtime, built lazily on first access and passed by `src/index.ts` to every
 * feature so all registrations share the same services.
 */
export const getOrCreateProcessRuntime = (): AppRuntime => (processRuntime ??= ManagedRuntime.make(AppLayer))
