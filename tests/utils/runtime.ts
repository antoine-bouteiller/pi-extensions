import { BunChildProcessSpawner, BunCrypto, BunFileSystem, BunPath } from '@effect/platform-bun'
import { Layer, ManagedRuntime } from 'effect'
import { type Digest } from 'effect/crypto/Digest'
import { type SecureRandom } from 'effect/crypto/SecureRandom'
import { type FileSystem } from 'effect/FileSystem'
import { FetchHttpClient } from 'effect/http'
import { type Path } from 'effect/Path'
import { type ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import { getOrCreateProcessRuntime } from '@/config/runtime.js'
import { type AppRuntime, type StatusBar, StatusBarLive } from '@/shared/effect/app_services.js'
import { type Env, envLayer, EnvLive } from '@/shared/effect/env.js'

export const runtime: AppRuntime = getOrCreateProcessRuntime()

type PlatformServices = FileSystem | Path | Digest | SecureRandom | ChildProcessSpawner | StatusBar | Env

const BunPlatformLayer = BunChildProcessSpawner.layer.pipe(Layer.provideMerge(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer)))

/** It is the process runtime with an overridden environment snapshot, for specs that drive features which read the environment (`StatusBar` stays a module singleton, so cross-feature sharing still holds). */
export const runtimeWithEnvironment = (source: Readonly<Record<string, string | undefined>>): AppRuntime =>
  ManagedRuntime.make(Layer.mergeAll(BunPlatformLayer, FetchHttpClient.layer, StatusBarLive, envLayer(source)))

/** No HTTP client, so a spec can supply its own stub without depending on duplicate-tag precedence. */
export const testRuntime = <Services>(layer: Layer.Layer<Services>): ManagedRuntime.ManagedRuntime<PlatformServices | Services, never> =>
  ManagedRuntime.make(Layer.mergeAll(BunPlatformLayer, StatusBarLive, EnvLive, layer))
