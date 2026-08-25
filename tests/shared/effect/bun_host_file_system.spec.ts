import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Cause, Effect, Result } from 'effect'

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
import { bunFileSystem, bunPath } from '@/shared/effect/bun_services.js'

describe('Bun host filesystem boundary', () => {
  it.live('exports only missing host capabilities', () =>
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

  it.live('refuses to read a held file larger than the lock-record ceiling', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'bun-host-lock-' })
      const path = bunPath.join(root, 'oversized')
      yield* bunFileSystem.writeFileString(path, 'x'.repeat(64 * 1024 + 1))
      const opened = yield* Effect.result(openHeldFile(path))
      expect(Result.isFailure(opened)).toBe(true)
    })
  )

  it.live('reports symlinks without following them and retains typed entries', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'bun-host-fs-' })
      const target = bunPath.join(root, 'target')
      const link = bunPath.join(root, 'link')
      yield* bunFileSystem.makeDirectory(target)
      yield* bunFileSystem.symlink(target, link)

      const info = yield* lstatHostFile(link)
      const entries = yield* readHostDirectoryEntries(root)
      expect(info.isSymbolicLink).toBe(true)
      expect(entries.find((entry) => entry.name === 'link')).toMatchObject({ isDirectory: false, isSymbolicLink: true })
    })
  )

  it.live('reads only a bounded owner-only artifact below its canonical root', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'bun-host-artifact-' })
      const artifact = bunPath.join(root, 'result.txt')
      yield* bunFileSystem.writeFileString(artifact, 'private result')
      yield* bunFileSystem.chmod(artifact, 0o600)

      const read = yield* readOwnerOnlyFile({ maxBytes: 64, path: artifact, root })
      expect(new TextDecoder().decode(read.bytes)).toBe('private result')
      expect(read.size).toBe(14)
      const oversized = yield* Effect.result(readOwnerOnlyFile({ maxBytes: 1, path: artifact, root }))
      expect(Result.isFailure(oversized)).toBe(true)
    })
  )

  it.live('rejects symlinks, root equality, non-regular files, and permissive artifacts', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'bun-host-reject-' })
      const outside = yield* bunFileSystem.makeTempDirectory({ prefix: 'bun-host-outside-' })
      const regular = bunPath.join(root, 'regular')
      const parent = bunPath.join(root, 'parent')
      const linkedParent = bunPath.join(root, 'linked-parent')
      const link = bunPath.join(root, 'link')
      const fifo = bunPath.join(root, 'fifo')
      yield* bunFileSystem.writeFileString(regular, 'secret')
      yield* bunFileSystem.chmod(regular, 0o644)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10, path: regular, root })))).toBe(true)
      yield* bunFileSystem.chmod(regular, 0o600)
      yield* bunFileSystem.symlink(regular, link)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10, path: link, root })))).toBe(true)
      yield* bunFileSystem.makeDirectory(parent)
      yield* bunFileSystem.writeFileString(bunPath.join(parent, 'file'), 'secret')
      yield* bunFileSystem.chmod(bunPath.join(parent, 'file'), 0o600)
      yield* bunFileSystem.symlink(parent, linkedParent)
      expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
      yield* bunFileSystem.chmod(fifo, 0o600)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10, path: bunPath.join(linkedParent, 'file'), root })))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10, path: fifo, root })))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10, path: root, root })))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10, path: outside, root })))).toBe(true)
    })
  )

  it.live('validates only owner-only worker sessions in the expected run layout', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'bun-host-session-' })
      const run = bunPath.join(root, 'run')
      const outside = bunPath.join(root, 'outside.jsonl')
      const session = bunPath.join(run, 'session.jsonl')
      const linkedParent = bunPath.join(run, 'linked-parent')
      const finalLink = bunPath.join(run, 'final-link')
      const directory = bunPath.join(run, 'directory')
      const fifo = bunPath.join(run, 'fifo')
      const permissive = bunPath.join(run, 'permissive')
      const wrongOwner = bunPath.join(run, 'wrong-owner')
      yield* bunFileSystem.makeDirectory(run)
      const expectedDir = yield* bunFileSystem.realPath(run)
      for (const path of [outside, session, permissive, wrongOwner]) {
        yield* bunFileSystem.writeFileString(path, 'session')
        yield* bunFileSystem.chmod(path, 0o600)
      }
      yield* bunFileSystem.makeDirectory(directory)
      yield* bunFileSystem.symlink(session, finalLink)
      yield* bunFileSystem.symlink(root, linkedParent)
      expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
      yield* bunFileSystem.chmod(fifo, 0o600)
      yield* bunFileSystem.chmod(permissive, 0o644)

      const validated = yield* validateWorkerSessionPath({ expectedDir, mode: 'create', path: session })
      expect(validated.canonicalPath).toBe(yield* bunFileSystem.realPath(session))
      expect(Result.isFailure(yield* Effect.result(validateWorkerSessionPath({ expectedDir, mode: 'create', path: finalLink })))).toBe(true)
      expect(
        Result.isFailure(
          yield* Effect.result(validateWorkerSessionPath({ expectedDir, mode: 'create', path: bunPath.join(linkedParent, 'outside.jsonl') }))
        )
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

  it.live('accepts exact bounds and rejects over-limit files before copying', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'bun-host-bounds-' })
      const empty = bunPath.join(root, 'empty')
      const exact = bunPath.join(root, 'exact')
      const oversized = bunPath.join(root, 'oversized')
      yield* bunFileSystem.writeFileString(empty, '')
      yield* bunFileSystem.writeFileString(exact, 'x'.repeat(10 * 1024 * 1024))
      yield* bunFileSystem.writeFileString(oversized, 'x'.repeat(10 * 1024 * 1024 + 1))
      for (const path of [empty, exact, oversized]) {
        yield* bunFileSystem.chmod(path, 0o600)
      }
      expect((yield* readOwnerOnlyFile({ maxBytes: 0, path: empty, root })).size).toBe(0)
      expect((yield* readOwnerOnlyFile({ maxBytes: 10 * 1024 * 1024, path: exact, root })).size).toBe(10 * 1024 * 1024)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 10 * 1024 * 1024, path: oversized, root })))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(readOwnerOnlyFile({ maxBytes: 1, path: exact, root })))).toBe(true)
    })
  )

  it.live('rejects a pathname replacement before the final descriptor check', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'bun-host-lock-' })
      const path = bunPath.join(root, 'lock')
      const displaced = bunPath.join(root, 'displaced')
      const held = yield* createHeldFile({ content: 'owned', path })
      try {
        const removed = yield* removeHeldFileIfUnchanged({
          beforeRevalidate: () =>
            bunFileSystem.rename(path, displaced).pipe(
              Effect.andThen(bunFileSystem.writeFileString(path, 'replacement')),
              Effect.mapError((cause) => new Cause.UnknownError(cause))
            ),
          contentMatches: (content) => content === 'owned',
          handle: held,
          path,
        })
        expect(removed).toBe(false)
        expect(yield* bunFileSystem.readFileString(path)).toBe('replacement')
      } finally {
        closeHeldFile(held)
      }
    })
  )

  it.live('removes only the still-owned file with matching content', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'bun-host-owned-' })
      const path = bunPath.join(root, 'lock')
      const held = yield* createHeldFile({ content: 'owned', path })
      try {
        expect(yield* removeHeldFileIfUnchanged({ contentMatches: (content) => content === 'owned', handle: held, path })).toBe(true)
        expect(yield* bunFileSystem.exists(path)).toBe(false)
      } finally {
        closeHeldFile(held)
      }
    })
  )

  it.live('reads a held file through a scope that closes it on failure', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'bun-host-scoped-' })
      const path = bunPath.join(root, 'lock')
      yield* bunFileSystem.writeFileString(path, 'owned')

      expect(yield* withHeldFile(path, (held) => Effect.succeed(heldFileContent(held)))).toBe('owned')
      const outcome = yield* Effect.result(withHeldFile(path, () => Effect.fail('use failed')))
      expect(Result.isFailure(outcome) && outcome.failure).toBe('use failed')
    })
  )

  it.live('reports an absent file as unremoved but surfaces a revalidation failure', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'bun-host-absent-' })
      const path = bunPath.join(root, 'lock')
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

        yield* bunFileSystem.remove(path)
        expect(yield* removeHeldFileIfUnchanged({ contentMatches: () => true, handle: held, path })).toBe(false)
      } finally {
        closeHeldFile(held)
      }
    })
  )

  it.live('keeps an owned file when its content token does not match', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'bun-host-token-' })
      const path = bunPath.join(root, 'lock')
      const held = yield* createHeldFile({ content: 'owned', path })
      try {
        expect(yield* removeHeldFileIfUnchanged({ contentMatches: (content) => content === 'other', handle: held, path })).toBe(false)
        expect(yield* bunFileSystem.readFileString(path)).toBe('owned')
      } finally {
        closeHeldFile(held)
      }
    })
  )
})
