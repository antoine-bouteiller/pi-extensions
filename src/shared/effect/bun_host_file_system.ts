/* oxlint-disable effecttsgo/node-builtin-import -- Effect FileSystem lacks no-follow metadata, typed directory entries, and descriptor identity operations required for safe deletion and cross-process locks. */
import fs from 'node:fs'

import { Cause, Effect } from 'effect'

const unknownError = (cause: unknown): Cause.UnknownError =>
  Cause.isUnknownError(cause) ? cause : new Cause.UnknownError(cause, cause instanceof Error ? cause.message : String(cause))

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

const heldFile = (descriptor: number, content = fs.readFileSync(descriptor, 'utf8')): HeldFile => {
  const handle = { [HeldFileTypeId]: true } as const
  heldFiles.set(handle, {
    content,
    descriptor,
    stat: fs.fstatSync(descriptor),
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
    const currentStat = fs.fstatSync(currentDescriptor)
    const currentContent = fs.readFileSync(currentDescriptor, 'utf8')
    if (held.stat.dev !== currentStat.dev || held.stat.ino !== currentStat.ino || !contentMatches(currentContent)) {
      return false
    }
    // Ponytail: check-then-unlink syscall ceiling; use an OS advisory lock or transactional store if hostile replacement after final validation must be fenced.
    fs.unlinkSync(path)
    return true
  } catch {
    return false
  } finally {
    if (currentDescriptor !== undefined) {
      fs.closeSync(currentDescriptor)
    }
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
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (beforeRevalidate !== undefined) {
      yield* beforeRevalidate(path)
    }
    return revalidateAndRemoveHeldFile({ contentMatches, handle, path })
  }).pipe(Effect.orElseSucceed(() => false))
