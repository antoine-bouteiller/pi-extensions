// oxlint-disable-next-line effecttsgo/node-builtin-import -- `stat` preserves file-only existence semantics.
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { Effect, FileSystem, Path } from 'effect'
import { afterEach } from 'vitest'

import { register as safeRm } from '#features/safe_rm/index'
import { makeAbortController } from '#tests/utils/abort_controller'
import { asNarrowed, asTool } from '#tests/utils/casts'
import { deferred } from '#tests/utils/deferred'
import { describe, expect, it, promiseFromEffect, tryPromiseEffect } from '#tests/utils/effect'
import { createFakePi } from '#tests/utils/fake_pi'
import { runtime } from '#tests/utils/runtime'

const fileExists = (path: string): Promise<boolean> =>
  stat(path)
    .then((info) => info.isFile())
    .catch(() => false)

const pathService = runtime.runSync(Path.Path)
const { join } = pathService
const mkdir = (path: string, options?: { recursive?: boolean }) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeDirectory(path, options)))
const mkdtemp = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectory({ directory: pathService.dirname(prefix), prefix: pathService.basename(prefix) }))
  )
const rm = (path: string, options?: { force?: boolean; recursive?: boolean }) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.remove(path, options)))
const symlink = (fromPath: string, toPath: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.symlink(fromPath, toPath)))
const writeFile = (path: string, data: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.writeFileString(path, data)))

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
afterEach(() =>
  runtime.runPromise(
    Effect.forEach(temporaryDirectories.splice(0), (path) => rm(path, { force: true, recursive: true }), { concurrency: 'unbounded' })
  )
)

const setup = (): Tool => {
  const { pi, state } = createFakePi()
  safeRm(pi, runtime)
  return asTool<Tool>(state.tools.get('safe_rm'))
}

const workspace = Effect.gen(function* () {
  const root = yield* mkdtemp(join(tmpdir(), 'safe-rm-test-'))
  temporaryDirectories.push(root)
  const cwd = join(root, 'project')
  yield* mkdir(cwd)
  return { cwd, root }
})

const rejectionMessage = (promise: Promise<unknown>): Promise<string> =>
  promiseFromEffect(
    tryPromiseEffect(() => promise).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(error.cause instanceof Error ? error.cause.message : String(error.cause)),
        onSuccess: () => Effect.die(new Error('Expected promise to reject')),
      })
    )
  )

describe('safe rm', () => {
  it.effect('removes literal files and explicitly recursive directories', () =>
    Effect.gen(function* () {
      const { cwd } = yield* workspace
      yield* writeFile(join(cwd, 'file.txt'), 'content')
      yield* mkdir(join(cwd, 'build'))
      yield* writeFile(join(cwd, 'build', 'output.txt'), 'content')

      const result = yield* Effect.promise(() =>
        setup().execute('call-1', { paths: ['file.txt', 'build'], recursive: true }, undefined, undefined, { cwd })
      )

      expect(result.details).toEqual({ missing: [], removed: ['file.txt', 'build'] })
      expect(yield* Effect.promise(() => fileExists(join(cwd, 'file.txt')))).toBe(false)
      expect(yield* Effect.promise(() => fileExists(join(cwd, 'build', 'output.txt')))).toBe(false)
    })
  )

  it.effect('keeps a leading @ literal', () =>
    Effect.gen(function* () {
      const { cwd } = yield* workspace
      yield* mkdir(join(cwd, '@types'))
      yield* mkdir(join(cwd, 'types'))
      yield* writeFile(join(cwd, '@types', 'marker'), 'scoped')
      yield* writeFile(join(cwd, 'types', 'marker'), 'plain')

      const result = yield* Effect.promise(() => setup().execute('literal-at', { paths: ['@types'], recursive: true }, undefined, undefined, { cwd }))

      expect(result.details).toEqual({ missing: [], removed: ['@types'] })
      expect(yield* Effect.promise(() => fileExists(join(cwd, '@types', 'marker')))).toBe(false)
      expect(yield* Effect.promise(() => fileExists(join(cwd, 'types', 'marker')))).toBe(true)
    })
  )

  it.effect('validates every target before deleting anything', () =>
    Effect.gen(function* () {
      const { cwd } = yield* workspace
      yield* writeFile(join(cwd, 'keep.txt'), 'content')

      yield* Effect.promise(() =>
        expect(
          setup().execute('call-2', { paths: ['keep.txt', '/etc/hosts'] }, undefined, undefined, {
            cwd,
          })
        ).rejects.toThrow('working directory or /tmp')
      )
      expect(yield* Effect.promise(() => fileExists(join(cwd, 'keep.txt')))).toBe(true)
    })
  )

  it.effect('requires recursive intent and removes Git metadata', () =>
    Effect.gen(function* () {
      const { cwd } = yield* workspace
      yield* mkdir(join(cwd, 'build'))
      yield* mkdir(join(cwd, '.git'))
      yield* mkdir(join(cwd, 'repository', '.git'), { recursive: true })
      const externalRoot = yield* mkdtemp(join('/tmp', 'safe-rm-external-'))
      temporaryDirectories.push(externalRoot)
      const externalMetadata = join(externalRoot, 'repository', '.git')
      yield* mkdir(externalMetadata, { recursive: true })
      yield* writeFile(join(externalMetadata, 'config'), '[core]')

      yield* Effect.promise(() =>
        expect(setup().execute('call-3', { paths: ['build'] }, undefined, undefined, { cwd })).rejects.toThrow('recursive: true')
      )
      yield* Effect.promise(() => setup().execute('call-4', { paths: ['.git'], recursive: true }, undefined, undefined, { cwd }))
      yield* Effect.promise(() => setup().execute('call-5', { paths: ['repository'], recursive: true }, undefined, undefined, { cwd }))
      yield* Effect.promise(() => setup().execute('call-6', { paths: [join(externalMetadata, 'config')] }, undefined, undefined, { cwd }))
      expect(yield* Effect.promise(() => fileExists(join(cwd, '.git')))).toBe(false)
      expect(yield* Effect.promise(() => fileExists(join(cwd, 'repository', '.git')))).toBe(false)
      expect(yield* Effect.promise(() => fileExists(join(externalMetadata, 'config')))).toBe(false)
    })
  )

  it.effect('rejects paths that escape through a parent symlink', () =>
    Effect.gen(function* () {
      const { cwd } = yield* workspace
      yield* symlink('/etc', join(cwd, 'outside'))

      yield* Effect.promise(() =>
        expect(setup().execute('call-7', { paths: ['outside/hosts'] }, undefined, undefined, { cwd })).rejects.toThrow('escapes an allowed root')
      )
    })
  )

  it.effect('refuses direct, nested, and symlink-aliased credentials', () =>
    Effect.gen(function* () {
      const { root, cwd } = yield* workspace
      yield* writeFile(join(cwd, '.env'), 'TOKEN=secret')
      yield* mkdir(join(cwd, 'output'))
      yield* writeFile(join(cwd, 'output', '.env.local'), 'token=secret')
      const credential = join(root, '.ssh', 'id_ed25519')
      yield* mkdir(join(root, '.ssh'))
      yield* writeFile(credential, 'secret')
      yield* symlink(credential, join(cwd, 'ordinary.txt'))

      for (const params of [{ paths: ['.env'] }, { paths: ['ordinary.txt'] }, { paths: ['output'], recursive: true }]) {
        yield* Effect.promise(() => expect(setup().execute('credential', params, undefined, undefined, { cwd })).rejects.toThrow('protected path'))
      }

      expect(yield* Effect.promise(() => fileExists(join(cwd, '.env')))).toBe(true)
      expect(yield* Effect.promise(() => fileExists(join(cwd, 'output', '.env.local')))).toBe(true)
      expect(yield* Effect.promise(() => fileExists(credential))).toBe(true)
    })
  )

  it.effect('removes a recursive parent containing nested Git metadata', () =>
    Effect.gen(function* () {
      const { cwd } = yield* workspace
      yield* mkdir(join(cwd, 'artifacts', 'checkout', '.git'), { recursive: true })
      yield* writeFile(join(cwd, 'artifacts', 'checkout', '.git', 'config'), '[core]')

      yield* Effect.promise(() => setup().execute('nested-git', { paths: ['artifacts'], recursive: true }, undefined, undefined, { cwd }))
      expect(yield* Effect.promise(() => fileExists(join(cwd, 'artifacts')))).toBe(false)
    })
  )

  it.effect('preserves tagged cancellation failures at the tool boundary', () =>
    Effect.gen(function* () {
      const { cwd } = yield* workspace
      yield* writeFile(join(cwd, 'keep.txt'), 'content')
      const signal = AbortSignal.abort()

      const rejection = yield* Effect.promise(() =>
        setup()
          .execute('cancelled', { paths: ['keep.txt'] }, signal, undefined, { cwd })
          .then(
            () => undefined,
            (error: unknown) => error
          )
      )

      expect(rejection).toMatchObject({ _tag: 'CancelledError', message: 'Deletion was cancelled' })
      expect(yield* Effect.promise(() => fileExists(join(cwd, 'keep.txt')))).toBe(true)
    })
  )

  it.effect('preserves tagged cancellation after waiting for the mutation queue', () =>
    Effect.gen(function* () {
      const { cwd } = yield* workspace
      const target = join(cwd, 'keep.txt')
      yield* writeFile(target, 'content')

      const lockStarted = deferred<void>()
      const lockGate = deferred<void>()
      const lock = withFileMutationQueue(target, () => {
        lockStarted.resolve(undefined)
        return lockGate.promise
      })
      yield* Effect.promise(() => lockStarted.promise)

      const controller = makeAbortController()
      let cancellationChecks = 0
      const queued = deferred<void>()
      const signal = asNarrowed<AbortSignal, { readonly aborted: boolean }>({
        get aborted() {
          cancellationChecks += 1
          if (cancellationChecks === 3) {
            queued.resolve(undefined)
          }
          return controller.signal.aborted
        },
      })
      const deletion = setup().execute('queued-cancellation', { paths: ['keep.txt'] }, signal, undefined, { cwd })

      yield* Effect.promise(() => queued.promise)
      controller.abort()
      lockGate.resolve(undefined)
      yield* Effect.promise(() => lock)
      const rejection = yield* Effect.promise(() =>
        deletion.then(
          () => undefined,
          (error: unknown) => error
        )
      )

      expect(rejection).toMatchObject({ _tag: 'CancelledError', message: 'Deletion was cancelled' })
      expect(yield* Effect.promise(() => fileExists(target))).toBe(true)
    })
  )

  it.effect('rejects distinct targets where one contains the other', () =>
    Effect.gen(function* () {
      const { cwd } = yield* workspace
      yield* mkdir(join(cwd, 'build'))
      yield* writeFile(join(cwd, 'build', 'output.txt'), 'content')

      expect(
        yield* Effect.promise(() =>
          rejectionMessage(setup().execute('overlap', { paths: ['build', 'build/output.txt'], recursive: true }, undefined, undefined, { cwd }))
        )
      ).toBe('Deletion targets must be distinct and non-overlapping: build, build/output.txt')
      expect(yield* Effect.promise(() => fileExists(join(cwd, 'build', 'output.txt')))).toBe(true)
    })
  )

  it.effect('asserts byte-exact validation error strings', () =>
    Effect.gen(function* () {
      const { cwd } = yield* workspace
      yield* mkdir(join(cwd, 'build'))

      expect(yield* Effect.promise(() => rejectionMessage(setup().execute('t1', { paths: ['~/escape'] }, undefined, undefined, { cwd })))).toBe(
        'Invalid literal deletion path: "~/escape"'
      )
      expect(yield* Effect.promise(() => rejectionMessage(setup().execute('t2', { paths: ['/etc/hosts'] }, undefined, undefined, { cwd })))).toBe(
        'Deletion target must be below the working directory or /tmp: /etc/hosts'
      )
      expect(yield* Effect.promise(() => rejectionMessage(setup().execute('t4', { paths: ['build'] }, undefined, undefined, { cwd })))).toBe(
        'Directory deletion requires recursive: true: build'
      )
    })
  )
})
