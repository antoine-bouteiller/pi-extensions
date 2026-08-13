import {
  isBashToolResult,
  isToolCallEventType,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolResultEvent,
} from '@earendil-works/pi-coding-agent'
import { Cause, Effect, Result, Schema } from 'effect'
import { type FileSystem } from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'
import { Type } from 'typebox'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { lstatHostFile, readHostDirectoryEntries } from '@/shared/effect/bun_host_file_system.js'
import { bunFileSystem, bunPath } from '@/shared/effect/bun_services.js'
import { isEmptyString, isNotEmptyString } from '@/shared/utils/predicates.js'
import { assertUnprotectedPathEffect, ProtectedPathError } from '@/shared/utils/protected_paths.js'

import {
  CancelledError,
  GitMetadataError,
  GitRepositoryError,
  InvalidPathError,
  OutsideAllowedRootError,
  OverlappingTargetsError,
  RecursiveRequiredError,
  SymlinkEscapeError,
  TargetChangedError,
} from './errors.js'

const { dirname, isAbsolute, join, relative, resolve, sep } = bunPath

const MAX_TARGETS = 50
const ROUTED_RM_SENTINEL = ': # pi-safe-rm'
const SIMPLE_RM_EXECUTABLES = new Set(['rm', '/bin/rm', '/usr/bin/rm'])
const SIMPLE_RM_LONG_OPTIONS = new Set(['--force', '--recursive'])
const SIMPLE_RM_LITERAL = /^[^\s;&|<>()`$*?[\]{}'"\\#!]+$/

interface SimpleRmPrefix {
  optionsEnded: boolean
  pathsStart: number
  recursive: boolean
}

const parseSimpleRmPrefix = (tokens: string[]): SimpleRmPrefix => {
  let pathsStart = 1
  let recursive = false
  while (pathsStart < tokens.length) {
    const token = tokens[pathsStart] ?? ''
    if (token === '--') {
      return { optionsEnded: true, pathsStart: pathsStart + 1, recursive }
    }
    if (/^-[fRr]+$/.test(token)) {
      recursive ||= /[Rr]/.test(token)
      pathsStart += 1
      continue
    }
    if (SIMPLE_RM_LONG_OPTIONS.has(token)) {
      recursive ||= token === '--recursive'
      pathsStart += 1
      continue
    }
    break
  }
  return { optionsEnded: false, pathsStart, recursive }
}

const parseSimpleRm = (command: string): SafeRmToolParams | undefined => {
  // Ponytail: whitespace-only literal syntax; add a shell tokenizer when quoted-path routing is needed.
  if (/[\r\n]/.test(command)) {
    return undefined
  }
  const tokens = command.replaceAll(/^[ \t]+|[ \t]+$/g, '').split(/[ \t]+/)
  if (!SIMPLE_RM_EXECUTABLES.has(tokens[0] ?? '')) {
    return undefined
  }

  const { optionsEnded, pathsStart, recursive } = parseSimpleRmPrefix(tokens)
  const paths = tokens.slice(pathsStart)
  const invalidPath = paths.some((path) => (!optionsEnded && path.startsWith('-')) || !SIMPLE_RM_LITERAL.test(path))
  if (invalidPath || paths.length === 0 || paths.length > MAX_TARGETS) {
    return undefined
  }
  return recursive ? { paths, recursive: true } : { paths }
}

export const SafeRmParams = Type.Object({
  paths: Type.Array(
    Type.String({
      description: 'Literal file or directory path. Globs and shell expansion are not supported.',
      minLength: 1,
    }),
    {
      description: 'Paths to remove after every target passes validation.',
      maxItems: MAX_TARGETS,
      minItems: 1,
    }
  ),
  recursive: Type.Optional(
    Type.Boolean({
      description: 'Must be true to remove directories. Defaults to false.',
    })
  ),
})

interface AllowedRoot {
  lexical: string
  canonical: string
}

interface ValidatedTarget {
  input: string
  absolute: string
  missing: boolean
  directory: boolean
}

interface SafeRmDetails {
  removed: string[]
  missing: string[]
}

const isDescendant = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate)
  return isNotEmptyString(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
}

const isWithinOrEqual = (root: string, candidate: string): boolean => root === candidate || isDescendant(root, candidate)

const isMissing = (error: unknown): boolean => {
  const candidate = Cause.isUnknownError(error) ? error.cause : error
  return typeof candidate === 'object' && candidate !== null && 'code' in candidate && (candidate as { code?: unknown }).code === 'ENOENT'
}

const checkCancelled = (signal: AbortSignal | undefined): Effect.Effect<void, CancelledError> =>
  signal !== undefined && signal.aborted ? Effect.fail(CancelledError.make({ message: 'Deletion was cancelled' })) : Effect.void

const normalizeInput = (path: string): Effect.Effect<string, InvalidPathError> => {
  // Ponytail: deletion keeps leading @ literal; implicit prefix stripping can target a different path.
  if (isEmptyString(path) || path.startsWith('~') || path.includes('\0')) {
    return Effect.fail(InvalidPathError.make({ message: `Invalid literal deletion path: ${JSON.stringify(path)}` }))
  }
  return Effect.succeed(path)
}

const rejectMetadataPath = (absolutePath: string): Effect.Effect<void, GitMetadataError> =>
  absolutePath.split(sep).some((component) => component.toLowerCase() === '.git')
    ? Effect.fail(GitMetadataError.make({ message: `Refusing to remove Git metadata: ${absolutePath}` }))
    : Effect.void

const unknownError = (cause: unknown): Cause.UnknownError =>
  Cause.isUnknownError(cause) ? cause : new Cause.UnknownError(cause, cause instanceof Error ? cause.message : String(cause))

const realpathEffect = (path: string): Effect.Effect<string, Cause.UnknownError> => bunFileSystem.realPath(path).pipe(Effect.mapError(unknownError))

const removeEffect = (path: string, options: { force: boolean; recursive: boolean }): Effect.Effect<void, Cause.UnknownError> =>
  bunFileSystem.remove(path, options).pipe(Effect.mapError(unknownError))

/**
 * Recursive removal must not turn a harmless-looking parent directory into
 * a way to erase credentials or a nested Git repository. Symlink entries are
 * checked by canonical policy but never traversed.
 */
const inspectDirectoryTree = (
  directory: string,
  cwd: string,
  signal: AbortSignal | undefined
): Effect.Effect<
  void,
  CancelledError | Cause.UnknownError | GitRepositoryError | GitMetadataError | PlatformError | ProtectedPathError,
  FileSystem
> =>
  Effect.gen(function* () {
    yield* checkCancelled(signal)
    const entries = yield* readHostDirectoryEntries(directory)
    for (const entry of entries) {
      yield* checkCancelled(signal)
      const child = join(directory, entry.name)
      if (entry.name.toLowerCase() === '.git') {
        return yield* GitRepositoryError.make({ message: `Refusing to remove a Git repository: ${directory}` })
      }
      yield* rejectMetadataPath(child)
      yield* assertUnprotectedPathEffect(child, cwd, 'remove')
      if (entry.isDirectory && !entry.isSymbolicLink) {
        yield* inspectDirectoryTree(child, cwd, signal)
      }
    }
    return undefined
  })

interface ValidateTargetOptions {
  input: string
  cwd: string
  roots: AllowedRoot[]
  recursive: boolean
  signal: AbortSignal | undefined
}

type ValidateTargetError =
  | CancelledError
  | InvalidPathError
  | Cause.UnknownError
  | OutsideAllowedRootError
  | GitMetadataError
  | SymlinkEscapeError
  | RecursiveRequiredError
  | GitRepositoryError
  | PlatformError
  | ProtectedPathError

const validateTargetEffect = ({
  input,
  cwd,
  roots,
  recursive,
  signal,
}: ValidateTargetOptions): Effect.Effect<ValidatedTarget, ValidateTargetError, FileSystem> =>
  Effect.gen(function* () {
    yield* checkCancelled(signal)
    const normalizedInput = yield* normalizeInput(input)
    const absolute = resolve(cwd, normalizedInput)
    yield* assertUnprotectedPathEffect(input, cwd, 'remove')
    const lexicalRoot = roots.find((root) => isDescendant(root.lexical, absolute))
    if (lexicalRoot === undefined) {
      return yield* OutsideAllowedRootError.make({ message: `Deletion target must be below the working directory or /tmp: ${input}` })
    }

    yield* rejectMetadataPath(absolute)

    const statsOutcome = yield* Effect.result(lstatHostFile(absolute))
    if (Result.isFailure(statsOutcome)) {
      if (isMissing(statsOutcome.failure)) {
        return { absolute, directory: false, input, missing: true }
      }
      return yield* statsOutcome.failure
    }
    const stats = statsOutcome.success

    const canonicalParent = yield* realpathEffect(dirname(absolute))
    if (!roots.some((root) => isWithinOrEqual(root.canonical, canonicalParent))) {
      return yield* SymlinkEscapeError.make({ message: `Deletion target escapes an allowed root through a symlink: ${input}` })
    }

    const directory = stats.isDirectory && !stats.isSymbolicLink
    if (directory && !recursive) {
      return yield* RecursiveRequiredError.make({ message: `Directory deletion requires recursive: true: ${input}` })
    }
    if (directory) {
      yield* inspectDirectoryTree(absolute, cwd, signal)
    }

    return { absolute, directory, input, missing: false }
  })

interface RevalidateTargetOptions {
  target: ValidatedTarget
  roots: AllowedRoot[]
  cwd: string
  signal: AbortSignal | undefined
}

type RevalidateTargetError =
  | CancelledError
  | Cause.UnknownError
  | SymlinkEscapeError
  | TargetChangedError
  | GitRepositoryError
  | GitMetadataError
  | PlatformError
  | ProtectedPathError

const mutationQueueError = (cause: unknown): RevalidateTargetError => {
  if (
    Cause.isUnknownError(cause) ||
    Schema.is(CancelledError)(cause) ||
    Schema.is(SymlinkEscapeError)(cause) ||
    Schema.is(TargetChangedError)(cause) ||
    Schema.is(GitRepositoryError)(cause) ||
    Schema.is(GitMetadataError)(cause) ||
    Schema.is(ProtectedPathError)(cause)
  ) {
    return cause
  }
  return unknownError(cause)
}

const revalidateTargetEffect = ({ target, roots, cwd, signal }: RevalidateTargetOptions): Effect.Effect<void, RevalidateTargetError, FileSystem> =>
  Effect.gen(function* () {
    yield* checkCancelled(signal)
    yield* assertUnprotectedPathEffect(target.absolute, cwd, 'remove')
    const canonicalParent = yield* realpathEffect(dirname(target.absolute))
    if (!roots.some((root) => isWithinOrEqual(root.canonical, canonicalParent))) {
      return yield* SymlinkEscapeError.make({ message: `Deletion target escapes an allowed root through a symlink: ${target.input}` })
    }

    const stats = yield* lstatHostFile(target.absolute)
    const directory = stats.isDirectory && !stats.isSymbolicLink
    if (directory !== target.directory) {
      return yield* TargetChangedError.make({ message: `Deletion target changed after validation: ${target.input}` })
    }
    if (directory) {
      yield* inspectDirectoryTree(target.absolute, cwd, signal)
    }
    return undefined
  })

const rejectOverlappingTargets = (targets: ValidatedTarget[]): Effect.Effect<void, OverlappingTargetsError> =>
  Effect.gen(function* () {
    for (const [index, first] of targets.entries()) {
      for (const second of targets.slice(index + 1)) {
        if (first.absolute === second.absolute || isDescendant(first.absolute, second.absolute) || isDescendant(second.absolute, first.absolute)) {
          return yield* OverlappingTargetsError.make({
            message: `Deletion targets must be distinct and non-overlapping: ${first.input}, ${second.input}`,
          })
        }
      }
    }
    return undefined
  })

interface SafeRmToolParams {
  paths: string[]
  recursive?: boolean
}

interface ToolOutput {
  content: { text: string; type: 'text' }[]
  details: SafeRmDetails
}

type SafeRmToolError = ValidateTargetError | RevalidateTargetError | OverlappingTargetsError

export type SafeRmRun = (
  params: SafeRmToolParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext
) => Effect.Effect<ToolOutput, SafeRmToolError, FileSystem>

// Cancellation stays cooperative so an interrupted fiber cannot replace the tagged validation failure.
export const makeSafeRmRunner =
  (runtime: AppRuntime): SafeRmRun =>
  (params, signal, ctx) =>
    Effect.gen(function* () {
      yield* checkCancelled(signal)

      const cwd = resolve(ctx.cwd)
      const tmpRoot = resolve('/tmp')
      const roots: AllowedRoot[] = [
        { canonical: yield* realpathEffect(cwd), lexical: cwd },
        { canonical: yield* realpathEffect(tmpRoot), lexical: tmpRoot },
      ]
      const recursive = params.recursive ?? false

      const targets = yield* Effect.forEach(params.paths, (path) => validateTargetEffect({ cwd, input: path, recursive, roots, signal }), {
        concurrency: 'unbounded',
      })
      yield* rejectOverlappingTargets(targets)

      const details: SafeRmDetails = { missing: [], removed: [] }
      for (const target of targets) {
        if (target.missing) {
          details.missing.push(target.input)
          continue
        }
        yield* checkCancelled(signal)

        yield* Effect.tryPromise({
          catch: mutationQueueError,
          try: () =>
            withFileMutationQueue(target.absolute, () =>
              runtime.runPromise(
                Effect.gen(function* () {
                  /*
                   * Deliberately a genuine second pass, not a reuse of validateTargetEffect: a parent may
                   * have been replaced by a symlink while this target waited in queue.
                   */
                  yield* revalidateTargetEffect({ cwd, roots, signal, target })
                  yield* removeEffect(target.absolute, { force: false, recursive: target.directory })
                })
              )
            ),
        })
        details.removed.push(target.input)
      }

      const lines = [
        details.removed.length > 0 ? `Removed: ${details.removed.join(', ')}` : 'Removed: none',
        details.missing.length > 0 ? `Already missing: ${details.missing.join(', ')}` : 'Already missing: none',
      ]
      return {
        content: [{ text: lines.join('\n'), type: 'text' as const }],
        details,
      }
    })

interface RoutedRmResult {
  content: { text: string; type: 'text' }[]
  details: Record<string, unknown>
  isError: boolean
}

export interface RmRouter {
  readonly route: (event: ToolCallEvent) => void
  readonly complete: (event: ToolResultEvent, ctx: ExtensionContext) => Effect.Effect<RoutedRmResult | undefined, never, FileSystem>
  readonly forget: (event: { toolCallId: string }) => void
}

export interface RmRouterOptions {
  readonly pi: ExtensionAPI
  readonly runRm: SafeRmRun
}

const routedRmFailure = (text: string): RoutedRmResult => ({ content: [{ text, type: 'text' as const }], details: {}, isError: true })

const notRouted: Effect.Effect<RoutedRmResult | undefined> = Effect.void.pipe(Effect.as(undefined))

export const makeRmRouter = ({ pi, runRm }: RmRouterOptions): RmRouter => {
  const pending = new Map<string, SafeRmToolParams>()

  return {
    complete: (event, ctx) =>
      Effect.suspend(() => {
        if (!isBashToolResult(event) || event.input.command !== ROUTED_RM_SENTINEL) {
          return notRouted
        }
        const route = pending.get(event.toolCallId)
        pending.delete(event.toolCallId)
        if (event.isError) {
          return notRouted
        }
        if (route === undefined) {
          return Effect.succeed(routedRmFailure('Safe removal handoff was lost; no paths were removed'))
        }

        return runRm(route, ctx.signal, ctx).pipe(
          Effect.map((result): RoutedRmResult => ({ content: result.content, details: {}, isError: false })),
          Effect.catchCause((cause) => {
            const error: unknown = Cause.squash(cause)
            return Effect.succeed(routedRmFailure(error instanceof Error ? error.message : String(error)))
          })
        )
      }),
    forget: (event) => {
      pending.delete(event.toolCallId)
    },
    route: (event) => {
      if (!isToolCallEventType('bash', event) || !pi.getActiveTools().includes('safe_rm')) {
        return
      }
      const route = parseSimpleRm(event.input.command)
      if (route === undefined) {
        return
      }

      pending.set(event.toolCallId, route)
      // The sentinel keeps later command guards from rejecting the no-op; the original call remains in the transcript.
      // Ponytail: bash and safe_rm share ctx.cwd; keep rm blocked if remote filesystems become detectable.
      event.input.command = ROUTED_RM_SENTINEL
    },
  }
}
