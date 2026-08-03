import { type Dirent, type Stats } from 'node:fs'
import { lstat, readdir, realpath, rm as remove } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Effect, Result } from 'effect'
import { Type } from 'typebox'

import { type AppRuntime, getOrCreateProcessRuntime } from '../effect/app_runtime.js'
import { assertUnprotectedPath } from '../shared/protected_paths.js'
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

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'

const checkCancelled = (signal: AbortSignal | undefined): Effect.Effect<void, CancelledError> =>
  signal?.aborted ? Effect.fail(new CancelledError({ message: 'Deletion was cancelled' })) : Effect.void

const normalizeInput = (path: string): Effect.Effect<string, InvalidPathError> => {
  const normalized = path.startsWith('@') ? path.slice(1) : path
  if (!normalized || normalized.startsWith('~') || normalized.includes('\0')) {
    return Effect.fail(new InvalidPathError({ message: `Invalid literal deletion path: ${JSON.stringify(path)}` }))
  }
  return Effect.succeed(normalized)
}

const rejectMetadataPath = (absolutePath: string): Effect.Effect<void, GitMetadataError> =>
  absolutePath.split(sep).some((component) => component.toLowerCase() === '.git')
    ? Effect.fail(new GitMetadataError({ message: `Refusing to remove Git metadata: ${absolutePath}` }))
    : Effect.void

const lstatEffect = (path: string): Effect.Effect<Stats, unknown> => Effect.tryPromise({ catch: (cause) => cause, try: () => lstat(path) })

const realpathEffect = (path: string): Effect.Effect<string, unknown> => Effect.tryPromise({ catch: (cause) => cause, try: () => realpath(path) })

const readdirEffect = (path: string): Effect.Effect<Dirent[], unknown> =>
  Effect.tryPromise({ catch: (cause) => cause, try: () => readdir(path, { withFileTypes: true }) })

const removeEffect = (path: string, options: { force: boolean; recursive: boolean }): Effect.Effect<void, unknown> =>
  Effect.tryPromise({ catch: (cause) => cause, try: () => remove(path, options) })

const assertUnprotectedEffect = (path: string, cwd: string, operation: string): Effect.Effect<void, unknown> =>
  Effect.tryPromise({ catch: (cause) => cause, try: () => assertUnprotectedPath(path, cwd, operation) })

/**
 * Recursive removal must not turn a harmless-looking parent directory into
 * a way to erase credentials or a nested Git repository. Symlink entries are
 * checked by canonical policy but never traversed.
 */
const inspectDirectoryTree = (directory: string, cwd: string, signal: AbortSignal | undefined): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    yield* checkCancelled(signal)
    const entries = yield* readdirEffect(directory)
    for (const entry of entries) {
      yield* checkCancelled(signal)
      const child = join(directory, entry.name)
      if (entry.name.toLowerCase() === '.git') {
        yield* Effect.fail(new GitRepositoryError({ message: `Refusing to remove a Git repository: ${directory}` }))
      }
      yield* rejectMetadataPath(child)
      yield* assertUnprotectedEffect(child, cwd, 'remove')
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        yield* inspectDirectoryTree(child, cwd, signal)
      }
    }
  })

interface ValidateTargetOptions {
  input: string
  cwd: string
  roots: AllowedRoot[]
  recursive: boolean
  signal: AbortSignal | undefined
}

const validateTargetEffect = ({ input, cwd, roots, recursive, signal }: ValidateTargetOptions): Effect.Effect<ValidatedTarget, unknown> =>
  Effect.gen(function* () {
    yield* checkCancelled(signal)
    const normalizedInput = yield* normalizeInput(input)
    const absolute = resolve(cwd, normalizedInput)
    yield* assertUnprotectedEffect(input, cwd, 'remove')
    const lexicalRoot = roots.find((root) => isDescendant(root.lexical, absolute))
    if (!lexicalRoot) {
      return yield* Effect.fail(new OutsideAllowedRootError({ message: `Deletion target must be below the working directory or /tmp: ${input}` }))
    }

    yield* rejectMetadataPath(absolute)

    const statsOutcome = yield* Effect.result(lstatEffect(absolute))
    if (Result.isFailure(statsOutcome)) {
      if (isMissing(statsOutcome.failure)) {
        return { absolute, directory: false, input, missing: true }
      }
      return yield* Effect.fail(statsOutcome.failure)
    }
    const stats = statsOutcome.success

    const canonicalParent = yield* realpathEffect(dirname(absolute))
    if (!roots.some((root) => isWithinOrEqual(root.canonical, canonicalParent))) {
      return yield* Effect.fail(new SymlinkEscapeError({ message: `Deletion target escapes an allowed root through a symlink: ${input}` }))
    }

    const directory = stats.isDirectory() && !stats.isSymbolicLink()
    if (directory && !recursive) {
      return yield* Effect.fail(new RecursiveRequiredError({ message: `Directory deletion requires recursive: true: ${input}` }))
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

const revalidateTargetEffect = ({ target, roots, cwd, signal }: RevalidateTargetOptions): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    yield* checkCancelled(signal)
    yield* assertUnprotectedEffect(target.absolute, cwd, 'remove')
    const canonicalParent = yield* realpathEffect(dirname(target.absolute))
    if (!roots.some((root) => isWithinOrEqual(root.canonical, canonicalParent))) {
      yield* Effect.fail(new SymlinkEscapeError({ message: `Deletion target escapes an allowed root through a symlink: ${target.input}` }))
    }

    const stats = yield* lstatEffect(target.absolute)
    const directory = stats.isDirectory() && !stats.isSymbolicLink()
    if (directory !== target.directory) {
      yield* Effect.fail(new TargetChangedError({ message: `Deletion target changed after validation: ${target.input}` }))
    }
    if (directory) {
      yield* inspectDirectoryTree(target.absolute, cwd, signal)
    }
  })

const rejectOverlappingTargets = (targets: ValidatedTarget[]): Effect.Effect<void, OverlappingTargetsError> =>
  Effect.gen(function* () {
    for (const [index, first] of targets.entries()) {
      for (const second of targets.slice(index + 1)) {
        if (first.absolute === second.absolute || isDescendant(first.absolute, second.absolute) || isDescendant(second.absolute, first.absolute)) {
          yield* Effect.fail(
            new OverlappingTargetsError({
              message: `Deletion targets must be distinct and non-overlapping: ${first.input}, ${second.input}`,
            })
          )
        }
      }
    }
  })

/*
 * Cancellation stays cooperative through `checkCancelled`, so the signal is deliberately never
 * handed to `Effect.runPromise`: forwarding it would let Effect interrupt the fiber mid-flight and
 * replace the exact rejection message tests and Pi both depend on with a generic interrupted-fiber
 * one.
 */
const toRejection = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)))

interface SafeRmToolParams {
  paths: string[]
  recursive?: boolean
}

interface ToolOutput {
  content: { text: string; type: 'text' }[]
  details: SafeRmDetails
}

export const register = (pi: ExtensionAPI, runtime: AppRuntime): void => {
  const runTool =
    <Params, Result>(body: (params: Params, signal: AbortSignal | undefined, ctx: ExtensionContext) => Effect.Effect<Result, unknown>) =>
    async (_toolCallId: string, params: Params, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<Result> =>
      runtime.runPromise(body(params, signal, ctx).pipe(Effect.catch((error: unknown) => Effect.fail(toRejection(error)))))

  pi.registerTool({
    description:
      'Safely remove literal paths without shell rm. Every target is validated before deletion: targets must be below the working directory or /tmp, parent symlinks cannot escape those roots, credentials and Git repositories are protected even inside recursive targets, and directories require recursive=true.',
    execute: runTool<SafeRmToolParams, ToolOutput>((params, signal, ctx) =>
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
            catch: (cause) => cause,
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
    ),
    label: 'Safe Remove',
    name: 'safe_rm',
    parameters: SafeRmParams,
    promptGuidelines: [
      'Use safe_rm for file and directory deletion. A best-effort shell scanner blocks recognized rm, rmdir, unlink, find deletion, and xargs rm commands, but safe_rm is the security-enforcing path.',
      'Set recursive=true only when intentionally removing directories. safe_rm validates all paths before deleting any of them.',
    ],
    promptSnippet: 'Remove files or directories through validated literal paths',
  })
}

export default function safeRm(pi: ExtensionAPI): void {
  register(pi, getOrCreateProcessRuntime())
}
