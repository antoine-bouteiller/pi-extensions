import { dlopen, ptr } from 'bun:ffi'

import { Context, Data, Effect, Layer } from 'effect'

import { closeHostAppendFile, linuxProcessBirthMarker, openHostAppendFileSync } from '#shared/effect/bun_host_file_system'

import { type ProcessIdentity } from './store.js'

export { type ProcessIdentity } from './store.js'

class SpawnError extends Data.TaggedError('SubagentSpawnError')<{ readonly cause: unknown; readonly message: string }> {}
export class ProcessError extends Data.TaggedError('SubagentProcessError')<{ readonly cause: unknown; readonly message: string }> {}

export interface SpawnRequest {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly stderrPath?: string
}

export interface RunningChild {
  readonly closeInput: Effect.Effect<void, ProcessError>
  readonly identity: ProcessIdentity
  readonly isAlive: Effect.Effect<boolean>
  readonly readStdout: Effect.Effect<Uint8Array | undefined, ProcessError>
  readonly release: Effect.Effect<void, ProcessError>
  readonly wait: Effect.Effect<number>
  readonly write: (frame: string) => Effect.Effect<void, ProcessError>
}

export type TerminationResult = 'exited' | 'mismatch' | 'signalled' | 'stillAlive' | 'unverifiable'
export interface ChildProcessApi {
  readonly interruptVerified: (child: RunningChild, interruptFrame: string) => Effect.Effect<void, ProcessError>
  readonly spawn: (request: SpawnRequest) => Effect.Effect<RunningChild, SpawnError>
  readonly terminateVerified: (identity: ProcessIdentity) => Effect.Effect<TerminationResult, ProcessError>
}
export class ChildProcess extends Context.Service<ChildProcess, ChildProcessApi>()('pi-extensions/features/sub_agents/process/ChildProcess') {}

export interface ProcessPlatform {
  readonly birthMarker: (pid: number) => Effect.Effect<string | undefined, ProcessError>
  readonly forceTerminate: (pid: number) => Effect.Effect<void, ProcessError>
  readonly spawn: (request: SpawnRequest) => Effect.Effect<PlatformChild, SpawnError>
}

export interface PlatformChild {
  readonly closeInput: Effect.Effect<void, ProcessError>
  readonly isAlive: () => boolean
  readonly pid: number
  readonly readStdout: Effect.Effect<Uint8Array | undefined, ProcessError>
  readonly release: Effect.Effect<void, ProcessError>
  readonly wait: Effect.Effect<number>
  readonly write: (frame: string) => Effect.Effect<void, ProcessError>
}

const failure = <Failure extends SpawnError | ProcessError>(
  Type: new (fields: { cause: unknown; message: string }) => Failure,
  cause: unknown
): Failure => new Type({ cause, message: cause instanceof Error ? cause.message : String(cause) })

export const macosProcessBirthMarker = (pid: number): string | undefined => {
  const info = new Uint8Array(136)
  const library = dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: { args: ['i32', 'u32', 'u64', 'ptr', 'i32'], returns: 'i32' },
  })
  try {
    const written = library.symbols.proc_pidinfo(pid, 3, 0, ptr(info), info.byteLength)
    if (written < 136) {
      return undefined
    }
    const view = new DataView(info.buffer)
    // Proc_bsdinfo has pbi_start_tvsec at byte 120 and pbi_start_tvusec at byte 128.
    return `${view.getBigUint64(120, true)}:${view.getBigUint64(128, true)}`
  } catch {
    return undefined
  } finally {
    library.close()
  }
}

const productionMarker = (pid: number): Effect.Effect<string | undefined, ProcessError> => {
  if (process.platform === 'linux') {
    return Effect.succeed(linuxProcessBirthMarker(pid))
  }
  if (process.platform === 'darwin') {
    return Effect.succeed(macosProcessBirthMarker(pid))
  }
  return Effect.void.pipe(Effect.as(undefined))
}

const productionPlatform: ProcessPlatform = {
  birthMarker: productionMarker,
  forceTerminate: (pid) =>
    Effect.try({
      catch: (cause) => failure(ProcessError, cause),
      try: () => {
        if (process.platform === 'win32') {
          throw new Error('Windows sub-agent process handling is unsupported')
        }
        process.kill(-pid, 'SIGKILL')
      },
    }),
  spawn: (request) =>
    Effect.try({
      catch: (cause) => failure(SpawnError, cause),
      try: () => {
        if (process.platform === 'win32') {
          throw new Error('Windows sub-agent process handling is unsupported')
        }
        const stderr = request.stderrPath === undefined ? undefined : openHostAppendFileSync(request.stderrPath)
        const subprocess = (() => {
          try {
            return Bun.spawn({
              cmd: [request.command, ...request.args],
              cwd: request.cwd,
              detached: true,
              env: request.environment,
              stderr: stderr === undefined ? 'ignore' : stderr.descriptor,
              stdin: 'pipe',
              stdout: 'pipe',
            })
          } catch (error) {
            if (stderr !== undefined) {
              closeHostAppendFile(stderr)
            }
            throw error
          }
        })()
        let stdout: ReadableStreamDefaultReader<Uint8Array> | undefined
        try {
          stdout = subprocess.stdout.getReader()
          const reader = stdout
          const closeInput = Effect.tryPromise({
            catch: (cause) => failure(ProcessError, cause),
            try: () => Promise.resolve(subprocess.stdin.end()),
          })
          return {
            closeInput,
            isAlive: () => subprocess.exitCode === null,
            pid: subprocess.pid,
            readStdout: Effect.tryPromise({
              catch: (cause) => failure(ProcessError, cause),
              try: () => reader.read().then(({ done, value }) => (done ? undefined : value)),
            }),
            release: Effect.try({
              catch: (cause) => failure(ProcessError, cause),
              try: () => {
                reader.releaseLock()
                if (stderr !== undefined) {
                  closeHostAppendFile(stderr)
                }
              },
            }),
            wait: Effect.promise(() => subprocess.exited),
            write: (frame) =>
              Effect.tryPromise({
                catch: (cause) => failure(ProcessError, cause),
                try: () => Promise.resolve(subprocess.stdin.write(frame)).then(() => subprocess.stdin.flush()),
              }),
          }
        } catch (error) {
          void subprocess.stdin.end()
          void subprocess.exited
          stdout?.releaseLock()
          if (stderr !== undefined) {
            closeHostAppendFile(stderr)
          }
          throw error
        }
      },
    }),
}

const verified = (platform: ProcessPlatform, child: RunningChild): Effect.Effect<boolean, ProcessError> =>
  Effect.gen(function* () {
    if (!(yield* child.isAlive)) {
      return false
    }
    const marker = yield* platform.birthMarker(child.identity.pid)
    return marker !== undefined && marker === child.identity.birthMarker
  })

const terminate = (platform: ProcessPlatform, identity: ProcessIdentity): Effect.Effect<TerminationResult, ProcessError> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || identity.birthMarker.length === 0) {
      return 'unverifiable'
    }
    const marker = yield* platform.birthMarker(identity.pid)
    if (marker === undefined) {
      return 'unverifiable'
    }
    if (marker !== identity.birthMarker) {
      return 'mismatch'
    }
    const signalled = yield* platform.forceTerminate(identity.pid).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    )
    if (!signalled) {
      return 'stillAlive'
    }
    const finalMarker = yield* platform.birthMarker(identity.pid)
    if (finalMarker === identity.birthMarker) {
      return 'stillAlive'
    }
    return 'signalled'
  })

export const makeChildProcessLive = (platform: ProcessPlatform = productionPlatform): Layer.Layer<ChildProcess> =>
  Layer.succeed(ChildProcess)({
    interruptVerified: (child, interruptFrame) =>
      Effect.ensuring(
        Effect.gen(function* () {
          yield* child.write(interruptFrame)
          yield* child.closeInput
          const exited = yield* Effect.race(Effect.as(child.wait, true), Effect.as(Effect.sleep('5 seconds'), false))
          if (!exited && (yield* verified(platform, child))) {
            yield* platform.forceTerminate(child.identity.pid)
          }
        }),
        child.release.pipe(Effect.ignore)
      ),
    spawn: (request) =>
      Effect.gen(function* () {
        const child = yield* platform.spawn(request)
        const captured = yield* Effect.result(platform.birthMarker(child.pid))
        if (captured._tag === 'Failure' || captured.success === undefined) {
          yield* Effect.ensuring(
            Effect.gen(function* () {
              yield* child.closeInput.pipe(Effect.ignore)
              yield* Effect.race(child.wait.pipe(Effect.ignore), Effect.sleep('5 seconds'))
            }),
            child.release.pipe(Effect.ignore)
          )
          return yield* failure(SpawnError, new Error('Process identity is unverifiable'))
        }
        return {
          closeInput: child.closeInput,
          identity: { birthMarker: captured.success, pid: child.pid },
          isAlive: Effect.sync(child.isAlive),
          readStdout: child.readStdout,
          release: child.release,
          wait: child.wait,
          write: child.write,
        }
      }),
    terminateVerified: (identity) => terminate(platform, identity),
  })

export const ChildProcessLive: Layer.Layer<ChildProcess> = makeChildProcessLive()
