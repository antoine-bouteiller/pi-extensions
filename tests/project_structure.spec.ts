import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const TESTS = fileURLToPath(new URL('./', import.meta.url))

const descendants = async (root: string): Promise<string[]> => {
  const paths: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    paths.push(path)
    if (entry.isDirectory()) {
      paths.push(...(await descendants(path)))
    }
  }
  return paths
}

const namesByKind = async (root: string) => {
  const entries = await readdir(root, { withFileTypes: true })
  return {
    directories: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted(),
    files: entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .toSorted(),
  }
}

describe('project structure', () => {
  test('source has one entrypoint and the three canonical layers', async () => {
    const source = await namesByKind(SRC)
    const shared = await namesByKind(join(SRC, 'shared'))
    expect(source).toEqual({ directories: ['config', 'features', 'shared'], files: ['index.ts'] })
    expect(shared.directories).toEqual(['effect', 'state', 'utils'])
  })

  test('features use snake_case and have mirrored specs', async () => {
    const featureEntries = await namesByKind(join(SRC, 'features'))
    const features = featureEntries.directories
    for (const feature of features) {
      expect(feature).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)
      const sourceFiles = await readdir(join(SRC, 'features', feature))
      expect(sourceFiles, feature).toContain('index.ts')
      expect(sourceFiles, feature).not.toContain('feature.ts')
      const testFiles = await readdir(join(TESTS, 'features', feature))
      expect(
        testFiles.some((name) => name.endsWith('.spec.ts')),
        feature
      ).toBeTrue()
    }
  })

  test('tests stay outside source and index.ts exists only as an entrypoint per layer', async () => {
    const sourcePaths = await descendants(SRC)
    const featureEntries = await namesByKind(join(SRC, 'features'))
    const featureDirectories = featureEntries.directories
    expect(sourcePaths.filter((path) => path.endsWith('.test.ts') || path.endsWith('.spec.ts') || path.split(sep).includes('test'))).toEqual([])
    expect(
      sourcePaths
        .filter((path) => path.endsWith(`${sep}index.ts`))
        .map((path) => relative(SRC, path))
        .toSorted()
    ).toEqual(['index.ts', ...featureDirectories.map((feature) => join('features', feature, 'index.ts'))].toSorted())
  })

  test('root specs are only package contracts', async () => {
    const rootTests = await namesByKind(TESTS)
    expect(rootTests.files).toEqual(['bun_effect.spec.ts', 'project_structure.spec.ts', 'registration.spec.ts'])
  })
})
