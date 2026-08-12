import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { asNarrowed, asTool } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'

import { register as safeRm } from '@/features/safe_rm/index.js'

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

const noop = (): void => undefined
const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

const setup = (): Tool => {
  const { pi, state } = createFakePi()
  safeRm(pi, runtime)
  return asTool<Tool>(state.tools.get('safe_rm'))
}

const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-rm-test-'))
  temporaryDirectories.push(root)
  const cwd = join(root, 'project')
  await mkdir(cwd)
  return { cwd, root }
}

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
    throw new Error('Expected promise to reject')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
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

  test('keeps a leading @ literal', async () => {
    const { cwd } = await workspace()
    await mkdir(join(cwd, '@types'))
    await mkdir(join(cwd, 'types'))
    await writeFile(join(cwd, '@types', 'marker'), 'scoped')
    await writeFile(join(cwd, 'types', 'marker'), 'plain')

    const result = await setup().execute('literal-at', { paths: ['@types'], recursive: true }, undefined, undefined, { cwd })

    expect(result.details).toEqual({ missing: [], removed: ['@types'] })
    expect(await Bun.file(join(cwd, '@types', 'marker')).exists()).toBeFalse()
    expect(await Bun.file(join(cwd, 'types', 'marker')).exists()).toBeTrue()
  })

  test('validates every target before deleting anything', async () => {
    const { cwd } = await workspace()
    await writeFile(join(cwd, 'keep.txt'), 'content')

    expect(
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

    expect(setup().execute('call-3', { paths: ['build'] }, undefined, undefined, { cwd })).rejects.toThrow('recursive: true')
    expect(
      setup().execute('call-4', { paths: ['.git'], recursive: true }, undefined, undefined, {
        cwd,
      })
    ).rejects.toThrow('Git metadata')
    expect(
      setup().execute('call-5', { paths: ['repository'], recursive: true }, undefined, undefined, {
        cwd,
      })
    ).rejects.toThrow('Git repository')
    expect(setup().execute('call-6', { paths: [join(externalMetadata, 'config')] }, undefined, undefined, { cwd })).rejects.toThrow('Git metadata')
    expect(await Bun.file(join(externalMetadata, 'config')).exists()).toBeTrue()
  })

  test('rejects paths that escape through a parent symlink', async () => {
    const { cwd } = await workspace()
    await symlink('/etc', join(cwd, 'outside'))

    expect(setup().execute('call-7', { paths: ['outside/hosts'] }, undefined, undefined, { cwd })).rejects.toThrow('escapes an allowed root')
  })

  test('refuses direct, nested, and symlink-aliased credentials', async () => {
    const { root, cwd } = await workspace()
    await writeFile(join(cwd, '.env'), 'TOKEN=secret')
    await mkdir(join(cwd, 'output'))
    await writeFile(join(cwd, 'output', '.npmrc'), 'token=secret')
    const credential = join(root, 'id_ed25519')
    await writeFile(credential, 'secret')
    await symlink(credential, join(cwd, 'ordinary.txt'))

    for (const params of [{ paths: ['.env'] }, { paths: ['ordinary.txt'] }, { paths: ['output'], recursive: true }]) {
      expect(setup().execute('credential', params, undefined, undefined, { cwd })).rejects.toThrow('protected path')
    }

    expect(await Bun.file(join(cwd, '.env')).exists()).toBeTrue()
    expect(await Bun.file(join(cwd, 'output', '.npmrc')).exists()).toBeTrue()
    expect(await Bun.file(credential).exists()).toBeTrue()
  })

  test('refuses a recursive parent containing nested Git metadata', async () => {
    const { cwd } = await workspace()
    await mkdir(join(cwd, 'artifacts', 'checkout', '.git'), { recursive: true })
    await writeFile(join(cwd, 'artifacts', 'checkout', '.git', 'config'), '[core]')

    expect(setup().execute('nested-git', { paths: ['artifacts'], recursive: true }, undefined, undefined, { cwd })).rejects.toThrow('Git repository')
    expect(await Bun.file(join(cwd, 'artifacts', 'checkout', '.git', 'config')).exists()).toBeTrue()
  })

  test('preserves tagged cancellation failures at the tool boundary', async () => {
    const { cwd } = await workspace()
    await writeFile(join(cwd, 'keep.txt'), 'content')
    const controller = new AbortController()
    controller.abort()

    const rejection = await setup()
      .execute('cancelled', { paths: ['keep.txt'] }, controller.signal, undefined, { cwd })
      .then(
        () => undefined,
        (error: unknown) => error
      )

    expect(rejection).toMatchObject({ _tag: 'CancelledError', message: 'Deletion was cancelled' })
    expect(await Bun.file(join(cwd, 'keep.txt')).exists()).toBeTrue()
  })

  test('preserves tagged cancellation after waiting for the mutation queue', async () => {
    const { cwd } = await workspace()
    const target = join(cwd, 'keep.txt')
    await writeFile(target, 'content')

    let markLockStarted: () => void = noop
    const lockStarted = new Promise<void>((resolve) => {
      markLockStarted = resolve
    })
    let releaseLock: () => void = noop
    const lock = withFileMutationQueue(
      target,
      () =>
        new Promise<void>((resolve) => {
          releaseLock = resolve
          markLockStarted()
        })
    )
    await lockStarted

    const controller = new AbortController()
    let cancellationChecks = 0
    let markQueued: () => void = noop
    const queued = new Promise<void>((resolve) => {
      markQueued = resolve
    })
    const signal = asNarrowed<AbortSignal, { readonly aborted: boolean }>({
      get aborted() {
        cancellationChecks += 1
        if (cancellationChecks === 3) {
          markQueued()
        }
        return controller.signal.aborted
      },
    })
    const deletion = setup().execute('queued-cancellation', { paths: ['keep.txt'] }, signal, undefined, { cwd })

    await queued
    controller.abort()
    releaseLock()
    await lock
    const rejection = await deletion.then(
      () => undefined,
      (error: unknown) => error
    )

    expect(rejection).toMatchObject({ _tag: 'CancelledError', message: 'Deletion was cancelled' })
    expect(await Bun.file(target).exists()).toBeTrue()
  })

  test('rejects distinct targets where one contains the other', async () => {
    const { cwd } = await workspace()
    await mkdir(join(cwd, 'build'))
    await writeFile(join(cwd, 'build', 'output.txt'), 'content')

    expect(
      await rejectionMessage(setup().execute('overlap', { paths: ['build', 'build/output.txt'], recursive: true }, undefined, undefined, { cwd }))
    ).toBe('Deletion targets must be distinct and non-overlapping: build, build/output.txt')
    expect(await Bun.file(join(cwd, 'build', 'output.txt')).exists()).toBeTrue()
  })

  test('asserts byte-exact validation error strings', async () => {
    const { cwd } = await workspace()
    await mkdir(join(cwd, 'build'))

    expect(await rejectionMessage(setup().execute('t1', { paths: ['~/escape'] }, undefined, undefined, { cwd }))).toBe(
      `Invalid literal deletion path: ${JSON.stringify('~/escape')}`
    )
    expect(await rejectionMessage(setup().execute('t2', { paths: ['/etc/hosts'] }, undefined, undefined, { cwd }))).toBe(
      'Deletion target must be below the working directory or /tmp: /etc/hosts'
    )
    expect(await rejectionMessage(setup().execute('t3', { paths: ['.git'], recursive: true }, undefined, undefined, { cwd }))).toBe(
      `Refusing to remove Git metadata: ${join(cwd, '.git')}`
    )
    expect(await rejectionMessage(setup().execute('t4', { paths: ['build'] }, undefined, undefined, { cwd }))).toBe(
      'Directory deletion requires recursive: true: build'
    )
  })
})
