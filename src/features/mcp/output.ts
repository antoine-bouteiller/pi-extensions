import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { boundToolTextEffect, writePrivateTempFileEffect } from '@/shared/utils/tool_output.js'

import { McpError } from './types.js'

export type GatewayContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

interface BoundedOutputDetails {
  truncated: boolean
  fullOutputPath?: string
  outputLines?: number
  totalLines?: number
  outputBytes?: number
  totalBytes?: number
}

export interface BoundedOutput {
  content: GatewayContent[]
  details: BoundedOutputDetails
}

/**
 * Bounds only model-visible text. Images remain native Pi image blocks and the
 * complete text is written to a private temporary file when truncation occurs.
 */
export const boundGatewayOutput = (content: GatewayContent[]): Effect.Effect<BoundedOutput, McpError> =>
  Effect.gen(function* () {
    const textBlocks = content.filter((block): block is Extract<GatewayContent, { type: 'text' }> => block.type === 'text')
    const completeText = textBlocks.map((block) => block.text).join('\n')
    const bounded = yield* boundToolTextEffect(completeText, {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
      saveFullOutput: (text) =>
        writePrivateTempFileEffect(text, { prefix: 'pi-mcp-' }).pipe(Effect.mapError((cause) => new McpError({ cause, message: cause.message }))),
    })

    if (!bounded.truncated) {
      return { content, details: { truncated: false } }
    }

    if (Buffer.byteLength(bounded.text, 'utf8') > DEFAULT_MAX_BYTES || bounded.text.split('\n').length > DEFAULT_MAX_LINES) {
      return yield* new McpError({ message: 'Could not safely bound MCP tool output' })
    }
    const images = content.filter((block): block is Extract<GatewayContent, { type: 'image' }> => block.type === 'image')

    return {
      content: [{ text: bounded.text, type: 'text' as const }, ...images],
      details: {
        fullOutputPath: bounded.fullOutputPath,
        outputBytes: bounded.truncation.outputBytes,
        outputLines: bounded.truncation.outputLines,
        totalBytes: bounded.truncation.totalBytes,
        totalLines: bounded.truncation.totalLines,
        truncated: true,
      },
    }
  })
