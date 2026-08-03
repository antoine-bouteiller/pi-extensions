import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import { Effect, Schema } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'

/** Filenames that look like dotenv files but are intended to be public examples. */
const PUBLIC_ENV_FILENAMES = new Set(['.env.example', '.env.sample', '.env.template'])

const ALWAYS_PROTECTED_PATTERNS = [
  /(?<prefix>^|\/)\.ssh(?<suffix>\/|$)/,
  /(?<prefix>^|\/)(?:\.envrc|\.git-credentials|\.netrc|\.npmrc|\.pypirc|auth\.json)$/,
  /(?<prefix>^|\/)id_(?:ed25519|rsa)(?:\.pub)?$/,
  /(?<prefix>^|\/)\.aws\/(?:config|credentials)$/,
  /(?<prefix>^|\/)\.kube\/config$/,
  /(?<prefix>^|\/)\.config\/(?:gcloud(?:\/|$)|gh\/hosts\.yml$)/,
  /\.(?:kdbx|key|p12|pem)$/,
]

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
export const stripToolPathPrefix = (path: string): string => (path.startsWith('@') ? path.slice(1) : path)

export const resolveToolPath = (path: string, cwd: string): string => resolve(cwd, stripToolPathPrefix(path))

/**
 * Canonicalize an existing path, or (for a path that does not exist yet)
 * canonicalize its nearest existing ancestor and append the missing suffix.
 * This prevents `link-to-elsewhere/new-file` from evading path policy merely
 * because `new-file` has not been created yet.
 */
const canonicalizeNearestExisting = async (path: string): Promise<string> => {
  let candidate = resolve(path)
  const missingComponents: string[] = []

  while (true) {
    try {
      const existing = await realpath(candidate)
      return resolve(existing, ...missingComponents)
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error
      }
      const parent = dirname(candidate)
      if (parent === candidate) {
        return resolve(path)
      }
      missingComponents.unshift(basename(candidate))
      candidate = parent
    }
  }
}

const matchesProtectedPolicy = (path: string): boolean => {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  const name = basename(normalized)
  const isPrivateEnv = (name === '.env' || name.startsWith('.env.')) && !PUBLIC_ENV_FILENAMES.has(name)
  return isPrivateEnv || ALWAYS_PROTECTED_PATTERNS.some((pattern) => pattern.test(normalized))
}

/**
 * Apply protected-file policy to both the lexical and canonical spellings.
 * Checking both means neither a harmless-looking symlink to a credential nor
 * a credential-shaped symlink to a harmless file bypasses the policy.
 */
const resolveProtectedPath = async (path: string, cwd: string): Promise<ProtectedPathResolution> => {
  const absolutePath = resolveToolPath(path, cwd)
  const canonicalPath = await canonicalizeNearestExisting(absolutePath)
  return {
    absolutePath,
    canonicalPath,
    protected: matchesProtectedPolicy(absolutePath) || matchesProtectedPolicy(canonicalPath),
  }
}

export const isProtectedPath = async (path: string, cwd: string): Promise<boolean> => {
  const resolution = await resolveProtectedPath(path, cwd)
  return resolution.protected
}

export const assertUnprotectedPath = async (path: string, cwd: string, operation: string): Promise<ProtectedPathResolution> => {
  const resolution = await resolveProtectedPath(path, cwd)
  if (resolution.protected) {
    throw new Error(protectedPathMessage(path, operation))
  }
  return resolution
}

const protectedPathMessage = (path: string, operation: string): string => `Refusing to ${operation} protected path: ${path}`

export class ProtectedPathError extends Schema.TaggedErrorClass<ProtectedPathError>()('ProtectedPathError', {
  message: Schema.String,
  path: Schema.String,
}) {}

/*
 * Effect maps ENOENT to `NotFound` but ENOTDIR to `BadResource`, the same reason it gives EISDIR
 * and ELOOP. Branching on the reason would either stop walking past a non-directory component or,
 * worse, treat a symlink loop as a missing path. Match on the errno the PlatformError still
 * carries in `cause`, so this stays byte-for-byte the predicate the callback version uses.
 */
const isMissingPlatformError = (error: PlatformError): boolean => isMissingPathError(error.cause)

const canonicalizeNearestExistingEffect = (path: string): Effect.Effect<string, PlatformError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    let candidate = resolve(path)
    const missingComponents: string[] = []

    while (true) {
      const existing = yield* fs.realPath(candidate).pipe(
        Effect.map((resolved): string | undefined => resolved),
        Effect.catchIf(isMissingPlatformError, () => Effect.succeed(undefined))
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
      return yield* Effect.fail(new ProtectedPathError({ message: protectedPathMessage(path, operation), path }))
    }
    return resolution
  })
