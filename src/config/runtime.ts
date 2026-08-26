import { BunChildProcessSpawner, BunFileSystem, BunPath } from '@effect/platform-bun'
import { Layer, ManagedRuntime } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import { AgentActivityLive, type AppServices, StatusBarLive } from '#shared/effect/app_services'

export type ProcessServices = AppServices
export type ProcessRuntime = ManagedRuntime.ManagedRuntime<ProcessServices, never>

/**
 * Composed once, as a module constant: `ManagedRuntime.make` memoises layer construction by
 * reference identity, so every feature using this exact value shares the services it builds
 * (notably `StatusBar`/`AgentActivity`) instead of each getting its own copy. Every member must
 * remain synchronously constructible because status-panel resolves its paint-loop stores with
 * `runtime.runSync` during registration.
 */
const BunPlatformLayer = BunChildProcessSpawner.layer.pipe(Layer.provideMerge(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)))

const AppLayer: Layer.Layer<ProcessServices> = Layer.mergeAll(BunPlatformLayer, FetchHttpClient.layer, StatusBarLive, AgentActivityLive)

let processRuntime: ProcessRuntime | undefined

/**
 * One process-wide runtime, built lazily on first access and passed by `src/index.ts` to every
 * feature so all registrations share the same services.
 */
export const getOrCreateProcessRuntime = (): ProcessRuntime => (processRuntime ??= ManagedRuntime.make(AppLayer))
