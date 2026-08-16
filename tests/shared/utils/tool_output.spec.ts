import { NodeFileSystem } from '@effect/platform-node'
import { DateTime, Effect, FileSystem } from 'effect'

import { nodeFileSystem, nodePath } from '#shared/effect/node_services'
import { boundToolTextEffect, SPILL_TTL_MS, truncateOutput, truncationNotice, writePrivateTempFileEffect } from '#shared/utils/tool_output'
import { describe, expect, it } from '#tests/utils/effect'

const lines = (count: number) => Array.from({ length: count }, (_value, index) => `line ${index}`).join('\n')

describe('truncateOutput', () => {
  it.effect('keeps the head or the tail depending on direction', () =>
    Effect.sync(() => {
      const text = lines(100)

      const head = truncateOutput(text, { maxBytes: 1_000_000, maxLines: 5 })
      const tail = truncateOutput(text, { from: 'tail', maxBytes: 1_000_000, maxLines: 5 })

      expect(head.truncated).toBe(true)
      expect(head.content).toContain('line 0')
      expect(tail.content).toContain('line 99')
      expect(tail.content).not.toContain('line 0\n')
    })
  )

  it.effect('leaves short output untouched', () =>
    Effect.sync(() => {
      const result = truncateOutput('short', { maxBytes: 1000, maxLines: 10 })

      expect(result.truncated).toBe(false)
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
      expect((yield* fs.stat(nodePath.dirname(path))).mode & 0o777).toBe(0o700)
      expect((yield* fs.stat(path)).mode & 0o777).toBe(0o600)
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )

  it.effect('writePrivateTempFileEffect leaves no directory behind when the write fails', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const before = yield* fs.readDirectory(nodePath.dirname(yield* fs.makeTempDirectory({ prefix: 'tool-output-probe-' })))

      yield* Effect.flip(writePrivateTempFileEffect('secret', { filename: 'missing/output.txt', prefix: 'tool-output-failure-' }))

      const after = yield* fs.readDirectory(nodePath.dirname(yield* fs.makeTempDirectory({ prefix: 'tool-output-probe-' })))
      expect(after.filter((entry) => entry.startsWith('tool-output-failure-'))).toEqual([])
      expect(before.filter((entry) => entry.startsWith('tool-output-failure-'))).toEqual([])
    }).pipe(Effect.provide(NodeFileSystem.layer))
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
      expect(result.truncated).toBe(true)
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

  it.live('reaps expired spill directories but keeps recent ones', () =>
    Effect.gen(function* () {
      const prefix = `tool-output-reap-${process.pid}-`

      const stale = yield* writePrivateTempFileEffect('stale', { prefix })
      const staleDirectory = nodePath.dirname(stale)
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      // `utimes` reads a bare number as nanoseconds, so the age is applied as a Date.
      const expired = DateTime.toDateUtc(DateTime.makeUnsafe(now - SPILL_TTL_MS - 60_000))
      yield* nodeFileSystem.utimes(staleDirectory, expired, expired)

      const fresh = yield* writePrivateTempFileEffect('fresh', { prefix })
      const freshDirectory = nodePath.dirname(fresh)

      expect(yield* nodeFileSystem.exists(staleDirectory)).toBe(false)
      expect(yield* nodeFileSystem.exists(freshDirectory)).toBe(true)

      yield* nodeFileSystem.remove(freshDirectory, { force: true, recursive: true })
    })
  )
})
