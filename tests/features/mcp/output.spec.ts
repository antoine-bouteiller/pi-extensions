import { test } from 'bun:test'

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent'
import { NodeFileSystem } from '@effect/platform-node'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect, FileSystem, Schema } from 'effect'

import { boundGatewayOutput as boundGatewayOutputEffect } from '@/features/mcp/output.js'

const boundGatewayOutput = (content: Parameters<typeof boundGatewayOutputEffect>[0]) => Effect.runPromise(boundGatewayOutputEffect(content))

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

  it.effect('spills complete oversized text with mode 0600 without copying it into details', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const marker = 'private-tail-marker'
      const text = `${'x'.repeat(60 * 1024)}${marker}`
      const image = { data: 'AA==', mimeType: 'image/png', type: 'image' as const }
      const result = yield* boundGatewayOutputEffect([{ text, type: 'text' }, image])

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
      const detailsJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result.details)
      expect(detailsJson).not.toContain(marker)

      const path = result.details.fullOutputPath
      if (path === undefined) {
        throw new Error('Expected a full output path')
      }
      expect(yield* fs.readFileString(path)).toBe(text)
      expect((yield* fs.stat(path)).mode & 0o777).toBe(0o600)
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )
})
