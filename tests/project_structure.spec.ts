import { Effect, FileSystem } from 'effect'
import { type PlatformError } from 'effect/PlatformError'

import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from '#shared/utils/path'

import { describe, expect, it } from './utils/bun_effect.js'

const SRC = resolve(import.meta.dirname, '../src')
const FEATURES = join(SRC, 'features')
const TESTS = import.meta.dirname
const TEST_FEATURES = join(TESTS, 'features')

const namesByKind = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const names = yield* fs.readDirectory(root)
    const entries = yield* Effect.forEach(names, (name) => fs.stat(join(root, name)).pipe(Effect.map((info) => ({ name, type: info.type }))), {})
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

const descendants = (root: string): Effect.Effect<string[], PlatformError, FileSystem.FileSystem> =>
  namesByKind(root).pipe(
    Effect.flatMap(({ directories, files }) =>
      Effect.forEach(directories, (directory) => descendants(join(root, directory)), {}).pipe(
        Effect.map((nested) => [...[...files, ...directories].map((entry) => join(root, entry)), ...nested.flat()])
      )
    )
  )

const featureAtPath = (path: string, root: string): string | undefined => {
  const relative = relativePath(root, path)
  if (relative === '..' || relative.startsWith(`..${sep}`) || isAbsolute(relative)) {
    return undefined
  }
  return relative.split(sep)[0]
}

const importedFeature = (specifier: string, importer: string): string | undefined => {
  const alias = /^(?:#features|@\/features|#tests\/features|@tests\/features)\/(?<feature>[^/]+)/.exec(specifier)
  if (alias?.groups?.feature !== undefined) {
    return alias.groups.feature
  }
  if (!specifier.startsWith('.')) {
    return undefined
  }
  const resolved = resolve(dirname(importer), specifier)
  return featureAtPath(resolved, FEATURES) ?? featureAtPath(resolved, TEST_FEATURES)
}

const importSpecifiers = (source: string): string[] =>
  [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)['"](?<specifier>[^'"]+)['"]/g)].flatMap((match) =>
    match.groups?.specifier === undefined ? [] : [match.groups.specifier]
  )

describe('project structure', () => {
  it.effect('source has one entrypoint and the three canonical layers', () =>
    Effect.gen(function* () {
      expect(yield* namesByKind(SRC)).toEqual({ directories: ['config', 'features', 'shared'], files: ['index.ts'] })
      expect((yield* namesByKind(join(SRC, 'shared'))).directories).toEqual(['effect', 'state', 'utils'])
      expect((yield* namesByKind(join(SRC, 'shared', 'effect'))).files).toEqual([
        'app_services.ts',
        'bun_host_file_system.ts',
        'errors.ts',
        'feature.ts',
        'mutation_queue.ts',
        'pi_services.ts',
        'runtime.ts',
      ])
      expect((yield* namesByKind(join(SRC, 'shared', 'utils'))).files).toEqual([
        'json.ts',
        'path.ts',
        'predicates.ts',
        'protected_paths.ts',
        'records.ts',
        'tool_output.ts',
      ])
    })
  )

  it.effect('features use snake_case, register through index.ts, and have mirrored specs', () =>
    Effect.gen(function* () {
      const features = (yield* namesByKind(join(SRC, 'features'))).directories
      expect(features.length).toBeGreaterThan(0)
      for (const feature of features) {
        expect(feature).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)
        const sourceFiles = (yield* namesByKind(join(SRC, 'features', feature))).files
        expect(sourceFiles, feature).toContain('index.ts')
        expect(sourceFiles, feature).not.toContain('feature.ts')
        const testFiles = (yield* namesByKind(join(TESTS, 'features', feature))).files
        expect(
          testFiles.some((name) => name.endsWith('.spec.ts')),
          feature
        ).toBeTrue()
      }
    })
  )

  it.effect('features and shared code do not depend on other features', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      expect(importedFeature('@tests/features/example/index.js', SRC)).toBe('example')
      expect(importedFeature('#tests/features/example/index', SRC)).toBe('example')

      const roots = [FEATURES, join(SRC, 'shared'), TEST_FEATURES, join(TESTS, 'shared'), join(TESTS, 'utils')]
      const violations: string[] = []
      for (const root of roots) {
        const sources = (yield* descendants(root)).filter((path) => /\.[cm]?[jt]sx?$/.test(path))
        for (const source of sources) {
          const owner = featureAtPath(source, FEATURES) ?? featureAtPath(source, TEST_FEATURES)
          for (const specifier of importSpecifiers(yield* fs.readFileString(source))) {
            const dependency = importedFeature(specifier, source)
            if (dependency !== undefined && dependency !== owner) {
              violations.push(`${relativePath(resolve(SRC, '..'), source)} -> ${specifier}`)
            }
          }
        }
      }
      expect(violations).toEqual([])
    })
  )

  it.effect('tests stay outside source and index.ts exists only as an entrypoint', () =>
    Effect.gen(function* () {
      const sourcePaths = yield* descendants(SRC)
      expect(sourcePaths.filter((path) => path.endsWith('.test.ts') || path.endsWith('.spec.ts') || path.split(sep).includes('test'))).toEqual([])
      const indexFiles = sourcePaths.filter((path) => path.endsWith(`${sep}index.ts`)).map((path) => relativePath(SRC, path))
      expect(indexFiles.filter((path) => !/^features[/\\][a-z0-9_]+[/\\]index\.ts$/.test(path))).toEqual(['index.ts'])
    })
  )

  it.effect('only index.ts registers capabilities with pi', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      /*
       * Pi's full extension-registration surface, enumerated rather than pattern-matched: a bare
       * `.register[A-Z]` also catches internal helpers like `registerWaiter`, and a bare `.on(`
       * catches every socket listener.
       */
      const registrations =
        /\.(?:registerAliases|registerApiProvider|registerCommand|registerEntryRenderer|registerFlag|registerFooterDataProvider|registerLanguage|registerMarkdownTransformer|registerMessageRenderer|registerNativeProvider|registerProvider|registerShortcut|registerTool)\(|\bpi\.on\(/
      const sources = (yield* descendants(join(SRC, 'features'))).filter((path) => path.endsWith('.ts') && !path.endsWith(`${sep}index.ts`))
      for (const source of sources) {
        expect(registrations.test(yield* fs.readFileString(source)), source).toBeFalse()
      }
    })
  )

  it.effect('node:fs stays behind the single audited host boundary', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const sources = (yield* descendants(SRC)).filter((path) => path.endsWith('.ts'))
      const importers: string[] = []
      for (const source of sources) {
        if (/from 'node:fs/.test(yield* fs.readFileString(source))) {
          importers.push(relativePath(SRC, source))
        }
      }
      expect(importers.toSorted()).toEqual([join('shared', 'effect', 'bun_host_file_system.ts')])
    })
  )

  it.effect('root specs are only package contracts', () =>
    Effect.gen(function* () {
      expect((yield* namesByKind(TESTS)).files).toEqual(['bun_effect.spec.ts', 'project_structure.spec.ts', 'registration.spec.ts'])
    })
  )
})
