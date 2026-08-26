import { tmpdir } from 'node:os'

import { BunFileSystem, BunPath } from '@effect/platform-bun'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asNarrowed } from '@tests/utils/casts.js'
import { DateTime, Effect, FileSystem, Layer, Random } from 'effect'

import { dirname, join } from '#shared/utils/path'
import { boundToolTextEffect, SPILL_TTL_MS, truncateOutput, truncationNotice, writePrivateTempFileEffect } from '@/shared/utils/tool_output.js'

const lines = (count: number) => Array.from({ length: count }, (_value, index) => `line ${index}`).join('\n')

describe('truncateOutput', () => {
  it.effect('keeps the head or the tail depending on direction', () =>
    Effect.sync(() => {
      const text = lines(100)

      const head = truncateOutput(text, { maxBytes: 1_000_000, maxLines: 5 })
      const tail = truncateOutput(text, { from: 'tail', maxBytes: 1_000_000, maxLines: 5 })

      expect(head.truncated).toBeTrue()
      expect(head.content).toContain('line 0')
      expect(tail.content).toContain('line 99')
      expect(tail.content).not.toContain('line 0\n')
    })
  )

  it.effect('leaves short output untouched', () =>
    Effect.sync(() => {
      const result = truncateOutput('short', { maxBytes: 1000, maxLines: 10 })

      expect(result.truncated).toBeFalse()
      expect(result.content).toBe('short')
    })
  )
})

describe('truncationNotice', () => {
  const truncation = {
    content: '',
    outputBytes: 10,
    outputLines: 1,
    totalBytes: 100,
    totalLines: 20,
    truncated: true,
  }

  it.effect('describes tail truncation as showing the last lines', () =>
    Effect.sync(() => {
      expect(truncationNotice(truncation, { from: 'tail' })).toContain('showing the last 1 of 20 lines')
    })
  )

  it.effect('mentions the spill file only when there is one', () =>
    Effect.sync(() => {
      expect(truncationNotice(truncation)).not.toContain('Full output saved to:')
      expect(truncationNotice(truncation, { fullOutputPath: '/tmp/out.txt' })).toContain('Full output saved to: /tmp/out.txt')
    })
  )
})

describe('bounded tool output', () => {
  it.effect('writePrivateTempFileEffect writes owner-only content', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* writePrivateTempFileEffect('secret', { prefix: 'tool-output-effect-' })

      expect(yield* fs.readFileString(path)).toBe('secret')
      expect((yield* fs.stat(dirname(path))).mode & 0o777).toBe(0o700)
      expect((yield* fs.stat(path)).mode & 0o777).toBe(0o600)
    }).pipe(Effect.provide(BunFileSystem.layer))
  )

  it.effect('writePrivateTempFileEffect uses an injected FileSystem', () =>
    Effect.gen(function* () {
      const suffix = yield* Random.nextInt
      const fakeDirectory = join(tmpdir(), `tool-output-injected-${process.pid}-${suffix}`)
      const makeTempDirectoryCalls: { readonly prefix?: string }[] = []
      const writeFileStringCalls: {
        readonly content: string
        readonly options?: { readonly mode?: number }
        readonly path: string
      }[] = []
      // The narrowed minimal stub omits every unneeded member, which fails loudly if the code path expands.
      const fileSystem = asNarrowed<FileSystem.FileSystem, object>({
        makeTempDirectory: (options?: { readonly prefix?: string }) =>
          Effect.sync(() => {
            makeTempDirectoryCalls.push(options ?? {})
            return fakeDirectory
          }),
        readDirectory: () => Effect.succeed([]),
        writeFileString: (path: string, content: string, options?: { readonly mode?: number }) =>
          Effect.sync(() => {
            writeFileStringCalls.push({ content, options, path })
          }),
      })

      const path = yield* writePrivateTempFileEffect('secret', { prefix: 'tool-output-injected-' }).pipe(
        Effect.provide(Layer.merge(Layer.succeed(FileSystem.FileSystem)(fileSystem), BunPath.layer))
      )

      expect(makeTempDirectoryCalls).toEqual([{ prefix: 'tool-output-injected-' }])
      expect(writeFileStringCalls).toEqual([{ content: 'secret', options: { mode: 0o600 }, path }])
      expect(yield* Effect.promise(() => Bun.file(path).exists())).toBeFalse()
    })
  )

  it.effect('writePrivateTempFileEffect leaves no directory behind when the write fails', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const before = yield* fs.readDirectory(dirname(yield* fs.makeTempDirectory({ prefix: 'tool-output-probe-' })))

      yield* Effect.flip(writePrivateTempFileEffect('secret', { filename: 'missing/output.txt', prefix: 'tool-output-failure-' }))

      const after = yield* fs.readDirectory(dirname(yield* fs.makeTempDirectory({ prefix: 'tool-output-probe-' })))
      expect(after.filter((entry) => entry.startsWith('tool-output-failure-'))).toEqual([])
      expect(before.filter((entry) => entry.startsWith('tool-output-failure-'))).toEqual([])
    }).pipe(Effect.provide(BunFileSystem.layer))
  )

  it.effect('boundToolTextEffect spills the complete text and keeps the notice inside the budget', () =>
    Effect.gen(function* () {
      const text = lines(500)
      let saved = ''

      const result = yield* boundToolTextEffect(text, {
        maxBytes: 100_000,
        maxLines: 50,
        noticeBytes: 0,
        noticeLines: 4,
        saveFullOutput: (content) =>
          Effect.sync(() => {
            saved = content
            return '/tmp/full.txt'
          }),
      })

      expect(saved).toBe(text)
      expect(result.truncated).toBeTrue()
      expect(result.fullOutputPath).toBe('/tmp/full.txt')
      expect(result.text).toContain('Full output saved to: /tmp/full.txt')
      expect(result.text.split('\n').length).toBeLessThanOrEqual(50)
    })
  )

  it.effect('boundToolTextEffect skips the spill when the text already fits', () =>
    Effect.gen(function* () {
      let saves = 0
      const result = yield* boundToolTextEffect('short', {
        maxBytes: 1000,
        maxLines: 10,
        saveFullOutput: () =>
          Effect.sync(() => {
            saves += 1
            return '/tmp/unused.txt'
          }),
      })

      expect([result.truncated, result.text, saves]).toEqual([false, 'short', 0])
    })
  )

  it.effect('boundToolTextEffect propagates a failure from the spill', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        boundToolTextEffect(lines(500), {
          maxBytes: 100_000,
          maxLines: 50,
          saveFullOutput: () => Effect.fail('disk full' as const),
        })
      )

      expect(failure).toBe('disk full')
    })
  )

  it.effect('reaps expired spill directories but keeps recent ones', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const prefix = `tool-output-reap-${process.pid}-`

      const stale = yield* writePrivateTempFileEffect('stale', { prefix })
      const staleDirectory = dirname(stale)
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      // `utimes` reads a bare number as nanoseconds, so the age is applied as a Date.
      const expired = DateTime.toDateUtc(DateTime.makeUnsafe(now - SPILL_TTL_MS - 60_000))
      yield* fs.utimes(staleDirectory, expired, expired)

      const fresh = yield* writePrivateTempFileEffect('fresh', { prefix })
      const freshDirectory = dirname(fresh)

      expect(yield* fs.exists(staleDirectory)).toBeFalse()
      expect(yield* fs.exists(freshDirectory)).toBeTrue()

      yield* fs.remove(freshDirectory, { force: true, recursive: true })
    }).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)))
  )
})
