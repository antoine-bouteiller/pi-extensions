import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { boundToolTextEffect, writePrivateTempFileEffect } from '#shared/utils/tool_output'

import { McpError } from './types'

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

/** A remote server chooses these, so image blocks need their own ceiling: text truncation never applies to them. */
export const MAX_IMAGE_BLOCKS = 8
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_RESULT_BLOCKS = 1000

const imageBudgetError = (content: GatewayContent[]): McpError | undefined => {
  if (content.length > MAX_RESULT_BLOCKS) {
    return new McpError({ message: `MCP tool returned more than ${MAX_RESULT_BLOCKS} content blocks` })
  }
  const images = content.filter((block): block is Extract<GatewayContent, { type: 'image' }> => block.type === 'image')
  if (images.length > MAX_IMAGE_BLOCKS) {
    return new McpError({ message: `MCP tool returned more than ${MAX_IMAGE_BLOCKS} images` })
  }
  let totalBytes = 0
  for (const image of images) {
    const bytes = Buffer.byteLength(image.data, 'utf8')
    if (bytes > MAX_IMAGE_BYTES) {
      return new McpError({ message: `MCP tool returned an image larger than ${MAX_IMAGE_BYTES} bytes` })
    }
    totalBytes += bytes
  }
  return totalBytes > MAX_TOTAL_IMAGE_BYTES
    ? new McpError({ message: `MCP tool returned more than ${MAX_TOTAL_IMAGE_BYTES} bytes of images` })
    : undefined
}

/**
 * Bounds only model-visible text. Images remain native Pi image blocks, subject to their own
 * count budget, and the complete text is written to a private temporary file when truncation
 * occurs.
 */
export const boundGatewayOutput = (content: GatewayContent[]): Effect.Effect<BoundedOutput, McpError> =>
  Effect.gen(function* () {
    const overBudget = imageBudgetError(content)
    if (overBudget !== undefined) {
      return yield* overBudget
    }
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
