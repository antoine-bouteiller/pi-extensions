import { describe, expect, test } from 'bun:test'
import { stat } from 'node:fs/promises'

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent'

import { boundGatewayOutput } from '@/features/mcp/output.js'

describe('MCP gateway output', () => {
  test('keeps small text and images unchanged', async () => {
    const content = [
      { text: 'hello', type: 'text' as const },
      { data: 'AA==', mimeType: 'image/png', type: 'image' as const },
    ]
    expect(await boundGatewayOutput(content)).toEqual({
      content,
      details: { truncated: false },
    })
  })

  test('spills complete oversized text with mode 0600 without copying it into details', async () => {
    const marker = 'private-tail-marker'
    const text = `${'x'.repeat(60 * 1024)}${marker}`
    const image = { data: 'AA==', mimeType: 'image/png', type: 'image' as const }
    const result = await boundGatewayOutput([{ text, type: 'text' }, image])

    expect(result.details.truncated).toBeTrue()
    expect(result.content).toContainEqual(image)
    const [firstBlock] = result.content
    expect(firstBlock?.type).toBe('text')
    if (firstBlock?.type !== 'text') {
      throw new Error('expected text content')
    }
    const visibleText = firstBlock.text
    expect(visibleText).not.toContain(marker)
    expect(Buffer.byteLength(visibleText, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
    expect(visibleText.split('\n').length).toBeLessThanOrEqual(DEFAULT_MAX_LINES)
    expect(JSON.stringify(result.details)).not.toContain(marker)

    const path = result.details.fullOutputPath
    if (path === undefined) {
      throw new Error('Expected a full output path')
    }
    expect(await Bun.file(path).text()).toBe(text)
    const stats = await stat(path)
    expect(stats.mode & 0o777).toBe(0o600)
  })
})
