import { Effect, FileSystem, Path } from 'effect'
import { layerNoop } from 'effect/FileSystem'
import { systemError } from 'effect/PlatformError'

import { assertUnprotectedPathEffect, ProtectedPathError, resolveProtectedPathEffect } from '#shared/utils/protected_paths'
import { isRecord } from '#shared/utils/records'
import { describe, expect, it } from '#tests/utils/effect'

const makeRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'protected-paths-' })
  // Realpath, because on macOS temporary directories may use /var while /var is a symlink to /private/var.
  return yield* fs.realPath(root)
})

const errnoCode = (failure: { readonly cause?: unknown }): unknown => (isRecord(failure.cause) ? failure.cause.code : undefined)

describe('protected path resolution over FileSystem', () => {
  it.effect('applies the protected-file policy to plain paths', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeRoot
        const cases: [string, boolean][] = [
          ['.env', true],
          ['.env.example', false],
          ['src/index.ts', false],
          ['.ssh/id_rsa', true],
          ['secrets.pem', false],
          ['.docker/config.json', false],
          ['.kube/config', false],
          ['docker/config.json', false],
        ]

        for (const [path, expected] of cases) {
          const viaEffect = yield* resolveProtectedPathEffect(path, root)
          expect([path, viaEffect.protected]).toEqual([path, expected])
        }
      })
    )
  )

  it.effect('canonicalizes through a symlink so an alias cannot launder a credential', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* makeRoot
        yield* fs.writeFileString(path.join(root, '.env'), 'SECRET=1')
        yield* fs.symlink(path.join(root, '.env'), path.join(root, 'harmless.txt'))

        const resolution = yield* resolveProtectedPathEffect('harmless.txt', root)

        expect(resolution.protected).toBe(true)
        expect(resolution.canonicalPath).toBe(path.join(root, '.env'))
      })
    )
  )

  it.effect('canonicalizes the nearest existing ancestor for a path that does not exist yet', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* makeRoot
        yield* fs.makeDirectory(path.join(root, '.ssh'))
        yield* fs.symlink(path.join(root, '.ssh'), path.join(root, 'link'))

        const resolution = yield* resolveProtectedPathEffect('link/id_rsa', root)

        expect(resolution.protected).toBe(true)
        expect(resolution.canonicalPath).toBe(path.join(root, '.ssh', 'id_rsa'))
      })
    )
  )

  /*
   * Effect reports ENOTDIR as BadResource, not NotFound. If the walk branched on Effect's reason
   * instead of the underlying errno it would stop here instead of walking up to the real ancestor.
   */
  it.effect('walks past a non-directory component (ENOTDIR), which Effect reports as BadResource', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* makeRoot
        yield* fs.writeFileString(path.join(root, 'file.txt'), 'contents')

        const resolution = yield* resolveProtectedPathEffect('file.txt/nested/.env', root)

        expect(resolution.protected).toBe(true)
        expect(resolution.canonicalPath).toBe(path.join(root, 'file.txt', 'nested', '.env'))
      })
    )
  )

  it.effect('fails with the same message the callback version throws', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeRoot
        const failure = yield* Effect.flip(assertUnprotectedPathEffect('.env', root, 'read'))

        expect(failure).toBeInstanceOf(ProtectedPathError)
        expect(failure.message).toBe('Refusing to read protected path: .env')
      })
    )
  )

  /*
   * ELOOP and EACCES are BadResource and PermissionDenied respectively. Neither is "missing", so
   * both must abort the walk rather than be swallowed -- a swallowed ELOOP would let a symlink
   * cycle read as an unprotected path.
   */
  it.effect('propagates a symlink loop (ELOOP) instead of treating it as missing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* makeRoot
        yield* fs.symlink(path.join(root, 'loop-b'), path.join(root, 'loop-a'))
        yield* fs.symlink(path.join(root, 'loop-a'), path.join(root, 'loop-b'))

        const failure = yield* Effect.flip(resolveProtectedPathEffect('loop-a', root))
        expect(failure.pipe(errnoCode)).toBe('ELOOP')
      })
    )
  )

  it.effect.skipIf(process.getuid?.() === 0)('propagates a permission error (EACCES) instead of treating it as missing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* makeRoot
        const locked = path.join(root, 'locked')
        yield* fs.makeDirectory(locked)
        yield* fs.writeFileString(path.join(locked, '.env'), 'SECRET=1')
        yield* fs.chmod(locked, 0o000)

        const failure = yield* Effect.flip(resolveProtectedPathEffect('locked/.env', root)).pipe(
          Effect.ensuring(Effect.orDie(fs.chmod(locked, 0o700)))
        )

        expect(failure.pipe(errnoCode)).toBe('EACCES')
      })
    )
  )

  /*
   * A stub filesystem is the only way to reach the parent === candidate branch: on a real disk the
   * root always resolves, so the walk never runs out of ancestors.
   */
  it.effect('terminates at the filesystem root when nothing resolves', () =>
    Effect.gen(function* () {
      const everythingMissing = layerNoop({
        realPath: (path: string) =>
          Effect.fail(
            systemError({
              _tag: 'NotFound',
              cause: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
              method: 'realPath',
              module: 'FileSystem',
              pathOrDescriptor: path,
            })
          ),
      })

      const resolution = yield* resolveProtectedPathEffect('.env', '/nowhere/at/all').pipe(Effect.provide(everythingMissing))

      expect(resolution.canonicalPath).toBe('/nowhere/at/all/.env')
      expect(resolution.protected).toBe(true)
    })
  )

  it.effect('returns the resolution for an unprotected path', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path
        const root = yield* makeRoot
        const resolution = yield* assertUnprotectedPathEffect('src/index.ts', root, 'read')

        expect(resolution.protected).toBe(false)
        expect(resolution.absolutePath).toBe(path.join(root, 'src', 'index.ts'))
      })
    )
  )
})
