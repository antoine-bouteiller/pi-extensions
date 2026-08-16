import { Effect, Schema } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'

import { nodePath } from '#shared/effect/node_services'

const { basename, dirname, resolve } = nodePath
/** Filenames that look like dotenv files but are intended to be public examples. */
const PUBLIC_ENV_FILENAMES = new Set(['.env.example', '.env.sample', '.env.template'])

const SSH_PATTERN = /(?<prefix>^|\/)\.ssh(?<suffix>\/|$)/

export interface ProtectedPathResolution {
  /** Absolute path after resolving it lexically against cwd. */
  absolutePath: string
  /** Absolute path after resolving symlinks in the nearest existing ancestor. */
  canonicalPath: string
  protected: boolean
}

const isMissingPathError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ((error as { code?: unknown }).code === 'ENOENT' || (error as { code?: unknown }).code === 'ENOTDIR')

/** Strip the leading `@` accepted by pi's path-oriented tools. */
const stripToolPathPrefix = (path: string): string => (path.startsWith('@') ? path.slice(1) : path)

const resolveToolPath = (path: string, cwd: string): string => resolve(cwd, stripToolPathPrefix(path))

const matchesProtectedPolicy = (path: string): boolean => {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  const name = basename(normalized)
  const isPrivateEnv = (name === '.env' || name.startsWith('.env.')) && !PUBLIC_ENV_FILENAMES.has(name)
  return isPrivateEnv || SSH_PATTERN.test(normalized)
}

const protectedPathMessage = (path: string, operation: string): string => `Refusing to ${operation} protected path: ${path}`

export class ProtectedPathError extends Schema.TaggedError<ProtectedPathError>()('ProtectedPathError', {
  message: Schema.String,
  path: Schema.String,
}) {}

/*
 * Effect maps ENOENT to `NotFound` but ENOTDIR to `BadResource`, the same reason it gives EISDIR
 * and ELOOP. Branching on the reason would either stop walking past a non-directory component or,
 * worse, treat a symlink loop as a missing path. Match on the errno the PlatformError still
 * carries in `cause`.
 */
const isMissingPlatformError = (error: PlatformError): boolean => isMissingPathError(error.cause)

const noExistingAncestor = undefined

/**
 * Canonicalize an existing path, or (for a path that does not exist yet)
 * canonicalize its nearest existing ancestor and append the missing suffix.
 * This prevents `link-to-elsewhere/new-file` from evading path policy merely
 * because `new-file` has not been created yet.
 */
const canonicalizeNearestExistingEffect = (path: string): Effect.Effect<string, PlatformError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    let candidate = resolve(path)
    const missingComponents: string[] = []

    while (true) {
      const existing = yield* fs.realPath(candidate).pipe(
        Effect.map((resolved): string | undefined => resolved),
        Effect.catchIf(isMissingPlatformError, () => Effect.succeed(noExistingAncestor))
      )
      if (existing !== undefined) {
        return resolve(existing, ...missingComponents)
      }
      const parent = dirname(candidate)
      if (parent === candidate) {
        return resolve(path)
      }
      missingComponents.unshift(basename(candidate))
      candidate = parent
    }
  })

/**
 * Apply protected-file policy to both the lexical and canonical spellings.
 * Checking both means neither a harmless-looking symlink to a credential nor
 * a credential-shaped symlink to a harmless file bypasses the policy.
 */
export const resolveProtectedPathEffect = (path: string, cwd: string): Effect.Effect<ProtectedPathResolution, PlatformError, FileSystem> =>
  Effect.gen(function* () {
    const absolutePath = resolveToolPath(path, cwd)
    const canonicalPath = yield* canonicalizeNearestExistingEffect(absolutePath)
    return {
      absolutePath,
      canonicalPath,
      protected: matchesProtectedPolicy(absolutePath) || matchesProtectedPolicy(canonicalPath),
    }
  })

export const assertUnprotectedPathEffect = (
  path: string,
  cwd: string,
  operation: string
): Effect.Effect<ProtectedPathResolution, PlatformError | ProtectedPathError, FileSystem> =>
  Effect.gen(function* () {
    const resolution = yield* resolveProtectedPathEffect(path, cwd)
    if (resolution.protected) {
      return yield* ProtectedPathError.make({ message: protectedPathMessage(path, operation), path })
    }
    return resolution
  })
