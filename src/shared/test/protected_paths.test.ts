import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeFileSystem } from '@effect/platform-node'
import { Effect } from 'effect'
import { type FileSystem } from 'effect/FileSystem'

import { assertUnprotectedPathEffect, isProtectedPath, ProtectedPathError, resolveProtectedPathEffect } from '../protected_paths.js'

const roots: string[] = []
// Realpath, because on macOS mkdtemp hands back /var/... while /var is a symlink to /private/var.
const makeRoot = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'protected-paths-')))
  roots.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })))
})

/*
 * Deliberately the real filesystem, not FileSystem.layerNoop: layerNoop reports every path as
 * missing, so it cannot prove Node's actual realpath behaviour and would delete the oracle these
 * symlink-evasion cases exist to provide.
 */
const run = <Success, Failure>(effect: Effect.Effect<Success, Failure, FileSystem>) => Effect.runPromise(Effect.provide(effect, NodeFileSystem.layer))

describe('protected path resolution over FileSystem', () => {
  it('matches the callback implementation on plain paths', async () => {
    const root = await makeRoot()
    const cases = ['.env', '.env.example', 'src/index.ts', '.ssh/id_rsa', 'secrets.pem']

    for (const path of cases) {
      const viaEffect = await run(resolveProtectedPathEffect(path, root))
      expect([path, viaEffect.protected]).toEqual([path, await isProtectedPath(path, root)])
    }
  })

  it('canonicalizes through a symlink so an alias cannot launder a credential', async () => {
    const root = await makeRoot()
    await writeFile(join(root, '.env'), 'SECRET=1')
    await symlink(join(root, '.env'), join(root, 'harmless.txt'))

    const resolution = await run(resolveProtectedPathEffect('harmless.txt', root))

    expect(resolution.protected).toBe(true)
    expect(resolution.canonicalPath).toBe(join(root, '.env'))
  })

  it('canonicalizes the nearest existing ancestor for a path that does not exist yet', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'real-secrets'))
    await symlink(join(root, 'real-secrets'), join(root, 'link'))

    const resolution = await run(resolveProtectedPathEffect('link/id_rsa', root))

    expect(resolution.protected).toBe(true)
    expect(resolution.canonicalPath).toBe(join(root, 'real-secrets', 'id_rsa'))
  })

  /*
   * Effect reports ENOTDIR as BadResource, not NotFound. If the walk branched on Effect's reason
   * instead of the underlying errno it would stop here instead of walking up to the real ancestor.
   */
  it('walks past a non-directory component (ENOTDIR), which Effect reports as BadResource', async () => {
    const root = await makeRoot()
    await writeFile(join(root, 'file.txt'), 'contents')

    const resolution = await run(resolveProtectedPathEffect('file.txt/nested/.env', root))

    expect(resolution.protected).toBe(true)
    expect(resolution.canonicalPath).toBe(join(root, 'file.txt', 'nested', '.env'))
  })

  it('fails with the same message the callback version throws', async () => {
    const root = await makeRoot()

    const failure = await Effect.runPromise(assertUnprotectedPathEffect('.env', root, 'read').pipe(Effect.flip, Effect.provide(NodeFileSystem.layer)))

    expect(failure).toBeInstanceOf(ProtectedPathError)
    expect(failure.message).toBe('Refusing to read protected path: .env')
  })

  it('returns the resolution for an unprotected path', async () => {
    const root = await makeRoot()
    const resolution = await run(assertUnprotectedPathEffect('src/index.ts', root, 'read'))

    expect(resolution.protected).toBe(false)
    expect(resolution.absolutePath).toBe(join(root, 'src', 'index.ts'))
  })
})
