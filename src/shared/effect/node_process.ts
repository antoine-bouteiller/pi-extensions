import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from '@effect/platform-node'
import { Layer, ManagedRuntime } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

const layer = NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))

export type NodeChildProcessSpawner = typeof ChildProcessSpawner.Service

export const nodeChildProcessSpawner: NodeChildProcessSpawner = ManagedRuntime.make(layer).runSync(ChildProcessSpawner)
