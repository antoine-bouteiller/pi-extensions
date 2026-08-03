import { relative } from 'node:path'

import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { formatHashlineHeader, formatNumberedLines, InMemorySnapshotStore, NodeFilesystem, normalizeToLF, Patch, Patcher } from '@oh-my-pi/hashline'
import { Context, Effect } from 'effect'
import { Type, type Static } from 'typebox'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { PiCtx } from '@/shared/effect/pi_services.js'
import { perInvocation, type HandlerServices } from '@/shared/effect/runtime.js'
import { assertUnprotectedPath, resolveToolPath, stripToolPathPrefix } from '@/shared/utils/protected_paths.js'

const readSchema = Type.Object({
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

const readHashlineFile = async (
  path: string,
  cwd: string,
  signal: AbortSignal | undefined,
  snapshots: InMemorySnapshotStore
): Promise<ToolOutput> => {
  throwIfAborted(signal)
  const resolution = await assertUnprotectedPath(path, cwd, 'read')
  const fs = new CwdFilesystem(cwd, signal)
  const text = await fs.readText(resolution.absolutePath)
  const normalized = normalizeToLF(text)
  const tag = snapshots.record(resolution.absolutePath, normalized)
  const displayPath = relative(cwd, resolution.absolutePath) || '.'

  return result(`${formatHashlineHeader(displayPath, tag)}\n${formatNumberedLines(normalized)}`, { hash: tag, path: displayPath })
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
    const summary = applied.sections.map((section) => {
      const target = relative(cwd, section.canonicalPath) || section.canonicalPath
      return `${section.op} ${target} [${section.fileHash}]`
    })

    return result(summary.join('\n'), { sections: applied.sections })
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
      'Read a file with stable line anchors and a content hash for hashline_write. Use this instead of read before editing a file with hashline. Protected credential paths are refused by this tool itself.',
    execute: runTool<Static<typeof readSchema>, ToolOutput>(({ path }, signal) =>
      Effect.gen(function* () {
        const ctx = yield* PiCtx
        const snapshots = yield* Snapshots
        return yield* Effect.tryPromise({
          catch: (cause) => cause,
          try: () => readHashlineFile(path, ctx.cwd, signal, snapshots),
        })
      })
    ),
    label: 'Hashline Read',
    name: 'hashline_read',
    parameters: readSchema,
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
}
