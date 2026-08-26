import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent'
import { BunServices } from '@effect/platform-bun'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect, FileSystem, Schema } from 'effect'

import {
  boundGatewayOutput as boundGatewayOutputEffect,
  MAX_IMAGE_BLOCKS,
  MAX_IMAGE_BYTES,
  MAX_RESULT_BLOCKS,
  MAX_TOTAL_IMAGE_BYTES,
} from '@/features/mcp/output.js'

const boundGatewayOutput = (content: Parameters<typeof boundGatewayOutputEffect>[0]) =>
  Effect.runPromise(boundGatewayOutputEffect(content).pipe(Effect.provide(BunServices.layer)))

const imageBlock = (data: string) => ({ data, mimeType: 'image/png', type: 'image' as const })

describe('MCP gateway output', () => {
  it.effect('keeps small text and images unchanged', () =>
    Effect.gen(function* () {
      const content = [
        { text: 'hello', type: 'text' as const },
        { data: 'AA==', mimeType: 'image/png', type: 'image' as const },
      ]
      expect(yield* Effect.promise(() => boundGatewayOutput(content))).toEqual({
        content,
        details: { truncated: false },
      })
    })
  )

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
    }).pipe(Effect.provide(BunServices.layer))
  )

  it.effect('rejects image and block payloads beyond their count caps', () =>
    Effect.gen(function* () {
      const tooMany = Array.from({ length: MAX_IMAGE_BLOCKS + 1 }, () => imageBlock('AA=='))
      const tooManyBlocks = Array.from({ length: MAX_RESULT_BLOCKS + 1 }, () => ({ text: 'x', type: 'text' as const }))

      expect((yield* Effect.flip(boundGatewayOutputEffect(tooMany))).message).toContain(`more than ${MAX_IMAGE_BLOCKS} images`)
      expect((yield* Effect.flip(boundGatewayOutputEffect(tooManyBlocks))).message).toContain(`more than ${MAX_RESULT_BLOCKS} content blocks`)
    })
  )

  it.effect('rejects images beyond the single and aggregate byte caps', () =>
    Effect.gen(function* () {
      const oversized = [imageBlock('A'.repeat(MAX_IMAGE_BYTES + 1))]
      const share = Math.ceil(MAX_TOTAL_IMAGE_BYTES / MAX_IMAGE_BLOCKS) + 1
      const aggregate = Array.from({ length: MAX_IMAGE_BLOCKS }, () => imageBlock('A'.repeat(share)))

      expect((yield* Effect.flip(boundGatewayOutputEffect(oversized))).message).toContain(`larger than ${MAX_IMAGE_BYTES} bytes`)
      expect((yield* Effect.flip(boundGatewayOutputEffect(aggregate))).message).toContain(`more than ${MAX_TOTAL_IMAGE_BYTES} bytes of images`)
    })
  )
})
