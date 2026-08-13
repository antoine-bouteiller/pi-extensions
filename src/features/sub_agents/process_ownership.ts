import { createHash } from 'node:crypto'

import { Context, Effect, Function, Layer } from 'effect'

import { hostFileSystemSync } from '@/shared/effect/bun_host_file_system.js'
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

export const processAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

const hashIdentity = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

/**
 * The OS-level primitives `inspectProcess` depends on, factored out so tests can drive the
 * Linux/Windows/Unix branches deterministically on any host instead of only the one they run on.
 */
export interface ProcessProbeShape {
  readonly platform: NodeJS.Platform
  readonly processAlive: (pid: number) => boolean
  readonly readFileUtf8: (path: string) => string
  readonly readFileBuffer: (path: string) => Buffer
  readonly runPowerShell: (script: string) => { status: number | undefined; stdout: string }
  readonly runPs: (args: string[]) => { status: number | undefined; stdout: string }
}

const inspectLinuxProcess = (probe: ProcessProbeShape, pid: number, token?: string): ProcessSnapshot | undefined => {
  const stat = probe.readFileUtf8(`/proc/${pid}/stat`)
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const startTicks = fields.at(19)
  const commandLine = probe.readFileBuffer(`/proc/${pid}/cmdline`)
  if (isNullOrUndefined(startTicks) || isEmptyString(startTicks) || commandLine.length === 0) {
    return undefined
  }
  const environment = isNotNullOrUndefined(token) && isNotEmptyString(token) ? probe.readFileBuffer(`/proc/${pid}/environ`) : undefined
  return {
    identity: `linux:${startTicks}:${hashIdentity(commandLine)}`,
    ...(isNotNullOrUndefined(token) && isNotEmptyString(token)
      ? {
          tokenMatches: environment?.includes(Buffer.from(`PI_SUBAGENT_OWNER_TOKEN=${token}\0`)) ?? false,
        }
      : {}),
  }
}

const inspectWindowsProcess = (probe: ProcessProbeShape, pid: number): ProcessSnapshot | undefined => {
  const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { [Console]::Out.Write($p.CreationDate.ToUniversalTime().Ticks.ToString() + [char]0 + $p.CommandLine) }`
  const result = probe.runPowerShell(script)
  const output = result.status === 0 ? result.stdout : ''
  return isNotEmptyString(output) ? { identity: `windows:${hashIdentity(output)}` } : undefined
}

const inspectUnixProcess = (probe: ProcessProbeShape, pid: number, token?: string): ProcessSnapshot | undefined => {
  // Darwin does not reliably expose another process's environment through ps, even to its parent.
  const canVerifyToken = probe.platform !== 'darwin'
  const result = probe.runPs([canVerifyToken ? 'eww' : 'ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='])
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
}

/**
 * Return an identity tied to a particular process lifetime, not just its PID.
 * The optional token additionally proves that this extension launched the process
 * on platforms where another process's environment can be inspected reliably.
 */
const inspectProcessWith =
  (probe: ProcessProbeShape) =>
  (pid: number, token?: string): ProcessSnapshot | undefined => {
    if (!probe.processAlive(pid)) {
      return undefined
    }
    try {
      if (probe.platform === 'linux') {
        return inspectLinuxProcess(probe, pid, token)
      }
      if (probe.platform === 'win32') {
        return inspectWindowsProcess(probe, pid)
      }
      return inspectUnixProcess(probe, pid, token)
    } catch {
      return undefined
    }
  }

const ownershipMatchesWith = (inspect: (pid: number, token?: string) => ProcessSnapshot | undefined, ownership: ProcessOwnership): boolean => {
  const snapshot = inspect(ownership.pid, ownership.token)
  return snapshot?.identity === ownership.processIdentity && !isFalse(snapshot.tokenMatches)
}

const processOwnerIsActiveWith = (
  inspect: (pid: number, token?: string) => ProcessSnapshot | undefined,
  owner: { pid?: number; processIdentity?: string }
): boolean => {
  if (typeof owner.pid !== 'number') {
    return false
  }
  const snapshot = inspect(owner.pid)
  return (
    isNotNullOrUndefined(snapshot) &&
    (isNullOrUndefined(owner.processIdentity) || isEmptyString(owner.processIdentity) || snapshot.identity === owner.processIdentity)
  )
}

const runCommand = (command: string, args: string[]): { status: number | undefined; stdout: string } => {
  try {
    const result = Bun.spawnSync([command, ...args], { stderr: 'ignore', stdout: 'pipe', timeout: 3000 })
    return { status: result.exitCode, stdout: result.stdout.toString() }
  } catch {
    return { status: undefined, stdout: '' }
  }
}

const runPowerShellScript = (script: string): { status: number | undefined; stdout: string } =>
  runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])

const runPsCommand = (args: string[]): { status: number | undefined; stdout: string } => runCommand('ps', args)

export const nodeProcessProbe: ProcessProbeShape = {
  platform: process.platform,
  processAlive,
  readFileBuffer: (path) => hostFileSystemSync.readFile(path),
  readFileUtf8: (path) => hostFileSystemSync.readFile(path, 'utf8'),
  runPowerShell: runPowerShellScript,
  runPs: runPsCommand,
}

export const inspectProcess: {
  (token: string | undefined): (pid: number) => ProcessSnapshot | undefined
  (pid: number, token?: string): ProcessSnapshot | undefined
} = Function.dual(
  (args) => typeof args[0] === 'number',
  (pid: number, token?: string): ProcessSnapshot | undefined => inspectProcessWith(nodeProcessProbe)(pid, token)
)

export const ownershipMatches = (ownership: ProcessOwnership): boolean => ownershipMatchesWith(inspectProcess, ownership)

/** Legacy lock records have only a PID and are treated conservatively while it is alive. */
export const processOwnerIsActive = (owner: { pid?: number; processIdentity?: string }): boolean => processOwnerIsActiveWith(inspectProcess, owner)

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
    alive: (pid) => Effect.sync(() => probe.processAlive(pid)),
    inspect: (pid, token) => Effect.sync(() => inspect(pid, token)),
    ownerIsActive: (owner) => Effect.sync(() => processOwnerIsActiveWith(inspect, owner)),
    ownershipMatches: (ownership) => Effect.sync(() => ownershipMatchesWith(inspect, ownership)),
  }
}

export const ProcessInspectorLive: Layer.Layer<ProcessInspector> = Layer.succeed(ProcessInspector)(processInspectorFromProbe(nodeProcessProbe))
