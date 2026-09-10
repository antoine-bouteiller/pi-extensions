import { BunChildProcessSpawner, BunCrypto, BunFileSystem, BunPath } from '@effect/platform-bun'
import { Layer, ManagedRuntime } from 'effect'
import { type Crypto } from 'effect/Crypto'
import { type FileSystem } from 'effect/FileSystem'
import { type Path } from 'effect/Path'
import { FetchHttpClient } from 'effect/unstable/http'
import { type ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { getOrCreateProcessRuntime } from '@/config/runtime.js'
import { AgentActivityLive, StatusBarLive, type AgentActivity, type AppRuntime, type StatusBar } from '@/shared/effect/app_services.js'
import { envLayer, EnvLive, type Env } from '@/shared/effect/env.js'

export const runtime: AppRuntime = getOrCreateProcessRuntime()

type PlatformServices = FileSystem | Path | Crypto | ChildProcessSpawner | StatusBar | AgentActivity | Env

const BunPlatformLayer = BunChildProcessSpawner.layer.pipe(Layer.provideMerge(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer)))

/** It is the process runtime with an overridden environment snapshot, for specs that drive features which read the environment (`StatusBar`/`AgentActivity` stay module singletons, so cross-feature sharing still holds). */
export const runtimeWithEnvironment = (source: Readonly<Record<string, string | undefined>>): AppRuntime =>
  ManagedRuntime.make(Layer.mergeAll(BunPlatformLayer, FetchHttpClient.layer, StatusBarLive, AgentActivityLive, envLayer(source)))

/** No HTTP client, so a spec can supply its own stub without depending on duplicate-tag precedence. */
export const testRuntime = <Services>(layer: Layer.Layer<Services>): ManagedRuntime.ManagedRuntime<PlatformServices | Services, never> =>
  ManagedRuntime.make(Layer.mergeAll(BunPlatformLayer, StatusBarLive, AgentActivityLive, EnvLive, layer))
