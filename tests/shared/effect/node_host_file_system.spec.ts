import { Cause, Effect, Result } from 'effect'

import {
  closeHeldFile,
  createHeldFile,
  heldFileContent,
  lstatHostFile,
  openHeldFile,
  readHostDirectoryEntries,
  removeHeldFileIfUnchanged,
  withHeldFile,
} from '#shared/effect/node_host_file_system'
import { nodeFileSystem, nodePath } from '#shared/effect/node_services'

import { describe, expect, it } from '../../utils/effect'

describe('Node host filesystem boundary', () => {
  it.live('exports only missing host capabilities', () =>
    Effect.gen(function* () {
      const hostFileSystem = yield* Effect.promise(() => import('#shared/effect/node_host_file_system'))
      expect(Object.keys(hostFileSystem).toSorted()).toEqual([
        'closeHeldFile',
        'createHeldFile',
        'heldFileContent',
        'lstatHostFile',
        'openHeldFile',
        'readHostDirectoryEntries',
        'removeHeldFileIfUnchanged',
        'withHeldFile',
      ])
    })
  )

  it.live('refuses to read a held file larger than the lock-record ceiling', () =>
    Effect.gen(function* () {
      const root = yield* nodeFileSystem.makeTempDirectory({ prefix: 'node-host-lock-' })
      const path = nodePath.join(root, 'oversized')
      yield* nodeFileSystem.writeFileString(path, 'x'.repeat(64 * 1024 + 1))
      const opened = yield* Effect.result(openHeldFile(path))
      expect(Result.isFailure(opened)).toBe(true)
    })
  )

  it.live('reports symlinks without following them and retains typed entries', () =>
    Effect.gen(function* () {
      const root = yield* nodeFileSystem.makeTempDirectory({ prefix: 'node-host-fs-' })
      const target = nodePath.join(root, 'target')
      const link = nodePath.join(root, 'link')
      yield* nodeFileSystem.makeDirectory(target)
      yield* nodeFileSystem.symlink(target, link)

      const info = yield* lstatHostFile(link)
      const entries = yield* readHostDirectoryEntries(root)
      expect(info.isSymbolicLink).toBe(true)
      expect(entries.find((entry) => entry.name === 'link')).toMatchObject({ isDirectory: false, isSymbolicLink: true })
    })
  )

  it.live('rejects a pathname replacement before the final descriptor check', () =>
    Effect.gen(function* () {
      const root = yield* nodeFileSystem.makeTempDirectory({ prefix: 'node-host-lock-' })
      const path = nodePath.join(root, 'lock')
      const displaced = nodePath.join(root, 'displaced')
      const held = yield* createHeldFile({ content: 'owned', path })
      try {
        const removed = yield* removeHeldFileIfUnchanged({
          beforeRevalidate: () =>
            nodeFileSystem.rename(path, displaced).pipe(
              Effect.andThen(nodeFileSystem.writeFileString(path, 'replacement')),
              Effect.mapError((cause) => new Cause.UnknownError(cause))
            ),
          contentMatches: (content) => content === 'owned',
          handle: held,
          path,
        })
        expect(removed).toBe(false)
        expect(yield* nodeFileSystem.readFileString(path)).toBe('replacement')
      } finally {
        closeHeldFile(held)
      }
    })
  )

  it.live('removes only the still-owned file with matching content', () =>
    Effect.gen(function* () {
      const root = yield* nodeFileSystem.makeTempDirectory({ prefix: 'node-host-owned-' })
      const path = nodePath.join(root, 'lock')
      const held = yield* createHeldFile({ content: 'owned', path })
      try {
        expect(yield* removeHeldFileIfUnchanged({ contentMatches: (content) => content === 'owned', handle: held, path })).toBe(true)
        expect(yield* nodeFileSystem.exists(path)).toBe(false)
      } finally {
        closeHeldFile(held)
      }
    })
  )

  it.live('reads a held file through a scope that closes it on failure', () =>
    Effect.gen(function* () {
      const root = yield* nodeFileSystem.makeTempDirectory({ prefix: 'node-host-scoped-' })
      const path = nodePath.join(root, 'lock')
      yield* nodeFileSystem.writeFileString(path, 'owned')

      expect(yield* withHeldFile(path, (held) => Effect.succeed(heldFileContent(held)))).toBe('owned')
      const outcome = yield* Effect.result(withHeldFile(path, () => Effect.fail('use failed')))
      expect(Result.isFailure(outcome) && outcome.failure).toBe('use failed')
    })
  )

  it.live('reports an absent file as unremoved but surfaces a revalidation failure', () =>
    Effect.gen(function* () {
      const root = yield* nodeFileSystem.makeTempDirectory({ prefix: 'node-host-absent-' })
      const path = nodePath.join(root, 'lock')
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

        yield* nodeFileSystem.remove(path)
        expect(yield* removeHeldFileIfUnchanged({ contentMatches: () => true, handle: held, path })).toBe(false)
      } finally {
        closeHeldFile(held)
      }
    })
  )

  it.live('keeps an owned file when its content token does not match', () =>
    Effect.gen(function* () {
      const root = yield* nodeFileSystem.makeTempDirectory({ prefix: 'node-host-token-' })
      const path = nodePath.join(root, 'lock')
      const held = yield* createHeldFile({ content: 'owned', path })
      try {
        expect(yield* removeHeldFileIfUnchanged({ contentMatches: (content) => content === 'other', handle: held, path })).toBe(false)
        expect(yield* nodeFileSystem.readFileString(path)).toBe('owned')
      } finally {
        closeHeldFile(held)
      }
    })
  )
})
