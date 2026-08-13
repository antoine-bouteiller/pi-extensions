import { BunServices } from '@effect/platform-bun'
import { FileSystem, ManagedRuntime, Path } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

const runtime = ManagedRuntime.make(BunServices.layer)

export type BunChildProcessSpawner = typeof ChildProcessSpawner.Service

export const bunFileSystem = runtime.runSync(FileSystem.FileSystem)
export const bunPath = runtime.runSync(Path.Path)
export const bunChildProcessSpawner: BunChildProcessSpawner = runtime.runSync(ChildProcessSpawner)
