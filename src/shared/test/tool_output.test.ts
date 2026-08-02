import { describe, expect, test } from 'bun:test'
import { readFile, stat } from 'node:fs/promises'

import { boundToolText, truncateOutput, truncationNotice, writePrivateTempFile } from '../tool_output'

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
