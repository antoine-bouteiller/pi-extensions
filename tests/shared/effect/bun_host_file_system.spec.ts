import { Cause, Effect } from 'effect'

import {
  closeHeldFile,
  createHeldFile,
  lstatHostFile,
  readHostDirectoryEntries,
  removeHeldFileIfUnchanged,
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
      ])
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
