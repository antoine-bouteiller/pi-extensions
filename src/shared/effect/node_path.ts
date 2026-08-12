import { NodePath } from '@effect/platform-node'
import { ManagedRuntime, Path } from 'effect'

export const nodePath = ManagedRuntime.make(NodePath.layer).runSync(Path.Path)
