import { type Dirent, type Stats } from 'node:fs'
import { lstat, readdir, realpath, rm as remove } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  isBashToolResult,
  isToolCallEventType,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { Cause, Effect, Function, Result } from 'effect'
import { Type } from 'typebox'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { assertUnprotectedPath } from '@/shared/utils/protected_paths.js'

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

const SafeRmParams = Type.Object({
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
  return pathFromRoot !== '' && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
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
  if (path === '' || path.startsWith('~') || path.includes('\0')) {
    return Effect.fail(InvalidPathError.make({ message: `Invalid literal deletion path: ${JSON.stringify(path)}` }))
  }
  return Effect.succeed(path)
}

const rejectMetadataPath = (absolutePath: string): Effect.Effect<void, GitMetadataError> =>
  absolutePath.split(sep).some((component) => component.toLowerCase() === '.git')
    ? Effect.fail(GitMetadataError.make({ message: `Refusing to remove Git metadata: ${absolutePath}` }))
    : Effect.void

const lstatEffect = (path: string): Effect.Effect<Stats, Cause.UnknownError> => Effect.tryPromise(() => lstat(path))

const realpathEffect = (path: string): Effect.Effect<string, Cause.UnknownError> => Effect.tryPromise(() => realpath(path))

const readdirEffect = (path: string): Effect.Effect<Dirent[], Cause.UnknownError> => Effect.tryPromise(() => readdir(path, { withFileTypes: true }))

const removeEffect = (path: string, options: { force: boolean; recursive: boolean }): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => remove(path, options))

const assertUnprotectedEffect = (path: string, cwd: string, operation: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => assertUnprotectedPath(path, cwd, operation))

/**
 * Recursive removal must not turn a harmless-looking parent directory into
 * a way to erase credentials or a nested Git repository. Symlink entries are
 * checked by canonical policy but never traversed.
 */
const inspectDirectoryTree = (
  directory: string,
  cwd: string,
  signal: AbortSignal | undefined
): Effect.Effect<void, CancelledError | Cause.UnknownError | GitRepositoryError | GitMetadataError> =>
  Effect.gen(function* () {
    yield* checkCancelled(signal)
    const entries = yield* readdirEffect(directory)
    for (const entry of entries) {
      yield* checkCancelled(signal)
      const child = join(directory, entry.name)
      if (entry.name.toLowerCase() === '.git') {
        return yield* GitRepositoryError.make({ message: `Refusing to remove a Git repository: ${directory}` })
      }
      yield* rejectMetadataPath(child)
      yield* assertUnprotectedEffect(child, cwd, 'remove')
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
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

const validateTargetEffect = ({ input, cwd, roots, recursive, signal }: ValidateTargetOptions): Effect.Effect<ValidatedTarget, ValidateTargetError> =>
  Effect.gen(function* () {
    yield* checkCancelled(signal)
    const normalizedInput = yield* normalizeInput(input)
    const absolute = resolve(cwd, normalizedInput)
    yield* assertUnprotectedEffect(input, cwd, 'remove')
    const lexicalRoot = roots.find((root) => isDescendant(root.lexical, absolute))
    if (lexicalRoot === undefined) {
      return yield* OutsideAllowedRootError.make({ message: `Deletion target must be below the working directory or /tmp: ${input}` })
    }

    yield* rejectMetadataPath(absolute)

    const statsOutcome = yield* Effect.result(lstatEffect(absolute))
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

    const directory = stats.isDirectory() && !stats.isSymbolicLink()
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

type RevalidateTargetError = CancelledError | Cause.UnknownError | SymlinkEscapeError | TargetChangedError | GitRepositoryError | GitMetadataError

const revalidateTargetEffect = ({ target, roots, cwd, signal }: RevalidateTargetOptions): Effect.Effect<void, RevalidateTargetError> =>
  Effect.gen(function* () {
    yield* checkCancelled(signal)
    yield* assertUnprotectedEffect(target.absolute, cwd, 'remove')
    const canonicalParent = yield* realpathEffect(dirname(target.absolute))
    if (!roots.some((root) => isWithinOrEqual(root.canonical, canonicalParent))) {
      return yield* SymlinkEscapeError.make({ message: `Deletion target escapes an allowed root through a symlink: ${target.input}` })
    }

    const stats = yield* lstatEffect(target.absolute)
    const directory = stats.isDirectory() && !stats.isSymbolicLink()
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

/*
 * Cancellation stays cooperative through `checkCancelled`, so the signal is deliberately never
 * handed to `Effect.runPromise`: forwarding it would let Effect interrupt the fiber mid-flight and
 * replace the exact rejection message tests and Pi both depend on with a generic interrupted-fiber
 * one.
 */
const toRejection = (error: unknown): Error => {
  if (Cause.isUnknownError(error) && error.cause instanceof Error) {
    return error.cause
  }
  return error instanceof Error ? error : new Error(String(error))
}

interface SafeRmToolParams {
  paths: string[]
  recursive?: boolean
}

interface ToolOutput {
  content: { text: string; type: 'text' }[]
  details: SafeRmDetails
}

type SafeRmToolError = ValidateTargetError | OverlappingTargetsError | Cause.UnknownError

const createSafeRmTool = (runtime: AppRuntime) => {
  const runTool =
    <Params, Result, Failure>(body: (params: Params, signal: AbortSignal | undefined, ctx: ExtensionContext) => Effect.Effect<Result, Failure>) =>
    async (_toolCallId: string, params: Params, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<Result> =>
      runtime.runPromise(body(params, signal, ctx).pipe(Effect.mapError(toRejection)))

  return {
    description:
      'Safely remove literal paths without shell rm. Every target is validated before deletion: targets must be below the working directory or /tmp, parent symlinks cannot escape those roots, credentials and Git repositories are protected even inside recursive targets, and directories require recursive=true.',
    execute: runTool((params: SafeRmToolParams, signal: AbortSignal | undefined, ctx: ExtensionContext): Effect.Effect<ToolOutput, SafeRmToolError> =>
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

          yield* Effect.tryPromise(() =>
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
            )
          )
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
    ),
    label: 'Safe Remove',
    name: 'safe_rm',
    parameters: SafeRmParams,
    promptGuidelines: [
      'Use safe_rm for file and directory deletion. The shell guard routes simple literal rm commands through the same validation and blocks complex rm, rmdir, unlink, find deletion, and xargs rm commands.',
      'Set recursive=true only when intentionally removing directories. safe_rm validates all paths before deleting any of them.',
    ],
    promptSnippet: 'Remove files or directories through validated literal paths',
  }
}

export const register: {
  (runtime: AppRuntime): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime): void
} = Function.dual(
  (args) => typeof args[0].on === 'function',
  (pi: ExtensionAPI, runtime: AppRuntime): void => {
    const safeRm = createSafeRmTool(runtime)
    const pending = new Map<string, SafeRmToolParams>()
    pi.registerTool(safeRm)

    pi.on('tool_call', (event) => {
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
    })

    pi.on('tool_result', async (event, ctx) => {
      if (!isBashToolResult(event) || event.input.command !== ROUTED_RM_SENTINEL) {
        return undefined
      }
      const route = pending.get(event.toolCallId)
      pending.delete(event.toolCallId)
      if (event.isError) {
        return undefined
      }
      if (route === undefined) {
        return {
          content: [{ text: 'Safe removal handoff was lost; no paths were removed', type: 'text' as const }],
          details: {},
          isError: true,
        }
      }

      try {
        const result = await safeRm.execute(event.toolCallId, route, ctx.signal, undefined, ctx)
        return { content: result.content, details: {}, isError: false }
      } catch (error) {
        return {
          content: [{ text: error instanceof Error ? error.message : String(error), type: 'text' as const }],
          details: {},
          isError: true,
        }
      }
    })

    pi.on('tool_execution_end', (event) => {
      pending.delete(event.toolCallId)
    })
  }
)
