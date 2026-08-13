import { createHash } from 'node:crypto'

import { Cause, Context, Effect, Function, Layer, Stream } from 'effect'
import { type PlatformError } from 'effect/PlatformError'
import { ChildProcess } from 'effect/unstable/process'

import { bunChildProcessSpawner, bunFileSystem } from '@/shared/effect/bun_services.js'
import { isEmptyString, isFalse, isNotEmptyString, isNotNullOrUndefined, isNullOrUndefined } from '@/shared/utils/predicates.js'

export interface ProcessSnapshot {
  identity: string
  tokenMatches?: boolean
}

export interface ProcessOwnership {
  pid: number
  processIdentity: string
  token: string
}

export const processAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return false
    }
    try {
      process.kill(pid, 0)
      return true
    } catch (error: unknown) {
      return error instanceof Error && 'code' in error && error.code === 'EPERM'
    }
  })

const hashIdentity = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

const processProbeError = (cause: unknown): Cause.UnknownError =>
  Cause.isUnknownError(cause) ? cause : new Cause.UnknownError(cause, cause instanceof Error ? cause.message : String(cause))

type ProbeResult<Value> = Value | Effect.Effect<Value, Cause.UnknownError>

/** OS primitives are injectable so every platform branch remains deterministic in tests. */
export interface ProcessProbeShape {
  readonly platform: NodeJS.Platform
  readonly processAlive: (pid: number) => ProbeResult<boolean>
  readonly readFileUtf8: (path: string) => ProbeResult<string>
  readonly readFileBuffer: (path: string) => ProbeResult<Uint8Array>
  readonly runPowerShell: (script: string) => ProbeResult<{ status: number | undefined; stdout: string }>
  readonly runPs: (args: string[]) => ProbeResult<{ status: number | undefined; stdout: string }>
}

const probeResult = <Value>(evaluate: () => ProbeResult<Value>): Effect.Effect<Value, Cause.UnknownError> =>
  Effect.try({ catch: processProbeError, try: evaluate }).pipe(
    Effect.flatMap((result) => (Effect.isEffect(result) ? result : Effect.succeed(result)))
  )

const inspectLinuxProcess = (probe: ProcessProbeShape, pid: number, token?: string): Effect.Effect<ProcessSnapshot | undefined, Cause.UnknownError> =>
  Effect.gen(function* () {
    const stat = yield* probeResult(() => probe.readFileUtf8(`/proc/${pid}/stat`))
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const startTicks = fields.at(19)
    const commandLine = yield* probeResult(() => probe.readFileBuffer(`/proc/${pid}/cmdline`))
    if (isNullOrUndefined(startTicks) || isEmptyString(startTicks) || commandLine.length === 0) {
      return undefined
    }
    const environment =
      isNotNullOrUndefined(token) && isNotEmptyString(token) ? yield* probeResult(() => probe.readFileBuffer(`/proc/${pid}/environ`)) : undefined
    return {
      identity: `linux:${startTicks}:${hashIdentity(commandLine)}`,
      ...(isNotNullOrUndefined(token) && isNotEmptyString(token)
        ? {
            tokenMatches: environment === undefined ? false : Buffer.from(environment).includes(Buffer.from(`PI_SUBAGENT_OWNER_TOKEN=${token}\0`)),
          }
        : {}),
    }
  })

const inspectWindowsProcess = (probe: ProcessProbeShape, pid: number): Effect.Effect<ProcessSnapshot | undefined, Cause.UnknownError> =>
  Effect.gen(function* () {
    const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { [Console]::Out.Write($p.CreationDate.ToUniversalTime().Ticks.ToString() + [char]0 + $p.CommandLine) }`
    const result = yield* probeResult(() => probe.runPowerShell(script))
    const output = result.status === 0 ? result.stdout : ''
    return isNotEmptyString(output) ? { identity: `windows:${hashIdentity(output)}` } : undefined
  })

const inspectUnixProcess = (probe: ProcessProbeShape, pid: number, token?: string): Effect.Effect<ProcessSnapshot | undefined, Cause.UnknownError> =>
  Effect.gen(function* () {
    // Darwin does not reliably expose another process's environment through ps, even to its parent.
    const canVerifyToken = probe.platform !== 'darwin'
    const result = yield* probeResult(() => probe.runPs([canVerifyToken ? 'eww' : 'ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command=']))
    const output = result.status === 0 ? result.stdout.trim() : ''
    if (isEmptyString(output)) {
      return undefined
    }
    return {
      identity: `unix:${hashIdentity(output)}`,
      ...(isNotNullOrUndefined(token) && isNotEmptyString(token) && canVerifyToken
        ? { tokenMatches: output.includes(`PI_SUBAGENT_OWNER_TOKEN=${token}`) }
        : {}),
    }
  })

/** Return an identity tied to a process lifetime, not only its PID. */
const inspectProcessWith =
  (probe: ProcessProbeShape) =>
  (pid: number, token?: string): Effect.Effect<ProcessSnapshot | undefined> =>
    Effect.gen(function* () {
      if (!(yield* probeResult(() => probe.processAlive(pid)))) {
        return undefined
      }
      if (probe.platform === 'linux') {
        return yield* inspectLinuxProcess(probe, pid, token)
      }
      return yield* probe.platform === 'win32' ? inspectWindowsProcess(probe, pid) : inspectUnixProcess(probe, pid, token)
    }).pipe(Effect.orElseSucceed(() => undefined))

const ownershipMatchesWith = (
  inspect: (pid: number, token?: string) => Effect.Effect<ProcessSnapshot | undefined>,
  ownership: ProcessOwnership
): Effect.Effect<boolean> =>
  inspect(ownership.pid, ownership.token).pipe(
    Effect.map((snapshot) => snapshot?.identity === ownership.processIdentity && !isFalse(snapshot.tokenMatches))
  )

const processOwnerIsActiveWith = (
  inspect: (pid: number, token?: string) => Effect.Effect<ProcessSnapshot | undefined>,
  owner: { pid?: number; processIdentity?: string }
): Effect.Effect<boolean> => {
  if (typeof owner.pid !== 'number') {
    return Effect.succeed(false)
  }
  return inspect(owner.pid).pipe(
    Effect.map(
      (snapshot) =>
        isNotNullOrUndefined(snapshot) &&
        (isNullOrUndefined(owner.processIdentity) || isEmptyString(owner.processIdentity) || snapshot.identity === owner.processIdentity)
    )
  )
}

const collectStdout = (stream: Stream.Stream<Uint8Array, PlatformError>): Effect.Effect<string, Cause.UnknownError> =>
  Stream.runFold(
    stream,
    (): Uint8Array[] => [],
    (chunks, chunk) => [...chunks, chunk]
  ).pipe(
    Effect.map((chunks) => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString()),
    Effect.mapError(processProbeError)
  )

const runCommand = (command: string, args: string[]): Effect.Effect<{ status: number | undefined; stdout: string }> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* bunChildProcessSpawner.spawn(
        ChildProcess.make(command, args, { detached: false, forceKillAfter: 1000, stderr: 'ignore', stdin: 'ignore', stdout: 'pipe' })
      )
      const { status, stdout } = yield* Effect.all(
        { status: child.exitCode.pipe(Effect.map(Number)), stdout: collectStdout(child.stdout) },
        { concurrency: 2 }
      )
      return { status, stdout }
    })
  ).pipe(
    Effect.timeoutOrElse({ duration: 3000, orElse: () => Effect.succeed({ status: undefined, stdout: '' }) }),
    Effect.orElseSucceed(() => ({ status: undefined, stdout: '' }))
  )

export const nodeProcessProbe = {
  platform: process.platform,
  processAlive,
  readFileBuffer: (path) => bunFileSystem.readFile(path).pipe(Effect.mapError(processProbeError)),
  readFileUtf8: (path) => bunFileSystem.readFileString(path).pipe(Effect.mapError(processProbeError)),
  runPowerShell: (script) => runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]),
  runPs: (args: string[]) => runCommand('ps', args),
} satisfies ProcessProbeShape

export const inspectProcess: {
  (token: string | undefined): (pid: number) => Effect.Effect<ProcessSnapshot | undefined>
  (pid: number, token?: string): Effect.Effect<ProcessSnapshot | undefined>
} = Function.dual(
  (args) => typeof args[0] === 'number',
  (pid: number, token?: string): Effect.Effect<ProcessSnapshot | undefined> => inspectProcessWith(nodeProcessProbe)(pid, token)
)

export const ownershipMatches = (ownership: ProcessOwnership): Effect.Effect<boolean> => ownershipMatchesWith(inspectProcess, ownership)

/** Legacy lock records have only a PID and remain active conservatively while that process lives. */
export const processOwnerIsActive = (owner: { pid?: number; processIdentity?: string }): Effect.Effect<boolean> =>
  processOwnerIsActiveWith(inspectProcess, owner)

export interface ProcessInspectorShape {
  readonly inspect: (pid: number, token?: string) => Effect.Effect<ProcessSnapshot | undefined>
  readonly alive: (pid: number) => Effect.Effect<boolean>
  readonly ownershipMatches: (ownership: ProcessOwnership) => Effect.Effect<boolean>
  readonly ownerIsActive: (owner: { pid?: number; processIdentity?: string }) => Effect.Effect<boolean>
}

export class ProcessInspector extends Context.Service<ProcessInspector, ProcessInspectorShape>()(
  'pi-extensions/features/sub_agents/process_ownership/ProcessInspector'
) {}

export const processInspectorFromProbe = (probe: ProcessProbeShape): ProcessInspectorShape => {
  const inspect = inspectProcessWith(probe)
  return {
    alive: (pid) => probeResult(() => probe.processAlive(pid)).pipe(Effect.orElseSucceed(() => false)),
    inspect,
    ownerIsActive: (owner) => processOwnerIsActiveWith(inspect, owner),
    ownershipMatches: (ownership) => ownershipMatchesWith(inspect, ownership),
  }
}

export const ProcessInspectorLive: Layer.Layer<ProcessInspector> = Layer.succeed(ProcessInspector)(processInspectorFromProbe(nodeProcessProbe))
