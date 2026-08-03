import { describe, expect, test } from 'bun:test'
import { readFile, stat } from 'node:fs/promises'

import { Effect } from 'effect'

import {
  boundToolText,
  boundToolTextEffect,
  truncateOutput,
  truncationNotice,
  writePrivateTempFile,
  writePrivateTempFileEffect,
} from '@/shared/utils/tool_output.js'

const lines = (count: number) => Array.from({ length: count }, (_value, index) => `line ${index}`).join('\n')

describe('truncateOutput', () => {
  test('keeps the head or the tail depending on direction', () => {
    const text = lines(100)

    const head = truncateOutput(text, { maxBytes: 1_000_000, maxLines: 5 })
    const tail = truncateOutput(text, { from: 'tail', maxBytes: 1_000_000, maxLines: 5 })

    expect(head.truncated).toBeTrue()
    expect(head.content).toContain('line 0')
    expect(tail.content).toContain('line 99')
    expect(tail.content).not.toContain('line 0\n')
  })

  test('leaves short output untouched', () => {
    const result = truncateOutput('short', { maxBytes: 1000, maxLines: 10 })

    expect(result.truncated).toBeFalse()
    expect(result.content).toBe('short')
  })
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

  test('describes tail truncation as showing the last lines', () => {
    expect(truncationNotice(truncation, { from: 'tail' })).toContain('showing the last 1 of 20 lines')
  })

  test('mentions the spill file only when there is one', () => {
    expect(truncationNotice(truncation)).not.toContain('Full output saved to:')
    expect(truncationNotice(truncation, { fullOutputPath: '/tmp/out.txt' })).toContain('Full output saved to: /tmp/out.txt')
  })
})

describe('writePrivateTempFile', () => {
  test('writes owner-only content', async () => {
    const path = await writePrivateTempFile('secret', { prefix: 'pi-test-' })

    const stats = await stat(path)

    expect(await readFile(path, 'utf8')).toBe('secret')
    expect(stats.mode & 0o777).toBe(0o600)
  })
})

describe('boundToolText', () => {
  test('returns the original text when it fits', async () => {
    const result = await boundToolText('small', {
      maxBytes: 1000,
      maxLines: 10,
      saveFullOutput: () => Promise.reject(new Error('should not spill')),
    })

    expect(result).toMatchObject({ text: 'small', truncated: false })
    expect(result.fullOutputPath).toBeUndefined()
  })

  test('spills the complete text and keeps the notice inside the budget', async () => {
    const text = lines(500)
    let saved = ''

    const result = await boundToolText(text, {
      maxBytes: 100_000,
      maxLines: 50,
      noticeBytes: 0,
      noticeLines: 4,
      saveFullOutput: (content) => {
        saved = content
        return Promise.resolve('/tmp/full.txt')
      },
    })

    expect(saved).toBe(text)
    expect(result.truncated).toBeTrue()
    expect(result.fullOutputPath).toBe('/tmp/full.txt')
    expect(result.text).toContain('Full output saved to: /tmp/full.txt')
    expect(result.text.split('\n').length).toBeLessThanOrEqual(50)
  })
})

describe('effect wrappers', () => {
  test('writePrivateTempFileEffect still writes owner-only content', async () => {
    const path = await Effect.runPromise(writePrivateTempFileEffect('secret', { prefix: 'tool-output-effect-' }))

    const stats = await stat(path)
    expect(await readFile(path, 'utf8')).toBe('secret')
    expect(stats.mode & 0o777).toBe(0o600)
  })

  test('boundToolTextEffect matches the callback version, spill and all', async () => {
    const text = lines(500)
    const options = { maxBytes: 100_000, maxLines: 50, noticeBytes: 0, noticeLines: 4 }

    const expected = await boundToolText(text, {
      ...options,
      saveFullOutput: () => Promise.resolve('/tmp/full.txt'),
    })
    const actual = await Effect.runPromise(boundToolTextEffect(text, { ...options, saveFullOutput: () => Effect.succeed('/tmp/full.txt') }))

    expect(actual).toEqual(expected)
  })

  test('boundToolTextEffect skips the spill when the text already fits', async () => {
    let saves = 0
    const result = await Effect.runPromise(
      boundToolTextEffect('short', {
        maxBytes: 1000,
        maxLines: 10,
        saveFullOutput: () =>
          Effect.sync(() => {
            saves += 1
            return '/tmp/unused.txt'
          }),
      })
    )

    expect([result.truncated, result.text, saves]).toEqual([false, 'short', 0])
  })

  test('boundToolTextEffect propagates a failure from the spill', async () => {
    const failure = await Effect.runPromise(
      boundToolTextEffect(lines(500), {
        maxBytes: 100_000,
        maxLines: 50,
        saveFullOutput: () => Effect.fail('disk full' as const),
      }).pipe(Effect.flip)
    )

    expect(failure).toBe('disk full')
  })
})
