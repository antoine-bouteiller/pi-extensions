import { BunServices } from '@effect/platform-bun'
import { FileSystem, ManagedRuntime, Path } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

/**
 * A second, module-level runtime that exists only to resolve the three platform services eagerly.
 * Modules reached from synchronous Pi/TUI callbacks, module-level constants, and class constructors
 * cannot `yield*` them out of the process runtime's context, so they are resolved once here.
 *
 * ponytail: process-wide singleton, so these services cannot be substituted per test; require
 * `FileSystem`/`Path` from context instead once every consumer is reachable from an Effect.
 */
// oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-1]/[C-1] §§6,8.8; permanent: Bun-only pre-AppRuntime host services require the secondary runtime
const runtime = ManagedRuntime.make(BunServices.layer)

export type BunChildProcessSpawner = typeof ChildProcessSpawner.Service

// oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-1]/[C-1] §§6,8.8; permanent: Bun-only pre-AppRuntime host services require the secondary runtime
export const bunFileSystem = runtime.runSync(FileSystem.FileSystem)
// oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-1]/[C-1] §§6,8.8; permanent: Bun-only pre-AppRuntime host services require the secondary runtime
export const bunPath = runtime.runSync(Path.Path)
// oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-1]/[C-1] §§6,8.8; permanent: Bun-only pre-AppRuntime host services require the secondary runtime
export const bunChildProcessSpawner: BunChildProcessSpawner = runtime.runSync(ChildProcessSpawner)
