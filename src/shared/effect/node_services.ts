import { NodeServices } from '@effect/platform-node'
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
const runtime = ManagedRuntime.make(NodeServices.layer)

export type NodeChildProcessSpawner = typeof ChildProcessSpawner.Service

export const nodeFileSystem = runtime.runSync(FileSystem.FileSystem)
export const nodePath = runtime.runSync(Path.Path)
export const nodeChildProcessSpawner: NodeChildProcessSpawner = runtime.runSync(ChildProcessSpawner)
