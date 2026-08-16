import { Effect } from 'effect'
import { type PlatformError } from 'effect/PlatformError'

import { nodeFileSystem, nodePath } from '#shared/effect/node_services'

import { describe, expect, it } from './utils/effect'

const SRC = nodePath.resolve(import.meta.dirname, '../src')
const TESTS = import.meta.dirname

const namesByKind = (root: string) =>
  Effect.gen(function* () {
    const names = yield* nodeFileSystem.readDirectory(root)
    const entries = yield* Effect.forEach(
      names,
      (name) => nodeFileSystem.stat(nodePath.join(root, name)).pipe(Effect.map((info) => ({ name, type: info.type }))),
      {}
    )
    return {
      directories: entries
        .filter((entry) => entry.type === 'Directory')
        .map((entry) => entry.name)
        .toSorted(),
      files: entries
        .filter((entry) => entry.type === 'File')
        .map((entry) => entry.name)
        .toSorted(),
    }
  })

const descendants = (root: string): Effect.Effect<string[], PlatformError> =>
  namesByKind(root).pipe(
    Effect.flatMap(({ directories, files }) =>
      Effect.forEach(directories, (directory) => descendants(nodePath.join(root, directory)), {}).pipe(
        Effect.map((nested) => [...[...files, ...directories].map((entry) => nodePath.join(root, entry)), ...nested.flat()])
      )
    )
  )

describe('project structure', () => {
  it.live('source has one entrypoint and the three canonical layers', () =>
    Effect.gen(function* () {
      expect(yield* namesByKind(SRC)).toEqual({ directories: ['config', 'features', 'shared'], files: ['index.ts'] })
      expect((yield* namesByKind(nodePath.join(SRC, 'shared'))).directories).toEqual(['effect', 'state', 'utils'])
    })
  )

  it.live('features use snake_case, register through index.ts, and have mirrored specs', () =>
    Effect.gen(function* () {
      const features = (yield* namesByKind(nodePath.join(SRC, 'features'))).directories
      expect(features.length).toBeGreaterThan(0)
      for (const feature of features) {
        expect(feature).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)
        const sourceFiles = (yield* namesByKind(nodePath.join(SRC, 'features', feature))).files
        expect(sourceFiles, feature).toContain('index.ts')
        expect(sourceFiles, feature).not.toContain('feature.ts')
        const testFiles = (yield* namesByKind(nodePath.join(TESTS, 'features', feature))).files
        expect(
          testFiles.some((name) => name.endsWith('.spec.ts')),
          feature
        ).toBe(true)
      }
    })
  )

  it.live('tests stay outside source and index.ts exists only as an entrypoint', () =>
    Effect.gen(function* () {
      const sourcePaths = yield* descendants(SRC)
      expect(
        sourcePaths.filter((path) => path.endsWith('.test.ts') || path.endsWith('.spec.ts') || path.split(nodePath.sep).includes('test'))
      ).toEqual([])
      const indexFiles = sourcePaths.filter((path) => path.endsWith(`${nodePath.sep}index.ts`)).map((path) => nodePath.relative(SRC, path))
      expect(indexFiles.filter((path) => !/^features[/\\][a-z0-9_]+[/\\]index\.ts$/.test(path))).toEqual(['index.ts'])
    })
  )

  it.live('only index.ts registers capabilities with pi', () =>
    Effect.gen(function* () {
      /*
       * Pi's full extension-registration surface, enumerated rather than pattern-matched: a bare
       * `.register[A-Z]` also catches internal helpers like `registerWaiter`, and a bare `.on(`
       * catches every socket listener.
       */
      const registrations =
        /\.(?:registerAliases|registerApiProvider|registerCommand|registerEntryRenderer|registerFlag|registerFooterDataProvider|registerLanguage|registerMarkdownTransformer|registerMessageRenderer|registerNativeProvider|registerProvider|registerShortcut|registerTool)\(|\bpi\.on\(/
      const sources = (yield* descendants(nodePath.join(SRC, 'features'))).filter(
        (path) => path.endsWith('.ts') && !path.endsWith(`${nodePath.sep}index.ts`)
      )
      for (const source of sources) {
        expect(registrations.test(yield* nodeFileSystem.readFileString(source)), source).toBe(false)
      }
    })
  )

  it.live('node:fs stays behind the single audited host boundary', () =>
    Effect.gen(function* () {
      const sources = (yield* descendants(SRC)).filter((path) => path.endsWith('.ts'))
      const importers: string[] = []
      for (const source of sources) {
        if (/from 'node:fs/.test(yield* nodeFileSystem.readFileString(source))) {
          importers.push(nodePath.relative(SRC, source))
        }
      }
      expect(importers.toSorted()).toEqual([nodePath.join('shared', 'effect', 'node_host_file_system.ts')])
    })
  )

  it.live('root specs are only package contracts and test utilities stay in utils', () =>
    Effect.gen(function* () {
      expect((yield* namesByKind(TESTS)).files).toEqual(['project_structure.spec.ts', 'registration.spec.ts'])
      expect((yield* namesByKind(nodePath.join(TESTS, 'utils'))).files).toEqual([
        'abort_controller.ts',
        'casts.ts',
        'deferred.ts',
        'effect.spec.ts',
        'effect.ts',
        'fake_pi.ts',
        'http.ts',
        'loopback_port.ts',
        'process_env.spec.ts',
        'process_env.ts',
        'runtime.ts',
      ])
    })
  )
})
