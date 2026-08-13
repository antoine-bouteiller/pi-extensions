import { fileURLToPath } from 'node:url'

import { BunFileSystem, BunPath } from '@effect/platform-bun'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect, FileSystem, Layer, Path } from 'effect'
import { parseSync } from 'oxc-parser'

import { isRecord } from '@/shared/utils/records.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const TESTS = fileURLToPath(new URL('./', import.meta.url))

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer)

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

const targetBuiltin = (specifier: string): boolean => {
  const normalized = specifier.replace(/^node:/, '').replace(/\/promises$/, '')
  return new Set(['child_process', 'fs', 'http', 'path']).has(normalized)
}

const literalValue = (value: unknown): string | undefined => (isRecord(value) && typeof value.value === 'string' ? value.value : undefined)

const callSpecifier = (node: Record<string, unknown>): string | undefined => {
  if (node.type !== 'CallExpression' || !Array.isArray(node.arguments) || !isRecord(node.callee)) {
    return undefined
  }
  const { callee } = node
  const direct = callee.type === 'Identifier' && (callee.name === 'require' || callee.name === 'createRequire')
  const member =
    callee.type === 'MemberExpression' &&
    isRecord(callee.property) &&
    (callee.property.name === 'require' || callee.property.name === 'getBuiltinModule')
  return direct || member ? literalValue(node.arguments[0]) : undefined
}

const externalModuleSpecifier = (node: Record<string, unknown>): string | undefined =>
  node.type === 'TSExternalModuleReference' ? literalValue(node.expression) : undefined

const builtinSpecifiers = (source: string, filename: string): string[] => {
  const parsed = parseSync(filename, source)
  const specifiers = [
    ...parsed.module.staticImports.map((entry) => entry.moduleRequest.value),
    ...parsed.module.staticExports.flatMap((entry) => entry.entries.flatMap((item) => item.moduleRequest?.value ?? [])),
    ...parsed.module.dynamicImports.map((entry) => source.slice(entry.moduleRequest.start + 1, entry.moduleRequest.end - 1)),
  ].filter(targetBuiltin)
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item)
      }
      return
    }
    if (!isRecord(value)) {
      return
    }
    const specifier = callSpecifier(value) ?? externalModuleSpecifier(value)
    if (specifier !== undefined && targetBuiltin(specifier)) {
      specifiers.push(specifier)
    }
    for (const child of Object.values(value)) {
      visit(child)
    }
  }
  visit(parsed.program)
  return specifiers
}

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

  it.effect('keeps one audited Node builtin boundary', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const files = [...(yield* descendants(SRC)), ...(yield* descendants(TESTS))].filter((file) => /\.[jt]s$/.test(file))
      const imports: string[] = []
      const directives: string[] = []
      for (const file of files) {
        const source = yield* fs.readFileString(file)
        for (const specifier of builtinSpecifiers(source, file)) {
          imports.push(`${path.relative(ROOT, file)}:${specifier}`)
        }
        for (const directive of source.matchAll(/oxlint-disable effecttsgo\/node-builtin-import -- [^\n]+/g)) {
          directives.push(`${path.relative(ROOT, file)}:${directive[0]}`)
        }
      }
      expect(imports).toEqual(['src/shared/effect/bun_host_file_system.ts:node:fs'])
      expect(directives).toHaveLength(1)
      expect(directives[0]).toContain('src/shared/effect/bun_host_file_system.ts:')
      expect(directives[0]).toContain('no-follow metadata')
      expect(directives[0]).toContain('typed directory entries')
      expect(directives[0]).toContain('descriptor identity')
      expect((yield* fs.readDirectory(ROOT)).filter((name) => /^oxlint[.].*config/.test(name))).toEqual(['oxlint.config.ts'])

      const packageJson = yield* fs.readFileString(path.join(ROOT, 'package.json'))
      expect(packageJson).toContain('"@effect/platform-bun": "4.0.0-beta.107"')
      expect(packageJson).not.toContain(['@effect/platform', 'node'].join('-'))
      expect(packageJson).toContain('"lint": "oxlint --deny-warnings --report-unused-disable-directives"')
    }).pipe(Effect.provide(platformLayer))
  )
})
