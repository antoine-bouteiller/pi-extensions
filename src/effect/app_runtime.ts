import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Layer, ManagedRuntime } from 'effect'
import { type FileSystem } from 'effect/FileSystem'
import { type Path } from 'effect/Path'
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http'

import { type AgentActivity, AgentActivityLive, type StatusBar, StatusBarLive } from '../shared/services.js'

export type AppServices = FileSystem | Path | HttpClient.HttpClient | StatusBar | AgentActivity

/**
 * Composed once, as a module constant: `ManagedRuntime.make` memoises layer construction by
 * reference identity, so every extension sharing this exact value shares the services it builds
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

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>

let processRuntime: AppRuntime | undefined

/**
 * One process-wide runtime, built lazily on first access and reused by every later caller.
 * `extension.ts`'s aggregate registration and any `src/*\/index.ts` Pi auto-loads directly in
 * development (see README "Development") both resolve to this identical instance, which is what
 * keeps `AppLayer`'s services shared across extensions regardless of loading path.
 */
export const getOrCreateProcessRuntime = (): AppRuntime => (processRuntime ??= ManagedRuntime.make(AppLayer))
