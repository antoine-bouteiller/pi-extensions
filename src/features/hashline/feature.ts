import { createHash } from 'node:crypto'
import { relative } from 'node:path'

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  withFileMutationQueue,
  type AgentToolResult,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
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
import { Context, Effect } from 'effect'
import { Type, type Static } from 'typebox'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { PiCtx } from '@/shared/effect/pi_services.js'
import { perInvocation, type HandlerServices } from '@/shared/effect/runtime.js'
import { assertUnprotectedPath, resolveToolPath, stripToolPathPrefix } from '@/shared/utils/protected_paths.js'
import { isRecord } from '@/shared/utils/records.js'
import { truncateOutput } from '@/shared/utils/tool_output.js'

const readSchema = Type.Object({
  limit: Type.Optional(Type.Integer({ description: 'Maximum number of lines to return.', minimum: 1 })),
  offset: Type.Optional(Type.Integer({ description: 'First 1-indexed line to return.', minimum: 1 })),
  path: Type.String({ description: 'Path to the file to read.' }),
})

const writeSchema = Type.Object({
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
  if (signal?.aborted) {
    throw new Error('Hashline operation aborted')
  }
}

/** Keep every path used internally by hashline rooted in the tool context. */
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

  override async writeText(path: string, content: string) {
    throwIfAborted(this.signal)
    const written = await super.writeText(this.absolute(path), content)
    throwIfAborted(this.signal)
    return written
  }

  override async delete(path: string): Promise<void> {
    throwIfAborted(this.signal)
    await super.delete(this.absolute(path))
    throwIfAborted(this.signal)
  }

  override async move(from: string, to: string, content?: string): Promise<void> {
    throwIfAborted(this.signal)
    await super.move(this.absolute(from), this.absolute(to), content)
    throwIfAborted(this.signal)
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

const withMutationQueues = async <Result>(paths: readonly string[], callback: () => Promise<Result>): Promise<Result> => {
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
  if (!details) {
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

const pruneSupersededReads = (messages: ContextEvent['messages']): ContextEvent['messages'] => {
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

const readHashlineFile = async ({ cwd, limit, offset, path, signal, snapshots }: ReadHashlineFileOptions): Promise<ToolOutput> => {
  throwIfAborted(signal)
  const resolution = await assertUnprotectedPath(path, cwd, 'read')
  const fs = new CwdFilesystem(cwd, signal)
  const text = await fs.readText(resolution.absolutePath)
  const normalized = normalizeToLF(text)
  const tag = computeFileHash(normalized)
  const version = fingerprint(normalized)
  const displayPath = relative(cwd, resolution.absolutePath) || '.'
  const lines = normalized.split('\n')
  const startLine = offset ?? 1
  if (startLine > lines.length) {
    throw new Error(`Offset ${startLine} exceeds file length (${lines.length} lines)`)
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
    throw new Error(`Line ${startLine} exceeds the hashline output limit; use another editing tool for this file`)
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
}

const writeHashlinePatch = async (
  patchText: string,
  cwd: string,
  signal: AbortSignal | undefined,
  snapshots: InMemorySnapshotStore
): Promise<ToolOutput> => {
  throwIfAborted(signal)
  const parsed = Patch.parse(patchText, { cwd })
  const affectedPaths: string[] = []
  for (const section of parsed.sections) {
    affectedPaths.push(stripToolPathPrefix(section.path))
    const { fileOp } = section
    if (fileOp?.kind === 'move') {
      affectedPaths.push(stripToolPathPrefix(fileOp.dest))
    }
  }
  if (affectedPaths.length === 0) {
    throw new Error('Hashline patch contains no file sections')
  }

  /*
   * Resolve policy and lock keys before acquiring anything. Canonical keys
   * make aliases take the same lock; sorting prevents multi-file deadlocks.
   */
  const lockPaths: string[] = []
  for (const path of affectedPaths) {
    const checked = await assertUnprotectedPath(path, cwd, 'write')
    lockPaths.push(checked.canonicalPath)
  }

  return withMutationQueues(lockPaths, async () => {
    throwIfAborted(signal)
    /*
     * Re-evaluate after waiting: a parent may have been replaced by a
     * symlink while this operation was queued.
     */
    for (const path of affectedPaths) {
      await assertUnprotectedPath(path, cwd, 'write')
    }
    throwIfAborted(signal)

    const fs = new CwdFilesystem(cwd, signal)
    const patcher = new Patcher({ fs, snapshots })
    const applied = await patcher.apply(parsed)
    throwIfAborted(signal)
    const sections = applied.sections.map((section, index) => {
      const path = relative(cwd, section.canonicalPath) || section.canonicalPath
      const parsedSection = parsed.sections[index]
      const sourceAbsolute = resolveToolPath(stripToolPathPrefix(parsedSection?.path ?? section.path), cwd)
      const sourcePath = relative(cwd, sourceAbsolute) || sourceAbsolute
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
}

class Snapshots extends Context.Service<Snapshots, InMemorySnapshotStore>()('@hashline/Snapshots') {}

export const register = (pi: ExtensionAPI, runtime: AppRuntime): void => {
  const snapshotsStore = new InMemorySnapshotStore()

  /*
   * Phase 1's makeToolExecutor doesn't hand the raw AbortSignal to the body, but hashline needs it
   * for CwdFilesystem and the post-lock TOCTOU re-check, so this provides services locally instead.
   *
   * `{ signal }` is deliberately not passed to runPromise: that makes Effect interrupt the fiber the
   * instant the signal fires, discarding the in-flight mutation-queue wait and replacing the
   * cooperative `throwIfAborted` message below with Effect's generic interrupted-fiber one.
   * Cancellation stays cooperative, as it was before this port.
   */
  const runTool =
    <Params, Result>(body: (params: Params, signal: AbortSignal | undefined) => Effect.Effect<Result, unknown, HandlerServices | Snapshots>) =>
    async (_toolCallId: string, params: Params, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<Result> =>
      runtime.runPromise(body(params, signal).pipe(Effect.provideService(Snapshots, snapshotsStore), Effect.provide(perInvocation(ctx))))

  pi.registerTool({
    description:
      'Read a file with stable line anchors and a content hash for hashline_write. Output is bounded; use offset and limit for large files. Protected credential paths are refused by this tool itself.',
    execute: runTool<Static<typeof readSchema>, ToolOutput>(({ limit, offset, path }, signal) =>
      Effect.gen(function* () {
        const ctx = yield* PiCtx
        const snapshots = yield* Snapshots
        return yield* Effect.tryPromise({
          catch: (cause) => cause,
          try: () => readHashlineFile({ cwd: ctx.cwd, limit, offset, path, signal, snapshots }),
        })
      })
    ),
    label: 'Hashline Read',
    name: 'hashline_read',
    parameters: readSchema,
    renderResult(readResult: RenderableToolOutput, _options, theme) {
      let text = typeof readResult.details?.path === 'string' ? readResult.details.path : ''
      if (readResult.isError) {
        const [content] = readResult.content
        text = content?.type === 'text' ? content.text : 'Hashline read failed'
      }
      return new Text(theme.fg(readResult.isError ? 'error' : 'toolOutput', text), 0, 0)
    },
  })

  pi.registerTool({
    description:
      'Apply a hashline patch produced from hashline_read. Use hashline operations (PUT, CUT, MV, or REM), not unified-diff @@ hunks. Patches are content-hash anchored, reject stale edits, and refuse protected credential paths.',
    execute: runTool<Static<typeof writeSchema>, ToolOutput>(({ patch }, signal) =>
      Effect.gen(function* () {
        const ctx = yield* PiCtx
        const snapshots = yield* Snapshots
        return yield* Effect.tryPromise({
          catch: (cause) => cause,
          try: () => writeHashlinePatch(patch, ctx.cwd, signal, snapshots),
        })
      })
    ),
    label: 'Hashline Write',
    name: 'hashline_write',
    parameters: writeSchema,
    promptGuidelines: [
      'Use hashline_read before hashline_write so every section has a current [path#TAG] anchor.',
      'In hashline_write, replace lines with `PUT N.=M:` followed by `+` body rows; never use unified-diff `@@` headers.',
      'Use hashline_write for targeted edits; use the built-in write tool when creating a new file from scratch.',
    ],
  })

  pi.on('context', (event) => ({ messages: pruneSupersededReads(event.messages) }))
}
