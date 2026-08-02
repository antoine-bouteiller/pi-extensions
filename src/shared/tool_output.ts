import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatSize, truncateHead, truncateTail } from '@earendil-works/pi-coding-agent'

export interface Truncation {
  content: string
  truncated: boolean
  outputLines: number
  totalLines: number
  outputBytes: number
  totalBytes: number
}

export type TruncateFrom = 'head' | 'tail'

export interface TruncateOptions {
  maxBytes: number
  maxLines: number
  from?: TruncateFrom
}

export const truncateOutput = (text: string, { maxBytes, maxLines, from = 'head' }: TruncateOptions): Truncation =>
  from === 'tail' ? truncateTail(text, { maxBytes, maxLines }) : truncateHead(text, { maxBytes, maxLines })

export interface TruncationNoticeOptions {
  from?: TruncateFrom
  fullOutputPath?: string
}

export const truncationNotice = (truncation: Truncation, { from = 'head', fullOutputPath }: TruncationNoticeOptions = {}): string => {
  const shown = from === 'tail' ? 'showing the last' : 'showing'
  const sizes = `${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}`
  const saved = fullOutputPath ? ` Full output saved to: ${fullOutputPath}` : ''
  return `\n\n[Output truncated: ${shown} ${truncation.outputLines} of ${truncation.totalLines} lines (${sizes}).${saved}]`
}

/** Writes to a fresh private directory so tool output is never world-readable. */
export const writePrivateTempFile = async (
  content: string,
  { prefix, filename = 'output.txt' }: { prefix: string; filename?: string }
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  const path = join(directory, filename)
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 })
  return path
}

export interface BoundedText {
  text: string
  truncated: boolean
  fullOutputPath?: string
  truncation: Truncation
}

export interface BoundToolTextOptions extends TruncateOptions {
  saveFullOutput: (content: string) => Promise<string>
  /** Room reserved for the notice so the final text still fits the caller's budget. */
  noticeBytes?: number
  noticeLines?: number
}

/**
 * Truncates model-visible text and spills the complete text to a file, re-truncating
 * against a smaller budget so that appending the notice cannot push the result back
 * over the caller's limits.
 */
export const boundToolText = async (
  text: string,
  { maxBytes, maxLines, from = 'head', saveFullOutput, noticeBytes = 2048, noticeLines = 4 }: BoundToolTextOptions
): Promise<BoundedText> => {
  const initial = truncateOutput(text, { from, maxBytes, maxLines })
  if (!initial.truncated) {
    return { text, truncated: false, truncation: initial }
  }

  const fullOutputPath = await saveFullOutput(text)
  const truncation = truncateOutput(text, {
    from,
    maxBytes: maxBytes - noticeBytes,
    maxLines: maxLines - noticeLines,
  })
  return {
    fullOutputPath,
    text: truncation.content + truncationNotice(truncation, { from, fullOutputPath }),
    truncated: true,
    truncation,
  }
}
