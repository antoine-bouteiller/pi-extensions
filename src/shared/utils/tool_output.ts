import { formatSize, truncateHead, truncateTail } from '@earendil-works/pi-coding-agent'
import { Cause, Effect } from 'effect'
import { dual } from 'effect/Function'

import { bunFileSystem, bunPath } from '@/shared/effect/bun_services.js'

const unknownError = (cause: unknown): Cause.UnknownError =>
  Cause.isUnknownError(cause) ? cause : new Cause.UnknownError(cause, cause instanceof Error ? cause.message : String(cause))

export interface Truncation {
  content: string
  truncated: boolean
  outputLines: number
  totalLines: number
  outputBytes: number
  totalBytes: number
}

type TruncateFrom = 'head' | 'tail'

export interface TruncateOptions {
  maxBytes: number
  maxLines: number
  from?: TruncateFrom
}

export const truncateOutput: {
  (options: TruncateOptions): (text: string) => Truncation
  (text: string, options: TruncateOptions): Truncation
} = dual(2, (text: string, { maxBytes, maxLines, from = 'head' }: TruncateOptions): Truncation =>
  from === 'tail' ? truncateTail(text, { maxBytes, maxLines }) : truncateHead(text, { maxBytes, maxLines })
)

export interface TruncationNoticeOptions {
  from?: TruncateFrom
  fullOutputPath?: string
}

export const truncationNotice: {
  (options?: TruncationNoticeOptions): (truncation: Truncation) => string
  (truncation: Truncation, options?: TruncationNoticeOptions): string
} = dual(
  (args) => args.length >= 1 && typeof args[0] === 'object' && args[0] !== null && 'outputLines' in args[0],
  (truncation: Truncation, { from = 'head', fullOutputPath }: TruncationNoticeOptions = {}): string => {
    const shown = from === 'tail' ? 'showing the last' : 'showing'
    const sizes = `${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}`
    const saved = fullOutputPath === undefined ? '' : ` Full output saved to: ${fullOutputPath}`
    return `\n\n[Output truncated: ${shown} ${truncation.outputLines} of ${truncation.totalLines} lines (${sizes}).${saved}]`
  }
)

export interface BoundedText {
  text: string
  truncated: boolean
  fullOutputPath?: string
  truncation: Truncation
}

/** Writes to a fresh private directory so tool output is never world-readable. */
export const writePrivateTempFileEffect: {
  (options: { prefix: string; filename?: string }): (content: string) => Effect.Effect<string, Cause.UnknownError>
  (content: string, options: { prefix: string; filename?: string }): Effect.Effect<string, Cause.UnknownError>
} = dual(
  2,
  (content: string, { prefix, filename = 'output.txt' }: { prefix: string; filename?: string }): Effect.Effect<string, Cause.UnknownError> =>
    Effect.gen(function* () {
      const directory = yield* bunFileSystem.makeTempDirectory({ prefix })
      const path = bunPath.join(directory, filename)
      yield* bunFileSystem.writeFileString(path, content, { mode: 0o600 })
      return path
    }).pipe(Effect.mapError(unknownError))
)

interface BoundToolTextEffectOptions<Failure> extends TruncateOptions {
  saveFullOutput: (content: string) => Effect.Effect<string, Failure>
  /** Room reserved for the notice so the final text still fits the caller's budget. */
  noticeBytes?: number
  noticeLines?: number
}

/**
 * Truncates model-visible text and spills the complete text to a file, re-truncating
 * against a smaller budget so that appending the notice cannot push the result back
 * over the caller's limits. A failed spill stays in the error channel.
 */

export const boundToolTextEffect: {
  <Failure = never>(options: BoundToolTextEffectOptions<Failure>): (text: string) => Effect.Effect<BoundedText, Failure>
  <Failure = never>(text: string, options: BoundToolTextEffectOptions<Failure>): Effect.Effect<BoundedText, Failure>
} = dual(
  2,
  <Failure = never>(
    text: string,
    { maxBytes, maxLines, from = 'head', saveFullOutput, noticeBytes = 2048, noticeLines = 4 }: BoundToolTextEffectOptions<Failure>
  ): Effect.Effect<BoundedText, Failure> =>
    Effect.gen(function* () {
      const initial = truncateOutput(text, { from, maxBytes, maxLines })
      if (!initial.truncated) {
        return { text, truncated: false, truncation: initial }
      }

      const fullOutputPath = yield* saveFullOutput(text)
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
    })
)
