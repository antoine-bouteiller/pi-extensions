/* oxlint-disable effecttsgo/node-builtin-import -- Effect FileSystem lacks no-follow metadata, typed directory entries, and the unscoped descriptor ownership cross-process locks need. */
import fs from 'node:fs'

import { type Cause, Effect } from 'effect'

import { unknownError } from '#shared/effect/errors'

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')

/** Held files carry one small lock record, so a larger file is corrupt or hostile and is never read into memory. */
const MAX_HELD_FILE_BYTES = 64 * 1024

const readHeldContent = (descriptor: number, size: number): string => {
  if (size > MAX_HELD_FILE_BYTES) {
    throw new Error(`Held file is larger than ${MAX_HELD_FILE_BYTES} bytes`)
  }
  return fs.readFileSync(descriptor, 'utf8')
}

export interface HostFileInfo {
  readonly isDirectory: boolean
  readonly isFile: boolean
  readonly isSymbolicLink: boolean
  readonly mtimeMs: number
}

export interface HostDirectoryEntry {
  readonly name: string
  readonly isDirectory: boolean
  readonly isFile: boolean
  readonly isSymbolicLink: boolean
}

const fileInfo = (stat: fs.Stats): HostFileInfo => ({
  isDirectory: stat.isDirectory(),
  isFile: stat.isFile(),
  isSymbolicLink: stat.isSymbolicLink(),
  mtimeMs: stat.mtimeMs,
})

export const lstatHostFile = (path: string): Effect.Effect<HostFileInfo, Cause.UnknownError> =>
  Effect.tryPromise({ catch: unknownError, try: () => fs.promises.lstat(path).then(fileInfo) })

export const readHostDirectoryEntries = (path: string): Effect.Effect<HostDirectoryEntry[], Cause.UnknownError> =>
  Effect.tryPromise({
    catch: unknownError,
    try: () =>
      fs.promises.readdir(path, { withFileTypes: true }).then((entries) =>
        entries.map((entry) => ({
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          isSymbolicLink: entry.isSymbolicLink(),
          name: entry.name,
        }))
      ),
  })

const HeldFileTypeId: unique symbol = Symbol('HeldFile')
export interface HeldFile {
  readonly [HeldFileTypeId]: true
}

interface HeldState {
  readonly descriptor: number
  readonly stat: fs.Stats
  readonly content: string
}

const heldFiles = new WeakMap<HeldFile, HeldState>()

const heldFile = (descriptor: number, content?: string): HeldFile => {
  const stat = fs.fstatSync(descriptor)
  const handle = { [HeldFileTypeId]: true } as const
  heldFiles.set(handle, {
    content: content ?? readHeldContent(descriptor, stat.size),
    descriptor,
    stat,
  })
  return handle
}

const stateOf = (handle: HeldFile): HeldState => {
  const state = heldFiles.get(handle)
  if (state === undefined) {
    throw new Error('Held file is already closed')
  }
  return state
}

export const openHeldFile = (path: string): Effect.Effect<HeldFile, Cause.UnknownError> =>
  Effect.try({
    catch: unknownError,
    try: () => {
      const descriptor = fs.openSync(path, 'r')
      try {
        return heldFile(descriptor)
      } catch (error) {
        fs.closeSync(descriptor)
        throw error
      }
    },
  })

/**
 * Unlike {@link withHeldFile} this handle is deliberately not scoped: the descriptor is a
 * cross-process lock that must outlive the effect taking it, so the caller owns `closeHeldFile`.
 * Acquire it inside an uninterruptible region, or interruption can strand the descriptor before
 * the caller's release is installed.
 */
export const createHeldFile = ({ path, content }: { path: string; content: string }): Effect.Effect<HeldFile, Cause.UnknownError> =>
  Effect.try({
    catch: unknownError,
    try: () => {
      const descriptor = fs.openSync(path, 'wx')
      try {
        fs.writeFileSync(descriptor, content)
        return heldFile(descriptor, content)
      } catch (error) {
        fs.closeSync(descriptor)
        try {
          fs.unlinkSync(path)
        } catch {
          /* The partial file is unreachable anyway; the original failure is what matters. */
        }
        throw error
      }
    },
  })

export const heldFileContent = (handle: HeldFile): string => stateOf(handle).content

export const closeHeldFile = (handle: HeldFile): void => {
  const state = heldFiles.get(handle)
  if (state !== undefined) {
    heldFiles.delete(handle)
    fs.closeSync(state.descriptor)
  }
}

/**
 * Descriptors are closed by the release step, so interruption between opening the file and the
 * caller's own error handling cannot leak one.
 */
export const withHeldFile = <Value, Failure, Services>(
  path: string,
  use: (handle: HeldFile) => Effect.Effect<Value, Failure, Services>
): Effect.Effect<Value, Failure | Cause.UnknownError, Services> =>
  Effect.acquireUseRelease(openHeldFile(path), use, (handle) => Effect.sync(() => closeHeldFile(handle)))

const revalidateAndRemoveHeldFile = ({
  path,
  handle,
  contentMatches,
}: {
  path: string
  handle: HeldFile
  contentMatches: (content: string) => boolean
}): boolean => {
  const held = stateOf(handle)
  let currentDescriptor: number | undefined
  try {
    currentDescriptor = fs.openSync(path, 'r')
  } catch (error) {
    if (isMissingPathError(error)) {
      return false
    }
    throw error
  }
  try {
    const currentStat = fs.fstatSync(currentDescriptor)
    if (held.stat.dev !== currentStat.dev || held.stat.ino !== currentStat.ino) {
      return false
    }
    if (!contentMatches(readHeldContent(currentDescriptor, currentStat.size))) {
      return false
    }
    // Ponytail: check-then-unlink syscall ceiling; use an OS advisory lock or transactional store if hostile replacement after final validation must be fenced.
    fs.unlinkSync(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) {
      return false
    }
    throw error
  } finally {
    fs.closeSync(currentDescriptor)
  }
}

export const removeHeldFileIfUnchanged = ({
  path,
  handle,
  contentMatches,
  beforeRevalidate,
}: {
  path: string
  handle: HeldFile
  contentMatches: (content: string) => boolean
  beforeRevalidate?: (path: string) => Effect.Effect<void, Cause.UnknownError>
}): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.gen(function* () {
    if (beforeRevalidate !== undefined) {
      yield* beforeRevalidate(path)
    }
    return yield* Effect.try({ catch: unknownError, try: () => revalidateAndRemoveHeldFile({ contentMatches, handle, path }) })
  })
