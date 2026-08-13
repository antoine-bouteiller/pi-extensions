import { BunFileSystem, BunPath } from '@effect/platform-bun'
import { Layer, ManagedRuntime } from 'effect'
import { type FileSystem } from 'effect/FileSystem'
import { type Path } from 'effect/Path'

import { getOrCreateProcessRuntime } from '@/config/runtime.js'
import { AgentActivityLive, StatusBarLive, type AgentActivity, type AppRuntime, type StatusBar } from '@/shared/effect/app_services.js'

export const runtime: AppRuntime = getOrCreateProcessRuntime()

type PlatformServices = FileSystem | Path | StatusBar | AgentActivity

/** No HTTP client, so a spec can supply its own stub without depending on duplicate-tag precedence. */
export const testRuntime = <Services>(layer: Layer.Layer<Services>): ManagedRuntime.ManagedRuntime<PlatformServices | Services, never> =>
  ManagedRuntime.make(Layer.mergeAll(BunFileSystem.layer, BunPath.layer, StatusBarLive, AgentActivityLive, layer))
