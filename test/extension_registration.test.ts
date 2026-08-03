import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { asResult } from '#test-utils/casts'

/*
 * Bun runs every test file in a single process. Importing sub-agents here would populate the
 * module cache with the real Pi agent directory before src/sub-agents/test/core.test.ts installs
 * its mock for it, so that entrypoint is verified in a child process instead. The complete tool,
 * command, hook, and renderer contract for every extension is `registration_manifest.test.ts`,
 * which registers all 13 for real from both loading paths.
 */
const ISOLATED_EXTENSIONS = ['sub-agents']
const EXPECTED_ENTRYPOINTS = [
  'ask-user',
  'background-poll',
  'claude-code',
  'comment-checker',
  'hashline',
  'mcp',
  'meridian-session-affinity',
  'rules',
  'safe-rm',
  'safety-guard',
  'status-panel',
  'sub-agents',
  'webfetch',
].map((name) => `${name}/index.ts`)

const importsExtensionFactory = async (modulePath: string): Promise<boolean> => {
  const script = `
    const { default: extension } = await import(${JSON.stringify('MODULE_PATH')});
    if (typeof extension !== "function") process.exit(1);
  `.replace(JSON.stringify('MODULE_PATH'), JSON.stringify(modulePath))
  const child = Bun.spawn([process.execPath, '--eval', script], { stderr: 'pipe', stdout: 'pipe' })
  return (await child.exited) === 0
}

describe('extension entrypoints', () => {
  test('every auto-discovered module exports an extension factory', async () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url))
    const entries = await readdir(root, { withFileTypes: true })
    const discovered = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts')).map((entry) => join(root, entry.name))
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const children = await readdir(join(root, entry.name))
      if (children.includes('index.ts')) {
        discovered.push(join(root, entry.name, 'index.ts'))
      }
    }

    expect(discovered.map((path) => relative(root, path).split(sep).join('/')).toSorted()).toEqual(EXPECTED_ENTRYPOINTS.toSorted())
    for (const path of discovered) {
      if (ISOLATED_EXTENSIONS.some((name) => path.includes(`${sep}${name}${sep}`))) {
        expect(await importsExtensionFactory(path), path).toBeTrue()
        continue
      }
      const module = asResult<{ default?: unknown }>(await import(pathToFileURL(path).href))
      expect(module.default, path).toBeFunction()
    }
  })
})
