import { BunFileSystem } from '@effect/platform-bun'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect, FileSystem } from 'effect'

import { bunPath } from '@/shared/effect/bun_services.js'
import { boundToolTextEffect, truncateOutput, truncationNotice, writePrivateTempFileEffect } from '@/shared/utils/tool_output.js'

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
      expect((yield* fs.stat(bunPath.dirname(path))).mode & 0o777).toBe(0o700)
      expect((yield* fs.stat(path)).mode & 0o777).toBe(0o600)
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
})
