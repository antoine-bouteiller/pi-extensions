import { createHash } from 'node:crypto'

import { Cause, Context, Effect, Layer, Stream } from 'effect'
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
export interface ProcessProbeApi {
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

const inspectLinuxProcess = (probe: ProcessProbeApi, pid: number, token?: string): Effect.Effect<ProcessSnapshot | undefined, Cause.UnknownError> =>
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
    const snapshot: ProcessSnapshot = { identity: `linux:${startTicks}:${hashIdentity(commandLine)}` }
    if (isNotNullOrUndefined(token) && isNotEmptyString(token)) {
      snapshot.tokenMatches = environment === undefined ? false : Buffer.from(environment).includes(Buffer.from(`PI_SUBAGENT_OWNER_TOKEN=${token}\0`))
    }
    return snapshot
  })

const inspectWindowsProcess = (probe: ProcessProbeApi, pid: number): Effect.Effect<ProcessSnapshot | undefined, Cause.UnknownError> =>
  Effect.gen(function* () {
    const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { [Console]::Out.Write($p.CreationDate.ToUniversalTime().Ticks.ToString() + [char]0 + $p.CommandLine) }`
    const result = yield* probeResult(() => probe.runPowerShell(script))
    const output = result.status === 0 ? result.stdout : ''
    return isNotEmptyString(output) ? { identity: `windows:${hashIdentity(output)}` } : undefined
  })

const inspectUnixProcess = (probe: ProcessProbeApi, pid: number, token?: string): Effect.Effect<ProcessSnapshot | undefined, Cause.UnknownError> =>
  Effect.gen(function* () {
    // Darwin does not reliably expose another process's environment through ps, even to its parent.
    const canVerifyToken = probe.platform !== 'darwin'
    const result = yield* probeResult(() => probe.runPs([canVerifyToken ? 'eww' : 'ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command=']))
    const output = result.status === 0 ? result.stdout.trim() : ''
    if (isEmptyString(output)) {
      return undefined
    }
    const snapshot: ProcessSnapshot = { identity: `unix:${hashIdentity(output)}` }
    if (isNotNullOrUndefined(token) && isNotEmptyString(token) && canVerifyToken) {
      snapshot.tokenMatches = output.includes(`PI_SUBAGENT_OWNER_TOKEN=${token}`)
    }
    return snapshot
  })

/**
 * Return an identity tied to a process lifetime, not only its PID. A failed probe (EACCES,
 * an unreadable /proc entry, a `ps` that could not run) stays in the error channel: callers
 * that decide whether to reclaim a lock or kill a process must not read it as "process gone".
 */
type ProcessInspect = (pid: number, token?: string) => Effect.Effect<ProcessSnapshot | undefined, Cause.UnknownError>

const inspectProcessWith =
  (probe: ProcessProbeApi): ProcessInspect =>
  (pid, token) =>
    Effect.gen(function* () {
      if (!(yield* probeResult(() => probe.processAlive(pid)))) {
        return undefined
      }
      if (probe.platform === 'linux') {
        return yield* inspectLinuxProcess(probe, pid, token)
      }
      return yield* probe.platform === 'win32' ? inspectWindowsProcess(probe, pid) : inspectUnixProcess(probe, pid, token)
    })

/**
 * `unverifiable` is deliberately distinct from `match`: a failed probe must keep the ownership
 * record alive, but it must never authorise a signal. PIDs are reused, so signalling a process
 * whose identity could not be read can kill an unrelated process or process group.
 */
export type OwnershipVerdict = 'match' | 'mismatch' | 'unverifiable'

const ownershipVerdictWith = (inspect: ProcessInspect, ownership: ProcessOwnership): Effect.Effect<OwnershipVerdict> =>
  inspect(ownership.pid, ownership.token).pipe(
    Effect.map((snapshot): OwnershipVerdict =>
      snapshot?.identity === ownership.processIdentity && !isFalse(snapshot.tokenMatches) ? 'match' : 'mismatch'
    ),
    Effect.orElseSucceed((): OwnershipVerdict => 'unverifiable')
  )

const processOwnerIsActiveWith = (inspect: ProcessInspect, owner: { pid?: number; processIdentity?: string }): Effect.Effect<boolean> => {
  if (typeof owner.pid !== 'number') {
    return Effect.succeed(false)
  }
  return inspect(owner.pid).pipe(
    Effect.map(
      (snapshot) =>
        isNotNullOrUndefined(snapshot) &&
        (isNullOrUndefined(owner.processIdentity) || isEmptyString(owner.processIdentity) || snapshot.identity === owner.processIdentity)
    ),
    Effect.orElseSucceed(() => true)
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

/**
 * A probe that could not run is a failure, not an absent process: succeeding with empty output
 * would let a spawn error or timeout be read as "this process is gone" and reclaim a live lock.
 */
const runCommand = (command: string, args: string[]): Effect.Effect<{ status: number | undefined; stdout: string }, Cause.UnknownError> =>
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
    Effect.timeoutOrElse({ duration: 3000, orElse: () => Effect.fail(processProbeError(new Error(`${command} probe timed out`))) }),
    Effect.mapError(processProbeError)
  )

export const nodeProcessProbe = {
  platform: process.platform,
  processAlive,
  readFileBuffer: (path) => bunFileSystem.readFile(path).pipe(Effect.mapError(processProbeError)),
  readFileUtf8: (path) => bunFileSystem.readFileString(path).pipe(Effect.mapError(processProbeError)),
  runPowerShell: (script) => runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]),
  runPs: (args: string[]) => runCommand('ps', args),
} satisfies ProcessProbeApi

export const inspectProcess = (pid: number, token?: string): Effect.Effect<ProcessSnapshot | undefined> =>
  inspectProcessWith(nodeProcessProbe)(pid, token).pipe(Effect.orElseSucceed(() => undefined))

export const ownershipVerdict = (ownership: ProcessOwnership): Effect.Effect<OwnershipVerdict> =>
  ownershipVerdictWith(inspectProcessWith(nodeProcessProbe), ownership)

/** Legacy lock records have only a PID and remain active conservatively while that process lives. */
export const processOwnerIsActive = (owner: { pid?: number; processIdentity?: string }): Effect.Effect<boolean> =>
  processOwnerIsActiveWith(inspectProcessWith(nodeProcessProbe), owner)

export interface ProcessInspectorApi {
  readonly inspect: (pid: number, token?: string) => Effect.Effect<ProcessSnapshot | undefined>
  readonly alive: (pid: number) => Effect.Effect<boolean>
  readonly ownershipVerdict: (ownership: ProcessOwnership) => Effect.Effect<OwnershipVerdict>
  readonly ownerIsActive: (owner: { pid?: number; processIdentity?: string }) => Effect.Effect<boolean>
}

export class ProcessInspector extends Context.Service<ProcessInspector, ProcessInspectorApi>()(
  'pi-extensions/features/sub_agents/process_ownership/ProcessInspector'
) {}

export const processInspectorFromProbe = (probe: ProcessProbeApi): ProcessInspectorApi => {
  const inspect = inspectProcessWith(probe)
  return {
    alive: (pid) => probeResult(() => probe.processAlive(pid)).pipe(Effect.orElseSucceed(() => false)),
    inspect: (pid, token) => inspect(pid, token).pipe(Effect.orElseSucceed(() => undefined)),
    ownerIsActive: (owner) => processOwnerIsActiveWith(inspect, owner),
    ownershipVerdict: (ownership) => ownershipVerdictWith(inspect, ownership),
  }
}

export const ProcessInspectorLive: Layer.Layer<ProcessInspector> = Layer.succeed(ProcessInspector)(processInspectorFromProbe(nodeProcessProbe))
