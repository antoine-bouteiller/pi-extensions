import { tmpdir } from 'node:os'

import { formatSize, truncateHead, truncateTail } from '@earendil-works/pi-coding-agent'
import { type Cause, Effect, Option } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { Path } from 'effect/Path'

import { unknownError } from '#shared/effect/errors'

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

export const truncateOutput = (text: string, { maxBytes, maxLines, from = 'head' }: TruncateOptions): Truncation =>
  from === 'tail' ? truncateTail(text, { maxBytes, maxLines }) : truncateHead(text, { maxBytes, maxLines })

export interface TruncationNoticeOptions {
  from?: TruncateFrom
  fullOutputPath?: string
}

export const truncationNotice = (truncation: Truncation, { from = 'head', fullOutputPath }: TruncationNoticeOptions = {}): string => {
  const shown = from === 'tail' ? 'showing the last' : 'showing'
  const sizes = `${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}`
  const saved = fullOutputPath === undefined ? '' : ` Full output saved to: ${fullOutputPath}`
  return `\n\n[Output truncated: ${shown} ${truncation.outputLines} of ${truncation.totalLines} lines (${sizes}).${saved}]`
}

export interface BoundedText {
  text: string
  truncated: boolean
  fullOutputPath?: string
  truncation: Truncation
}

export const SPILL_TTL_MS = 24 * 60 * 60 * 1000

/**
 * A spill deliberately outlives the call that wrote it, because the truncation notice tells the
 * model to read the path on a later turn. Nothing else ever deletes them, so each new spill reaps
 * its own expired siblings; without this, repeated truncated output grows in tmp without bound.
 *
 * ponytail: age-based sweep keyed on the caller's prefix; replace with session-scoped cleanup if a
 * spill ever needs to outlive its session or be removed the moment the session ends.
 */
const reapExpiredSpills = (prefix: string): Effect.Effect<void, never, FileSystem | Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const path = yield* Path
    const root = tmpdir()
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    const entries = yield* fs.readDirectory(root)
    yield* Effect.forEach(
      entries.filter((entry) => entry.startsWith(prefix)),
      (entry) => {
        const entryPath = path.join(root, entry)
        return fs.stat(entryPath).pipe(
          Effect.flatMap((info) => {
            const modified = Option.getOrUndefined(info.mtime)
            return modified !== undefined && now - modified.getTime() > SPILL_TTL_MS
              ? fs.remove(entryPath, { force: true, recursive: true })
              : Effect.void
          }),
          Effect.ignore
        )
      },
      { concurrency: 8, discard: true }
    )
  }).pipe(Effect.ignore)

/** Writes to a fresh private directory so tool output is never world-readable. */
export const writePrivateTempFileEffect = (
  content: string,
  { prefix, filename = 'output.txt' }: { prefix: string; filename?: string }
): Effect.Effect<string, Cause.UnknownError, FileSystem | Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const path = yield* Path
    yield* reapExpiredSpills(prefix)
    const directory = yield* fs.makeTempDirectory({ prefix })
    const filePath = path.join(directory, filename)
    yield* fs
      .writeFileString(filePath, content, { mode: 0o600 })
      .pipe(Effect.onError(() => fs.remove(directory, { force: true, recursive: true }).pipe(Effect.ignore)))
    return filePath
  }).pipe(Effect.mapError(unknownError))

interface BoundToolTextEffectOptions<Failure, Requirements> extends TruncateOptions {
  saveFullOutput: (content: string) => Effect.Effect<string, Failure, Requirements>
  /** Room reserved for the notice so the final text still fits the caller's budget. */
  noticeBytes?: number
  noticeLines?: number
}

/**
 * Truncates model-visible text and spills the complete text to a file, re-truncating
 * against a smaller budget so that appending the notice cannot push the result back
 * over the caller's limits. The reserve grows to the notice's measured size, so a long
 * spill path cannot overrun the budget; only a budget smaller than the notice itself
 * still overruns, because the notice is what tells the model where the rest went.
 * A failed spill stays in the error channel.
 */

export const boundToolTextEffect = <Failure = never, Requirements = never>(
  text: string,
  { maxBytes, maxLines, from = 'head', saveFullOutput, noticeBytes = 2048, noticeLines = 4 }: BoundToolTextEffectOptions<Failure, Requirements>
): Effect.Effect<BoundedText, Failure, Requirements> =>
  Effect.gen(function* () {
    const initial = truncateOutput(text, { from, maxBytes, maxLines })
    if (!initial.truncated) {
      return { text, truncated: false, truncation: initial }
    }

    const fullOutputPath = yield* saveFullOutput(text)
    const notice = truncationNotice(initial, { from, fullOutputPath })
    const truncation = truncateOutput(text, {
      from,
      maxBytes: Math.max(0, maxBytes - Math.max(noticeBytes, new TextEncoder().encode(notice).length)),
      maxLines: Math.max(1, maxLines - Math.max(noticeLines, notice.split('\n').length)),
    })
    return {
      fullOutputPath,
      text: truncation.content + truncationNotice(truncation, { from, fullOutputPath }),
      truncated: true,
      truncation,
    }
  })
