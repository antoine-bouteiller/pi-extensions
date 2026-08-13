import { Effect } from 'effect'

import {
  closeHeldFile,
  createHeldFile,
  hostFileSystemSync,
  lstatHostFile,
  readHostDirectoryEntries,
  removeHeldFileIfUnchanged,
} from '@/shared/effect/bun_host_file_system.js'
import { bunFileSystem, bunPath } from '@/shared/effect/bun_services.js'

import { describe, expect, it } from '../../utils/bun_effect.js'

describe('Bun host filesystem boundary', () => {
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
        const removed = removeHeldFileIfUnchanged({
          beforeRevalidate() {
            hostFileSystemSync.rename(path, displaced)
            hostFileSystemSync.writeFile(path, 'replacement')
          },
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
})
