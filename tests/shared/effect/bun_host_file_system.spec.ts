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
} from '@/shared/effect/bun_host_file_system.js'
import { bunFileSystem, bunPath } from '@/shared/effect/bun_services.js'

import { describe, expect, it } from '../../utils/bun_effect.js'

describe('Bun host filesystem boundary', () => {
  it.live('exports only missing host capabilities', () =>
    Effect.gen(function* () {
      const hostFileSystem = yield* Effect.promise(() => import('@/shared/effect/bun_host_file_system.js'))
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
