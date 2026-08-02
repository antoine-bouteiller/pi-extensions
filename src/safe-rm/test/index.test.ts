import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakePi } from '#test-utils/fake_pi'

import safeRm from '../index'

interface SafeRmResult {
  details: { removed: string[]; missing: string[] }
}

interface Tool {
  execute: (
    toolCallId: string,
    params: { paths: string[]; recursive?: boolean },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string }
  ) => Promise<SafeRmResult>
}

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

const setup = (): Tool => {
  const { pi, state } = createFakePi()
  safeRm(pi)
  return state.tools.get('safe_rm') as unknown as Tool
}

const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-rm-test-'))
  temporaryDirectories.push(root)
  const cwd = join(root, 'project')
  await mkdir(cwd)
  return { cwd, root }
}

describe('safe rm', () => {
  test('removes literal files and explicitly recursive directories', async () => {
    const { cwd } = await workspace()
    await writeFile(join(cwd, 'file.txt'), 'content')
    await mkdir(join(cwd, 'build'))
    await writeFile(join(cwd, 'build', 'output.txt'), 'content')

    const result = await setup().execute('call-1', { paths: ['file.txt', 'build'], recursive: true }, undefined, undefined, { cwd })

    expect(result.details).toEqual({ missing: [], removed: ['file.txt', 'build'] })
    expect(await Bun.file(join(cwd, 'file.txt')).exists()).toBeFalse()
    expect(await Bun.file(join(cwd, 'build', 'output.txt')).exists()).toBeFalse()
  })

  test('validates every target before deleting anything', async () => {
    const { cwd } = await workspace()
    await writeFile(join(cwd, 'keep.txt'), 'content')

    await expect(
      setup().execute('call-2', { paths: ['keep.txt', '/etc/hosts'] }, undefined, undefined, {
        cwd,
      })
    ).rejects.toThrow('working directory or /tmp')
    expect(await Bun.file(join(cwd, 'keep.txt')).exists()).toBeTrue()
  })

  test('requires recursive intent and protects Git metadata', async () => {
    const { cwd } = await workspace()
    await mkdir(join(cwd, 'build'))
    await mkdir(join(cwd, '.git'))
    await mkdir(join(cwd, 'repository', '.git'), { recursive: true })
    const externalRoot = await mkdtemp(join('/tmp', 'safe-rm-external-'))
    temporaryDirectories.push(externalRoot)
    const externalMetadata = join(externalRoot, 'repository', '.git')
    await mkdir(externalMetadata, { recursive: true })
    await writeFile(join(externalMetadata, 'config'), '[core]')

    await expect(setup().execute('call-3', { paths: ['build'] }, undefined, undefined, { cwd })).rejects.toThrow('recursive: true')
    await expect(
      setup().execute('call-4', { paths: ['.git'], recursive: true }, undefined, undefined, {
        cwd,
      })
    ).rejects.toThrow('Git metadata')
    await expect(
      setup().execute('call-5', { paths: ['repository'], recursive: true }, undefined, undefined, {
        cwd,
      })
    ).rejects.toThrow('Git repository')
    await expect(setup().execute('call-6', { paths: [join(externalMetadata, 'config')] }, undefined, undefined, { cwd })).rejects.toThrow(
      'Git metadata'
    )
    expect(await Bun.file(join(externalMetadata, 'config')).exists()).toBeTrue()
  })

  test('rejects paths that escape through a parent symlink', async () => {
    const { cwd } = await workspace()
    await symlink('/etc', join(cwd, 'outside'))

    await expect(setup().execute('call-7', { paths: ['outside/hosts'] }, undefined, undefined, { cwd })).rejects.toThrow('escapes an allowed root')
  })

  test('refuses direct, nested, and symlink-aliased credentials', async () => {
    const { root, cwd } = await workspace()
    await writeFile(join(cwd, '.env'), 'TOKEN=secret')
    await mkdir(join(cwd, 'output'))
    await writeFile(join(cwd, 'output', '.npmrc'), 'token=secret')
    const credential = join(root, 'id_ed25519')
    await writeFile(credential, 'secret')
    await symlink(credential, join(cwd, 'ordinary.txt'))

    for (const params of [{ paths: ['.env'] }, { paths: ['@.env'] }, { paths: ['ordinary.txt'] }, { paths: ['output'], recursive: true }]) {
      await expect(setup().execute('credential', params, undefined, undefined, { cwd })).rejects.toThrow('protected path')
    }

    expect(await Bun.file(join(cwd, '.env')).exists()).toBeTrue()
    expect(await Bun.file(join(cwd, 'output', '.npmrc')).exists()).toBeTrue()
    expect(await Bun.file(credential).exists()).toBeTrue()
  })

  test('refuses a recursive parent containing nested Git metadata', async () => {
    const { cwd } = await workspace()
    await mkdir(join(cwd, 'artifacts', 'checkout', '.git'), { recursive: true })
    await writeFile(join(cwd, 'artifacts', 'checkout', '.git', 'config'), '[core]')

    await expect(setup().execute('nested-git', { paths: ['artifacts'], recursive: true }, undefined, undefined, { cwd })).rejects.toThrow(
      'Git repository'
    )
    expect(await Bun.file(join(cwd, 'artifacts', 'checkout', '.git', 'config')).exists()).toBeTrue()
  })

  test('honors cancellation before removing anything', async () => {
    const { cwd } = await workspace()
    await writeFile(join(cwd, 'keep.txt'), 'content')
    const controller = new AbortController()
    controller.abort()

    await expect(setup().execute('cancelled', { paths: ['keep.txt'] }, controller.signal, undefined, { cwd })).rejects.toThrow('cancelled')
    expect(await Bun.file(join(cwd, 'keep.txt')).exists()).toBeTrue()
  })
})
