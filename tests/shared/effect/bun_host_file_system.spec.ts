import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Cause, Effect, Result, FileSystem } from 'effect'

import { join } from '#shared/utils/path'
import {
  closeHeldFile,
  createHeldFile,
  heldFileContent,
  lstatHostFile,
  openHeldFile,
  readHostDirectoryEntries,
  readOwnerOnlyFile,
  removeHeldFileIfUnchanged,
  validateWorkerSessionPath,
  withHeldFile,
} from '@/shared/effect/bun_host_file_system.js'

describe('Bun host filesystem boundary', () => {
  it.effect('exports only missing host capabilities', () =>
    Effect.gen(function* () {
      const hostFileSystem = yield* Effect.promise(() => import('@/shared/effect/bun_host_file_system.js'))
      expect(Object.keys(hostFileSystem).toSorted()).toEqual([
        'closeHeldFile',
        'closeHostAppendFile',
        'createHeldFile',
        'createPrivateFile',
        'createPrivateSessionFile',
        'createPrivateSessionFilePromise',
        'ensurePrivateDirectory',
        'heldFileContent',
        'hostFilePermissions',
        'linuxProcessBirthMarker',
        'lstatHostFile',
        'openHeldFile',
        'openHostAppendFile',
        'openHostAppendFileSync',
        'readHostDirectoryEntries',
        'readOwnerOnlyFile',
        'removeHeldFileIfUnchanged',
        'removeHostPath',
        'validateWorkerSessionPath',
        'withHeldFile',
        'writePrivateFile',
        'writePrivateUniqueFile',
        'writePrivateUniqueFilePromise',
      ])
    })
  )

  it.effect('refuses to read a held file larger than the lock-record ceiling', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectory({ prefix: 'bun-host-lock-' })
      const path = join(root, 'oversized')
      yield* fs.writeFileString(path, 'x'.repeat(64 * 1024 + 1))
      const opened = yield* Effect.result(openHeldFile(path))
      expect(Result.isFailure(opened)).toBe(true)
    })
  )

  it.effect('reports symlinks without following them and retains typed entries', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectory({ prefix: 'bun-host-fs-' })
      const target = join(root, 'target')
      const link = join(root, 'link')
      yield* fs.makeDirectory(target)
      yield* fs.symlink(target, link)

      const info = yield* lstatHostFile(link)
      const entries = yield* readHostDirectoryEntries(root)
      expect(info.isSymbolicLink).toBe(true)
      expect(entries.find((entry) => entry.name === 'link')).toMatchObject({ isDirectory: false, isSymbolicLink: true })
    })
  )

  it.effect('reads only a bounded owner-only artifact below its canonical root', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectory({ prefix: 'bun-host-artifact-' })
      const artifact = join(root, 'result.txt')
      yield* fs.writeFileString(artifact, 'private result')
      yield* fs.chmod(artifact, 0o600)

      const read = yield* readOwnerOnlyFile({ maxBytes: 64, path: artifact, root })
      expect(new TextDecoder().decode(read.bytes)).toBe('private result')
      expect(read.size).toBe(14)
      const oversized = yield* Effect.result(readOwnerOnlyFile({ maxBytes: 1, path: artifact, root }))
      expect(Result.isFailure(oversized)).toBe(true)
    })
  )

  it.effect('rejects symlinks, root equality, non-regular files, and permissive artifacts', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectory({ prefix: 'bun-host-reject-' })
      const outside = yield* fs.makeTempDirectory({ prefix: 'bun-host-outside-' })
      const regular = join(root, 'regular')
      const parent = join(root, 'parent')
      const linkedParent = join(root, 'linked-parent')
      const link = join(root, 'link')
      const fifo = join(root, 'fifo')
      yield* fs.writeFileString(regular, 'secret')
      yield* fs.chmod(regular, 0o644)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10, path: regular, root })))).toBe(true)
      yield* fs.chmod(regular, 0o600)
      yield* fs.symlink(regular, link)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10, path: link, root })))).toBe(true)
      yield* fs.makeDirectory(parent)
      yield* fs.writeFileString(join(parent, 'file'), 'secret')
      yield* fs.chmod(join(parent, 'file'), 0o600)
      yield* fs.symlink(parent, linkedParent)
      expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
      yield* fs.chmod(fifo, 0o600)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10, path: join(linkedParent, 'file'), root })))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10, path: fifo, root })))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10, path: root, root })))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10, path: outside, root })))).toBe(true)
    })
  )

  it.effect('validates only owner-only worker sessions in the expected run layout', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectory({ prefix: 'bun-host-session-' })
      const run = join(root, 'run')
      const outside = join(root, 'outside.jsonl')
      const session = join(run, 'session.jsonl')
      const linkedParent = join(run, 'linked-parent')
      const finalLink = join(run, 'final-link')
      const directory = join(run, 'directory')
      const fifo = join(run, 'fifo')
      const permissive = join(run, 'permissive')
      const wrongOwner = join(run, 'wrong-owner')
      yield* fs.makeDirectory(run)
      const expectedDir = yield* fs.realPath(run)
      for (const path of [outside, session, permissive, wrongOwner]) {
        yield* fs.writeFileString(path, 'session')
        yield* fs.chmod(path, 0o600)
      }
      yield* fs.makeDirectory(directory)
      yield* fs.symlink(session, finalLink)
      yield* fs.symlink(root, linkedParent)
      expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
      yield* fs.chmod(fifo, 0o600)
      yield* fs.chmod(permissive, 0o644)

      const validated = yield* validateWorkerSessionPath({ expectedDir, mode: 'create', path: session })
      expect(validated.canonicalPath).toBe(yield* fs.realPath(session))
      expect(Result.isFailure(yield* Effect.result(validateWorkerSessionPath({ expectedDir, mode: 'create', path: finalLink })))).toBe(true)
      expect(
        Result.isFailure(yield* Effect.result(validateWorkerSessionPath({ expectedDir, mode: 'create', path: join(linkedParent, 'outside.jsonl') })))
      ).toBe(true)
      expect(Result.isFailure(yield* Effect.result(validateWorkerSessionPath({ expectedDir, mode: 'create', path: directory })))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(validateWorkerSessionPath({ expectedDir, mode: 'create', path: fifo })))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(validateWorkerSessionPath({ expectedDir, mode: 'create', path: permissive })))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(validateWorkerSessionPath({ expectedDir, mode: 'create', path: outside })))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(validateWorkerSessionPath({ expectedDir: session, mode: 'create', path: session })))).toBe(true)
      expect(
        Result.isFailure(
          yield* Effect.result(
            validateWorkerSessionPath({ expectedCanonicalPath: `${validated.canonicalPath}.other`, expectedDir, mode: 'open', path: session })
          )
        )
      ).toBe(true)
      expect(
        (yield* validateWorkerSessionPath({ expectedCanonicalPath: validated.canonicalPath, expectedDir, mode: 'open', path: session })).canonicalPath
      ).toBe(validated.canonicalPath)

      const chown = Bun.spawnSync(['chown', '65534', wrongOwner])
      if (chown.exitCode === 0) {
        expect(Result.isFailure(yield* Effect.result(validateWorkerSessionPath({ expectedDir, mode: 'create', path: wrongOwner })))).toBe(true)
      }
    })
  )

  it.effect('accepts exact bounds and rejects over-limit files before copying', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectory({ prefix: 'bun-host-bounds-' })
      const empty = join(root, 'empty')
      const exact = join(root, 'exact')
      const oversized = join(root, 'oversized')
      yield* fs.writeFileString(empty, '')
      yield* fs.writeFileString(exact, 'x'.repeat(10 * 1024 * 1024))
      yield* fs.writeFileString(oversized, 'x'.repeat(10 * 1024 * 1024 + 1))
      for (const path of [empty, exact, oversized]) {
        yield* fs.chmod(path, 0o600)
      }
      expect((yield* readOwnerOnlyFile({ maxBytes: 0, path: empty, root })).size).toBe(0)
      expect((yield* readOwnerOnlyFile({ maxBytes: 10 * 1024 * 1024, path: exact, root })).size).toBe(10 * 1024 * 1024)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10 * 1024 * 1024, path: oversized, root })))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 1, path: exact, root })))).toBe(true)
    })
  )

  it.effect('rejects a pathname replacement before the final descriptor check', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectory({ prefix: 'bun-host-lock-' })
      const path = join(root, 'lock')
      const displaced = join(root, 'displaced')
      const held = yield* createHeldFile({ content: 'owned', path })
      try {
        const removed = yield* removeHeldFileIfUnchanged({
          beforeRevalidate: () =>
            fs.rename(path, displaced).pipe(
              Effect.andThen(fs.writeFileString(path, 'replacement')),
              Effect.mapError((cause) => new Cause.UnknownError(cause))
            ),
          contentMatches: (content) => content === 'owned',
          handle: held,
          path,
        })
        expect(removed).toBe(false)
        expect(yield* fs.readFileString(path)).toBe('replacement')
      } finally {
        closeHeldFile(held)
      }
    })
  )

  it.effect('removes only the still-owned file with matching content', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectory({ prefix: 'bun-host-owned-' })
      const path = join(root, 'lock')
      const held = yield* createHeldFile({ content: 'owned', path })
      try {
        expect(yield* removeHeldFileIfUnchanged({ contentMatches: (content) => content === 'owned', handle: held, path })).toBe(true)
        expect(yield* fs.exists(path)).toBe(false)
      } finally {
        closeHeldFile(held)
      }
    })
  )

  it.effect('reads a held file through a scope that closes it on failure', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectory({ prefix: 'bun-host-scoped-' })
      const path = join(root, 'lock')
      yield* fs.writeFileString(path, 'owned')

      expect(yield* withHeldFile(path, (held) => Effect.succeed(heldFileContent(held)))).toBe('owned')
      const outcome = yield* Effect.result(withHeldFile(path, () => Effect.fail('use failed')))
      expect(Result.isFailure(outcome) && outcome.failure).toBe('use failed')
    })
  )

  it.effect('reports an absent file as unremoved but surfaces a revalidation failure', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectory({ prefix: 'bun-host-absent-' })
      const path = join(root, 'lock')
      const held = yield* createHeldFile({ content: 'owned', path })
      try {
        const failure = yield* Effect.result(
          removeHeldFileIfUnchanged({
            beforeRevalidate: () => Effect.fail(new Cause.UnknownError('revalidation unavailable')),
            contentMatches: () => true,
            handle: held,
            path,
          })
        )
        expect(Result.isFailure(failure)).toBe(true)

        yield* fs.remove(path)
        expect(yield* removeHeldFileIfUnchanged({ contentMatches: () => true, handle: held, path })).toBe(false)
      } finally {
        closeHeldFile(held)
      }
    })
  )

  it.effect('keeps an owned file when its content token does not match', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectory({ prefix: 'bun-host-token-' })
      const path = join(root, 'lock')
      const held = yield* createHeldFile({ content: 'owned', path })
      try {
        expect(yield* removeHeldFileIfUnchanged({ contentMatches: (content) => content === 'other', handle: held, path })).toBe(false)
        expect(yield* fs.readFileString(path)).toBe('owned')
      } finally {
        closeHeldFile(held)
      }
    })
  )
})
