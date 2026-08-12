import { fileURLToPath } from 'node:url'

import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect, FileSystem, Layer, Path } from 'effect'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const TESTS = fileURLToPath(new URL('./', import.meta.url))

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const descendants = (root: string): Effect.Effect<string[], never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const paths: string[] = []
    for (const name of yield* fs.readDirectory(root)) {
      const child = path.join(root, name)
      paths.push(child)
      if ((yield* fs.stat(child)).type === 'Directory') {
        paths.push(...(yield* descendants(child)))
      }
    }
    return paths
  }).pipe(Effect.orDie)

const namesByKind = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const entries = yield* Effect.forEach(
      yield* fs.readDirectory(root),
      (name) => fs.stat(path.join(root, name)).pipe(Effect.map((info) => ({ info, name }))),
      {}
    )
    return {
      directories: entries
        .filter(({ info }) => info.type === 'Directory')
        .map(({ name }) => name)
        .toSorted(),
      files: entries
        .filter(({ info }) => info.type === 'File')
        .map(({ name }) => name)
        .toSorted(),
    }
  }).pipe(Effect.orDie)

describe('project structure', () => {
  it.effect('source has one entrypoint and the three canonical layers', () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const source = yield* namesByKind(SRC)
      const shared = yield* namesByKind(path.join(SRC, 'shared'))
      expect(source).toEqual({ directories: ['config', 'features', 'shared'], files: ['index.ts'] })
      expect(shared.directories).toEqual(['effect', 'state', 'utils'])
    }).pipe(Effect.provide(platformLayer))
  )

  it.effect('features use snake_case and have mirrored specs', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const featureEntries = yield* namesByKind(path.join(SRC, 'features'))
      const features = featureEntries.directories
      for (const feature of features) {
        expect(feature).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)
        const sourceFiles = yield* fs.readDirectory(path.join(SRC, 'features', feature))
        expect(sourceFiles, feature).toContain('index.ts')
        expect(sourceFiles, feature).not.toContain('feature.ts')
        const testFiles = yield* fs.readDirectory(path.join(TESTS, 'features', feature))
        expect(
          testFiles.some((name) => name.endsWith('.spec.ts')),
          feature
        ).toBeTrue()
      }
    }).pipe(Effect.provide(platformLayer))
  )

  it.effect('tests stay outside source and index.ts exists only as an entrypoint per layer', () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const sourcePaths = yield* descendants(SRC)
      const featureEntries = yield* namesByKind(path.join(SRC, 'features'))
      const featureDirectories = featureEntries.directories
      expect(
        sourcePaths.filter(
          (sourcePath) => sourcePath.endsWith('.test.ts') || sourcePath.endsWith('.spec.ts') || sourcePath.split(path.sep).includes('test')
        )
      ).toEqual([])
      expect(
        sourcePaths
          .filter((sourcePath) => sourcePath.endsWith(`${path.sep}index.ts`))
          .map((sourcePath) => path.relative(SRC, sourcePath))
          .toSorted()
      ).toEqual(['index.ts', ...featureDirectories.map((feature) => path.join('features', feature, 'index.ts'))].toSorted())
    }).pipe(Effect.provide(platformLayer))
  )

  it.effect('root specs are only package contracts', () =>
    Effect.gen(function* () {
      const rootTests = yield* namesByKind(TESTS)
      expect(rootTests.files).toEqual(['bun_effect.spec.ts', 'project_structure.spec.ts', 'registration.spec.ts'])
    }).pipe(Effect.provide(platformLayer))
  )
})
