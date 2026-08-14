import { createHash } from 'node:crypto'

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  withFileMutationQueue,
  type AgentToolResult,
  type ContextEvent,
  type Theme,
} from '@earendil-works/pi-coding-agent'
import { Text, type Component } from '@earendil-works/pi-tui'
import {
  computeFileHash,
  formatHashlineHeader,
  formatNumberedLines,
  InMemorySnapshotStore,
  NodeFilesystem,
  normalizeToLF,
  Patch,
  Patcher,
} from '@oh-my-pi/hashline'
import { Context, Data, Effect, Path } from 'effect'
import { type FileSystem } from 'effect/FileSystem'
import { Type, type Static } from 'typebox'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { PiCtx } from '@/shared/effect/pi_services.js'
import { type HandlerServices } from '@/shared/effect/runtime.js'
import { isTrue } from '@/shared/utils/predicates.js'
import { assertUnprotectedPathEffect, resolveToolPath, stripToolPathPrefix } from '@/shared/utils/protected_paths.js'
import { isRecord } from '@/shared/utils/records.js'
import { truncateOutput } from '@/shared/utils/tool_output.js'

export const readSchema = Type.Object({
  limit: Type.Optional(Type.Integer({ description: 'Maximum number of lines to return.', minimum: 1 })),
  offset: Type.Optional(Type.Integer({ description: 'First 1-indexed line to return.', minimum: 1 })),
  path: Type.String({ description: 'Path to the file to read.' }),
})

export const writeSchema = Type.Object({
  patch: Type.String({
    description:
      'A hashline patch. Start with [path#TAG], then use PUT N.=M: with +replacement rows, CUT N.=M, or PUT <N:/PUT >N: with +inserted rows. Unified-diff @@ hunks are invalid.',
  }),
})

interface ToolOutput {
  content: { text: string; type: 'text' }[]
  details: Record<string, unknown>
}
type RenderableToolOutput = AgentToolResult<Record<string, unknown>> & { isError?: boolean }

const result = (text: string, details: Record<string, unknown> = {}): ToolOutput => ({
  content: [{ text, type: 'text' as const }],
  details,
})

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (isTrue(signal?.aborted)) {
    throw new Error('Hashline operation aborted')
  }
}

/** Keep every path used internally by hashline rooted in the tool context. */
/* oxlint-disable effecttsgo/async-function -- These overrides must keep the promise-returning signatures declared by hashline's NodeFilesystem. */
class CwdFilesystem extends NodeFilesystem {
  private readonly cwd: string

  private readonly signal: AbortSignal | undefined

  constructor(cwd: string, signal: AbortSignal | undefined) {
    super()
    this.cwd = cwd
    this.signal = signal
  }

  private absolute(path: string): string {
    return resolveToolPath(path, this.cwd)
  }

  override async readText(path: string): Promise<string> {
    throwIfAborted(this.signal)
    const text = await super.readText(this.absolute(path))
    throwIfAborted(this.signal)
    return text
  }

  override async readBinary(path: string): Promise<Uint8Array> {
    throwIfAborted(this.signal)
    const bytes = await super.readBinary(this.absolute(path))
    throwIfAborted(this.signal)
    return bytes
  }

  // Mutations are checked only before they commit: aborting afterwards would report a failure for a change the file system already took.
  override async writeText(path: string, content: string) {
    throwIfAborted(this.signal)
    return super.writeText(this.absolute(path), content)
  }

  override async delete(path: string): Promise<void> {
    throwIfAborted(this.signal)
    await super.delete(this.absolute(path))
  }

  override async move(from: string, to: string, content?: string): Promise<void> {
    throwIfAborted(this.signal)
    await super.move(this.absolute(from), this.absolute(to), content)
  }

  override canonicalPath(path: string): string {
    return this.absolute(path)
  }

  override async exists(path: string): Promise<boolean> {
    throwIfAborted(this.signal)
    return super.exists(this.absolute(path))
  }

  // Tag recovery can redirect a patch to a path not listed in its headers.
  // Disabling it is necessary so policy checks and mutation locks cover every
  // File that the custom tool can affect.
  override allowTagPathRecovery(): boolean {
    return false
  }
}
/* oxlint-enable effecttsgo/async-function */

const withMutationQueues = <Result>(paths: readonly string[], callback: () => Promise<Result>): Promise<Result> => {
  const ordered = [...new Set(paths)].toSorted((left, right) => left.localeCompare(right))
  const acquire = (index: number): Promise<Result> => {
    const path = ordered[index]
    return path === undefined ? callback() : withFileMutationQueue(path, () => acquire(index + 1))
  }
  return acquire(0)
}

interface HashlineReadDetails {
  hash: string
  path: string
  startLine?: number
  endLine?: number
  version?: string
}

interface HashlineWriteSection {
  hash: string
  moveDest?: string
  op: string
  path: string
  sourcePath?: string
  version: string
}

const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex')

const readDetails = (value: unknown): HashlineReadDetails | undefined => {
  if (!isRecord(value) || typeof value.hash !== 'string' || typeof value.path !== 'string') {
    return undefined
  }
  return {
    endLine: typeof value.endLine === 'number' ? value.endLine : undefined,
    hash: value.hash,
    path: value.path,
    startLine: typeof value.startLine === 'number' ? value.startLine : undefined,
    version: typeof value.version === 'string' ? value.version : undefined,
  }
}

const writeSections = (value: unknown): HashlineWriteSection[] => {
  const sections = isRecord(value) ? value.sections : undefined
  if (!Array.isArray(sections)) {
    return []
  }
  const valid: HashlineWriteSection[] = []
  for (const section of sections) {
    if (
      !isRecord(section) ||
      typeof section.hash !== 'string' ||
      typeof section.op !== 'string' ||
      typeof section.path !== 'string' ||
      typeof section.version !== 'string'
    ) {
      continue
    }
    valid.push({
      hash: section.hash,
      moveDest: typeof section.moveDest === 'string' ? section.moveDest : undefined,
      op: section.op,
      path: section.path,
      sourcePath: typeof section.sourcePath === 'string' ? section.sourcePath : undefined,
      version: section.version,
    })
  }
  return valid
}

type ContextToolResult = Extract<ContextEvent['messages'][number], { role: 'toolResult' }>

const rememberWriteVersions = (details: unknown, latestVersionByPath: Map<string, string>): void => {
  for (const section of writeSections(details)) {
    const version = section.op === 'delete' ? `deleted:${section.version}` : section.version
    latestVersionByPath.set(section.path, latestVersionByPath.get(section.path) ?? version)
    if (section.sourcePath !== undefined && section.sourcePath !== section.path) {
      latestVersionByPath.set(section.sourcePath, latestVersionByPath.get(section.sourcePath) ?? `moved:${section.version}`)
    }
    if (section.moveDest !== undefined) {
      latestVersionByPath.set(section.moveDest, latestVersionByPath.get(section.moveDest) ?? section.version)
    }
  }
}

const pruneRead = (message: ContextToolResult, latestVersionByPath: Map<string, string>, seenRanges: Set<string>): ContextToolResult => {
  if (message.toolName !== 'hashline_read') {
    return message
  }
  const details = readDetails(message.details)
  if (details === undefined) {
    return message
  }

  const version = details.version ?? details.hash
  const latestVersion = latestVersionByPath.get(details.path)
  const rangeKey = `${details.path}\0${version}\0${details.startLine ?? '*'}\0${details.endLine ?? '*'}`
  const superseded = latestVersion !== undefined && latestVersion !== version
  const duplicate = !superseded && seenRanges.has(rangeKey)
  if (latestVersion === undefined) {
    latestVersionByPath.set(details.path, version)
  }
  if (!superseded) {
    seenRanges.add(rangeKey)
  }
  return superseded || duplicate
    ? {
        ...message,
        content: [{ text: `[Superseded hashline_read for ${details.path}; reread the file if its current contents are needed.]`, type: 'text' }],
      }
    : message
}

export const pruneSupersededReads = (messages: ContextEvent['messages']): ContextEvent['messages'] => {
  const latestVersionByPath = new Map<string, string>()
  const seenRanges = new Set<string>()
  const pruned = [...messages]

  for (let index = pruned.length - 1; index >= 0; index -= 1) {
    const message = pruned[index]
    if (message?.role !== 'toolResult' || message.isError) {
      continue
    }
    if (message.toolName === 'hashline_write') {
      rememberWriteVersions(message.details, latestVersionByPath)
      continue
    }
    pruned[index] = pruneRead(message, latestVersionByPath, seenRanges)
  }

  return pruned
}

interface ReadHashlineFileOptions {
  cwd: string
  limit: number | undefined
  offset: number | undefined
  path: string
  signal: AbortSignal | undefined
  snapshots: InMemorySnapshotStore
}

const readHashlineFile = ({
  cwd,
  limit,
  offset,
  path,
  signal,
  snapshots,
}: ReadHashlineFileOptions): Effect.Effect<ToolOutput, HashlineToolError, FileSystem | Path.Path> =>
  Effect.gen(function* () {
    yield* abortCheck(signal)
    const pathService = yield* Path.Path
    const resolution = yield* assertUnprotectedPathEffect(path, cwd, 'read').pipe(Effect.mapError(hashlineToolError))
    const fs = new CwdFilesystem(cwd, signal)
    const text = yield* Effect.tryPromise({ catch: hashlineToolError, try: () => fs.readText(resolution.absolutePath) })
    const normalized = normalizeToLF(text)
    const tag = computeFileHash(normalized)
    const version = fingerprint(normalized)
    const displayPath = pathService.relative(cwd, resolution.absolutePath) || '.'
    const lines = normalized.split('\n')
    const startLine = offset ?? 1
    if (startLine > lines.length) {
      return yield* hashlineFailure(`Offset ${startLine} exceeds file length (${lines.length} lines)`)
    }
    const requestedEndLine = Math.min(lines.length, limit === undefined ? lines.length : startLine + limit - 1)
    const requestedLines = lines.slice(startLine - 1, requestedEndLine)
    const fullOutput = `${formatHashlineHeader(displayPath, tag)}\n${formatNumberedLines(requestedLines.join('\n'), startLine)}`
    const initial = truncateOutput(fullOutput, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES })
    let output = fullOutput
    let visibleLineCount = requestedLines.length

    if (initial.truncated) {
      const bounded = truncateOutput(fullOutput, { maxBytes: DEFAULT_MAX_BYTES - 1024, maxLines: DEFAULT_MAX_LINES - 3 })
      visibleLineCount = Math.max(0, bounded.outputLines - 1)
      const nextOffset = startLine + visibleLineCount
      output = `${bounded.content}\n\n[Output truncated: showing ${visibleLineCount} of ${requestedLines.length} requested lines. Continue with offset=${nextOffset}.]`
    }
    if (visibleLineCount === 0) {
      return yield* hashlineFailure(`Line ${startLine} exceeds the hashline output limit; use another editing tool for this file`)
    }
    const seenLines = Array.from({ length: visibleLineCount }, (_value, index) => startLine + index)
    snapshots.record(resolution.absolutePath, normalized, seenLines)
    const endLine = startLine + visibleLineCount - 1
    return result(output, {
      endLine,
      hash: tag,
      path: displayPath,
      startLine,
      totalLines: lines.length,
      truncated: initial.truncated,
      version,
    })
  })

interface WriteHashlinePatchOptions {
  cwd: string
  patchText: string
  runtime: AppRuntime
  signal: AbortSignal | undefined
  snapshots: InMemorySnapshotStore
}

const writeHashlinePatch = ({
  cwd,
  patchText,
  runtime,
  signal,
  snapshots,
}: WriteHashlinePatchOptions): Effect.Effect<ToolOutput, HashlineToolError, FileSystem | Path.Path> =>
  Effect.gen(function* () {
    yield* abortCheck(signal)
    const pathService = yield* Path.Path
    const parsed = yield* Effect.try({ catch: hashlineToolError, try: () => Patch.parse(patchText, { cwd }) })
    const affectedPaths: string[] = []
    for (const section of parsed.sections) {
      affectedPaths.push(stripToolPathPrefix(section.path))
      const { fileOp } = section
      if (fileOp?.kind === 'move') {
        affectedPaths.push(stripToolPathPrefix(fileOp.dest))
      }
    }
    if (affectedPaths.length === 0) {
      return yield* hashlineFailure('Hashline patch contains no file sections')
    }

    /*
     * Resolve policy and lock keys before acquiring anything. Canonical keys
     * make aliases take the same lock; sorting prevents multi-file deadlocks.
     */
    const lockPaths: string[] = []
    for (const path of affectedPaths) {
      const checked = yield* assertUnprotectedPathEffect(path, cwd, 'write').pipe(Effect.mapError(hashlineToolError))
      lockPaths.push(checked.canonicalPath)
    }

    const applyPatch = Effect.gen(function* () {
      yield* abortCheck(signal)
      /*
       * Re-evaluate after waiting: a parent may have been replaced by a
       * symlink while this operation was queued.
       *
       * ponytail: revalidate-then-open by pathname, so an ancestor swapped between this check and
       * `patcher.apply` below is not fenced. Thread verified parent descriptors through `Patcher`
       * if a hostile local process is in scope.
       */
      for (const path of affectedPaths) {
        yield* assertUnprotectedPathEffect(path, cwd, 'write').pipe(Effect.mapError(hashlineToolError))
      }
      yield* abortCheck(signal)

      const fs = new CwdFilesystem(cwd, signal)
      const patcher = new Patcher({ fs, snapshots })
      const applied = yield* Effect.tryPromise({ catch: hashlineToolError, try: () => patcher.apply(parsed) })
      const sections = applied.sections.map((section, index) => {
        const path = pathService.relative(cwd, section.canonicalPath) || section.canonicalPath
        const parsedSection = parsed.sections[index]
        const sourceAbsolute = resolveToolPath(stripToolPathPrefix(parsedSection?.path ?? section.path), cwd)
        const sourcePath = pathService.relative(cwd, sourceAbsolute) || sourceAbsolute
        return {
          hash: section.fileHash,
          ...(section.moveDest === undefined ? {} : { moveDest: path, sourcePath }),
          op: section.op,
          path,
          version: fingerprint(normalizeToLF(section.written)),
        }
      })
      const summary = sections.map((section) => `${section.op} ${section.path} [${section.hash}]`)

      return result(summary.join('\n'), { sections })
    })

    // Pi's mutation queue is a promise API, so the revalidate-and-apply effect is run through the runtime it owns.
    return yield* Effect.tryPromise({
      catch: (cause) => (cause instanceof HashlineToolError ? cause : hashlineToolError(cause)),
      try: () => withMutationQueues(lockPaths, () => runtime.runPromise(applyPatch)),
    })
  })

class Snapshots extends Context.Service<Snapshots, InMemorySnapshotStore>()('pi-extensions/features/hashline/tools/Snapshots') {}

export class HashlineToolError extends Data.TaggedError('HashlineToolError')<{
  readonly cause: unknown
  readonly message: string
}> {}

const hashlineToolError = (cause: unknown): HashlineToolError =>
  new HashlineToolError({ cause, message: cause instanceof Error ? cause.message : String(cause) })

const hashlineFailure = (message: string): Effect.Effect<never, HashlineToolError> =>
  Effect.fail(new HashlineToolError({ cause: undefined, message }))

const abortCheck = (signal: AbortSignal | undefined): Effect.Effect<void, HashlineToolError> =>
  isTrue(signal?.aborted) ? hashlineFailure('Hashline operation aborted') : Effect.void

export const renderHashlineRead = (readResult: RenderableToolOutput, _options: unknown, theme: Theme): Component => {
  let text = typeof readResult.details?.path === 'string' ? readResult.details.path : ''
  if (isTrue(readResult.isError)) {
    const [content] = readResult.content
    text = content?.type === 'text' ? content.text : 'Hashline read failed'
  }
  return new Text(theme.fg(isTrue(readResult.isError) ? 'error' : 'toolOutput', text), 0, 0)
}

type HashlineToolEffect = Effect.Effect<ToolOutput, HashlineToolError, HandlerServices | FileSystem | Path.Path>

export interface HashlineTools {
  readonly read: (params: Static<typeof readSchema>, signal: AbortSignal | undefined) => HashlineToolEffect
  readonly write: (params: Static<typeof writeSchema>, signal: AbortSignal | undefined) => HashlineToolEffect
}

export const makeHashlineTools = (runtime: AppRuntime): HashlineTools => {
  const snapshotsStore = new InMemorySnapshotStore()
  const withSnapshots = <Success, Failure, Services>(
    effect: Effect.Effect<Success, Failure, Services | Snapshots>
  ): Effect.Effect<Success, Failure, Services> => effect.pipe(Effect.provideService(Snapshots, snapshotsStore))

  return {
    read: ({ limit, offset, path }, signal) =>
      withSnapshots(
        Effect.gen(function* () {
          const ctx = yield* PiCtx
          const snapshots = yield* Snapshots
          return yield* readHashlineFile({ cwd: ctx.cwd, limit, offset, path, signal, snapshots })
        })
      ),
    write: ({ patch }, signal) =>
      withSnapshots(
        Effect.gen(function* () {
          const ctx = yield* PiCtx
          const snapshots = yield* Snapshots
          return yield* writeHashlinePatch({ cwd: ctx.cwd, patchText: patch, runtime, signal, snapshots })
        })
      ),
  }
}
