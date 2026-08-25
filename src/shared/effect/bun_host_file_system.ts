/* oxlint-disable effecttsgo/node-builtin-import -- Effect FileSystem lacks no-follow metadata, typed directory entries, and the unscoped descriptor ownership cross-process locks need. */
import fs from 'node:fs'
import nodePath from 'node:path'

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

export interface OwnerOnlyFileRead {
  readonly bytes: Uint8Array
  readonly size: number
}

export interface HostFilePermissions {
  readonly mode: number
}

export interface ReadOwnerOnlyFileOptions {
  /** Canonical containment root. The candidate must be below this directory. */
  readonly root: string
  readonly path: string
  readonly maxBytes: number
}

export interface ValidateWorkerSessionPathOptions {
  readonly expectedCanonicalPath?: string
  readonly expectedDir: string
  readonly mode: 'create' | 'open'
  readonly path: string
}

export type HostFileError = Cause.UnknownError

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

const isContained = (root: string, candidate: string): boolean => {
  const relative = nodePath.relative(root, candidate)
  return relative.length > 0 && !relative.startsWith(`..${nodePath.sep}`) && relative !== '..' && !nodePath.isAbsolute(relative)
}

/** Reject a lexical escape and every symlink component, including the supplied root itself. */
const noSymlinkComponent = (root: string, candidate: string): void => {
  const absoluteRoot = nodePath.resolve(root)
  const absoluteCandidate = nodePath.resolve(candidate)
  if (!isContained(absoluteRoot, absoluteCandidate)) {
    throw new Error('Artifact path is outside its run directory')
  }
  let current = absoluteRoot
  if (fs.lstatSync(current).isSymbolicLink()) {
    throw new Error('Artifact root is a symbolic link')
  }
  for (const component of nodePath.relative(absoluteRoot, absoluteCandidate).split(nodePath.sep)) {
    current = nodePath.join(current, component)
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Artifact path contains a symbolic link')
    }
  }
}

/** Resolve the object behind an already-open descriptor, never the attacker-controlled pathname. */
const openedPath = (descriptor: number): string => {
  if (process.platform === 'linux') {
    return fs.realpathSync(`/proc/self/fd/${descriptor}`)
  }
  if (process.platform === 'darwin') {
    return fs.realpathSync(`/dev/fd/${descriptor}`)
  }
  if (process.platform === 'win32') {
    throw new Error('Windows sub-agent artifact handling is unsupported')
  }
  throw new Error('Descriptor path resolution is unavailable on this platform')
}

const sameMetadata = (first: fs.Stats, second: fs.Stats): boolean =>
  first.dev === second.dev &&
  first.ino === second.ino &&
  first.uid === second.uid &&
  first.mode === second.mode &&
  first.size === second.size &&
  first.mtimeMs === second.mtimeMs &&
  first.ctimeMs === second.ctimeMs

const ownerOnly = (stat: fs.Stats): boolean => {
  const owner = typeof process.getuid === 'function' ? process.getuid() : undefined
  return stat.isFile() && (owner === undefined || stat.uid === owner) && (stat.mode & 0o077) === 0
}

/**
 * Opens a result artifact once with `O_NOFOLLOW`, validates that exact descriptor, and copies a
 * bounded value from it.  Reopening by pathname after validation would reintroduce the replacement
 * race this boundary exists to prevent.
 */
const readOwnerOnlyFileSync = ({ maxBytes, path, root }: ReadOwnerOnlyFileOptions): OwnerOnlyFileRead => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('maxBytes must be a non-negative safe integer')
  }
  const noFollow = fs.constants.O_NOFOLLOW
  if (typeof noFollow !== 'number') {
    throw new Error('O_NOFOLLOW is unavailable on this platform')
  }
  // Opening is deliberately first: every later pathname lookup is derived from this descriptor.
  noSymlinkComponent(root, path)
  const nonBlocking = fs.constants.O_NONBLOCK
  if (typeof nonBlocking !== 'number') {
    throw new Error('O_NONBLOCK is unavailable on this platform')
  }
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | noFollow | nonBlocking)
  try {
    const stat = fs.fstatSync(descriptor)
    const pathStat = fs.lstatSync(path)
    const canonicalRoot = fs.realpathSync(root)
    const canonicalOpened = openedPath(descriptor)
    if (!isContained(canonicalRoot, canonicalOpened)) {
      throw new Error('Artifact is outside its run directory')
    }
    if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      throw new Error('Artifact was replaced while opening')
    }
    if (!ownerOnly(stat)) {
      throw new Error('Artifact is not an owner-only regular file')
    }
    if (stat.size > maxBytes) {
      throw new Error(`Artifact is larger than ${maxBytes} bytes`)
    }
    const bytes = new Uint8Array(stat.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset)
      if (read === 0) {
        throw new Error('Artifact changed while reading')
      }
      offset += read
    }
    if (!sameMetadata(stat, fs.fstatSync(descriptor))) {
      throw new Error('Artifact changed while reading')
    }
    return { bytes, size: stat.size }
  } finally {
    fs.closeSync(descriptor)
  }
}

export const readOwnerOnlyFile = (options: ReadOwnerOnlyFileOptions): Effect.Effect<OwnerOnlyFileRead, Cause.UnknownError> =>
  Effect.try({ catch: unknownError, try: () => readOwnerOnlyFileSync(options) })

/**
 * Validates the exact object opened from a worker's reported session pathname.  The descriptor is
 * intentionally opened before any subsequent pathname check, so a replacement is detected rather
 * than validated by reopening its replacement.
 */
const noSymbolicLinkParent = (expectedDir: string, path: string): void => {
  let parent = nodePath.dirname(nodePath.resolve(path))
  while (parent !== nodePath.dirname(parent)) {
    if (fs.lstatSync(parent).isSymbolicLink()) {
      throw new Error('Worker session path contains a symbolic link')
    }
    if (fs.realpathSync(parent) === expectedDir) {
      return
    }
    parent = nodePath.dirname(parent)
  }
}

const validateWorkerSessionPathSync = ({ expectedCanonicalPath, expectedDir, mode, path }: ValidateWorkerSessionPathOptions) => {
  const noFollow = fs.constants.O_NOFOLLOW
  const nonBlocking = fs.constants.O_NONBLOCK
  if (typeof noFollow !== 'number' || typeof nonBlocking !== 'number') {
    throw new Error('Safe descriptor opening is unavailable on this platform')
  }
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | noFollow | nonBlocking)
  try {
    const stat = fs.fstatSync(descriptor)
    const canonicalPath = openedPath(descriptor)
    noSymbolicLinkParent(expectedDir, path)
    const pathStat = fs.lstatSync(path)
    if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      throw new Error('Worker session was replaced while opening')
    }
    if (!ownerOnly(stat)) {
      throw new Error('Worker session is not an owner-only regular file')
    }
    if (mode === 'create') {
      if (!isContained(expectedDir, canonicalPath)) {
        throw new Error('Worker session is outside its run directory')
      }
    } else if (expectedCanonicalPath === undefined || canonicalPath !== expectedCanonicalPath) {
      throw new Error('Worker session does not match the resumed session')
    }
    return { canonicalPath }
  } finally {
    fs.closeSync(descriptor)
  }
}

export const validateWorkerSessionPath = (
  options: ValidateWorkerSessionPathOptions
): Effect.Effect<{ readonly canonicalPath: string }, HostFileError> =>
  Effect.try({ catch: unknownError, try: () => validateWorkerSessionPathSync(options) })

const owner = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined)

const ensurePrivateDirectorySync = (path: string): void => {
  fs.mkdirSync(path, { mode: 0o700, recursive: true })
  const before = fs.lstatSync(path)
  if (!before.isDirectory() || before.isSymbolicLink() || (owner() !== undefined && before.uid !== owner())) {
    throw new Error('Directory is not owner-only')
  }
  fs.chmodSync(path, 0o700)
  const after = fs.lstatSync(path)
  if (!after.isDirectory() || after.isSymbolicLink() || (owner() !== undefined && after.uid !== owner()) || (after.mode & 0o077) !== 0) {
    throw new Error('Directory is not owner-only')
  }
}

export const ensurePrivateDirectory = (path: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.try({ catch: unknownError, try: () => ensurePrivateDirectorySync(path) })

const writePrivateFileSync = (path: string, content: string | Uint8Array): void => {
  const temporary = `${path}.${Bun.randomUUIDv7()}.tmp`
  try {
    const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
    try {
      fs.writeFileSync(descriptor, content)
      fs.fchmodSync(descriptor, 0o600)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.renameSync(temporary, path)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

export const writePrivateFile = (path: string, content: string | Uint8Array): Effect.Effect<void, Cause.UnknownError> =>
  Effect.try({ catch: unknownError, try: () => writePrivateFileSync(path, content) })

export const createPrivateFile = (path: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.try({
    catch: unknownError,
    try: () => {
      const descriptor = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
      fs.closeSync(descriptor)
    },
  })

/** Creates an exclusively-owned session file after validating its owner-only parent directory. */
export const createPrivateSessionFile = (directory: string): Effect.Effect<string, Cause.UnknownError> =>
  Effect.try({
    catch: unknownError,
    try: () => {
      ensurePrivateDirectorySync(directory)
      const path = nodePath.join(directory, `${Bun.randomUUIDv7()}.jsonl`)
      const descriptor = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
      fs.closeSync(descriptor)
      return path
    },
  })

/** Writes a result under an exclusive, owner-only random name and returns that basename. */
export const createPrivateSessionFilePromise = (directory: string): Promise<string> =>
  Promise.resolve()
    .then(() => ensurePrivateDirectorySync(directory))
    .then(() => {
      const path = nodePath.join(directory, `${Bun.randomUUIDv7()}.jsonl`)
      const descriptor = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
      fs.closeSync(descriptor)
      return path
    })

export const writePrivateUniqueFilePromise = (directory: string, extension: string, content: string | Uint8Array): Promise<string> =>
  Promise.resolve().then(() => {
    ensurePrivateDirectorySync(directory)
    const name = `${Bun.randomUUIDv7()}${extension}`
    const path = nodePath.join(directory, name)
    const descriptor = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
    try {
      fs.writeFileSync(descriptor, content)
      fs.fchmodSync(descriptor, 0o600)
    } finally {
      fs.closeSync(descriptor)
    }
    return name
  })

export const writePrivateUniqueFile = (
  directory: string,
  extension: string,
  content: string | Uint8Array
): Effect.Effect<string, Cause.UnknownError> =>
  Effect.try({
    catch: unknownError,
    try: () => {
      ensurePrivateDirectorySync(directory)
      const name = `${Bun.randomUUIDv7()}${extension}`
      const path = nodePath.join(directory, name)
      const descriptor = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
      try {
        fs.writeFileSync(descriptor, content)
        fs.fchmodSync(descriptor, 0o600)
      } finally {
        fs.closeSync(descriptor)
      }
      return name
    },
  })

export const removeHostPath = (path: string, recursive = false): Effect.Effect<void, Cause.UnknownError> =>
  Effect.try({ catch: unknownError, try: () => fs.rmSync(path, { force: true, recursive }) })

export const hostFilePermissions = (path: string): Effect.Effect<HostFilePermissions, Cause.UnknownError> =>
  Effect.try({ catch: unknownError, try: () => ({ mode: fs.statSync(path).mode & 0o777 }) })

export interface HostAppendFile {
  readonly descriptor: number
}

export const openHostAppendFileSync = (path: string): HostAppendFile => ({
  descriptor: fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_APPEND),
})

export const openHostAppendFile = (path: string): Effect.Effect<HostAppendFile, Cause.UnknownError> =>
  Effect.try({ catch: unknownError, try: () => openHostAppendFileSync(path) })

export const linuxProcessBirthMarker = (pid: number): string | undefined => {
  try {
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const startTicks = fields.at(19)
    if (boot.length === 0 || startTicks === undefined) {
      return undefined
    }
    return `${boot}:${startTicks}`
  } catch {
    return undefined
  }
}

export const closeHostAppendFile = (file: HostAppendFile): void => {
  fs.closeSync(file.descriptor)
}

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
