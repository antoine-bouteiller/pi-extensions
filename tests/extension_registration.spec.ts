import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { asResult } from '@tests/utils/casts.js'

const EXPECTED_FEATURES = [
  'ask_user',
  'background_poll',
  'claude_code',
  'comment_checker',
  'hashline',
  'mcp',
  'meridian_session_affinity',
  'rules',
  'safe_rm',
  'safety_guard',
  'status_panel',
  'sub_agents',
  'webfetch',
]

const importsContract = async (modulePath: string, condition: string): Promise<boolean> => {
  const script = `
    const module = await import(${JSON.stringify('MODULE_PATH')});
    if (!(${condition})) process.exit(1);
  `.replace(JSON.stringify('MODULE_PATH'), JSON.stringify(modulePath))
  const child = Bun.spawn([process.execPath, '--eval', script], { stderr: 'pipe', stdout: 'pipe' })
  return (await child.exited) === 0
}

describe('extension entrypoints', () => {
  test('Pi discovers only src/index.ts', async () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url))
    const entries = await readdir(root, { withFileTypes: true })
    const discovered = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts')).map((entry) => join(root, entry.name))
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const children = await readdir(join(root, entry.name))
      if (children.includes('index.ts')) {
        discovered.push(join(root, entry.name, 'index.ts'))
      }
    }

    expect(discovered.map((path) => relative(root, path).split(sep).join('/'))).toEqual(['index.ts'])
    expect(await importsContract(pathToFileURL(discovered[0]).href, 'typeof module.default === "function"')).toBeTrue()
  })

  test('every internal feature exposes only a named register entrypoint', async () => {
    const featuresRoot = fileURLToPath(new URL('../src/features/', import.meta.url))
    const entries = await readdir(featuresRoot, { withFileTypes: true })
    expect(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted()
    ).toEqual(EXPECTED_FEATURES.toSorted())

    for (const feature of EXPECTED_FEATURES) {
      const children = await readdir(join(featuresRoot, feature))
      expect(children, feature).toContain('feature.ts')
      expect(children, feature).not.toContain('index.ts')
      const modulePath = pathToFileURL(join(featuresRoot, feature, 'feature.ts')).href
      // Keep sub_agents out of Bun's shared module cache until core.spec installs its getAgentDir mock.
      if (feature === 'sub_agents') {
        expect(await importsContract(modulePath, "typeof module.register === 'function' && module.default === undefined"), modulePath).toBeTrue()
      } else {
        const module = asResult<{ default?: unknown; register?: unknown }>(await import(modulePath))
        expect(module.register, modulePath).toBeFunction()
        expect(module.default, modulePath).toBeUndefined()
      }
    }
  })

  test('composition and shared folders have no Pi-discoverable barrels', async () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url))
    for (const folder of ['config', 'features', 'shared']) {
      expect(await readdir(join(root, folder)), folder).not.toContain('index.ts')
    }
  })
})
