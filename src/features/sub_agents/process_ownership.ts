import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { Context, Effect, Layer } from 'effect'

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
  readonly runPowerShell: (script: string) => { status: number | null; stdout: string }
  readonly runPs: (args: string[]) => { status: number | null; stdout: string }
}

const inspectLinuxProcess = (probe: ProcessProbeShape, pid: number, token?: string): ProcessSnapshot | undefined => {
  const stat = probe.readFileUtf8(`/proc/${pid}/stat`)
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const startTicks = fields.at(19)
  const commandLine = probe.readFileBuffer(`/proc/${pid}/cmdline`)
  if (!startTicks || !commandLine.length) {
    return undefined
  }
  const environment = token ? probe.readFileBuffer(`/proc/${pid}/environ`) : undefined
  return {
    identity: `linux:${startTicks}:${hashIdentity(commandLine)}`,
    ...(token
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
  return output ? { identity: `windows:${hashIdentity(output)}` } : undefined
}

const inspectUnixProcess = (probe: ProcessProbeShape, pid: number, token?: string): ProcessSnapshot | undefined => {
  // Darwin does not reliably expose another process's environment through ps, even to its parent.
  const canVerifyToken = probe.platform !== 'darwin'
  const result = probe.runPs([canVerifyToken ? 'eww' : 'ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='])
  const output = result.status === 0 ? result.stdout.trim() : ''
  if (!output) {
    return undefined
  }
  return {
    identity: `unix:${hashIdentity(output)}`,
    ...(token && canVerifyToken ? { tokenMatches: output.includes(`PI_SUBAGENT_OWNER_TOKEN=${token}`) } : {}),
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
  return snapshot?.identity === ownership.processIdentity && snapshot.tokenMatches !== false
}

const processOwnerIsActiveWith = (
  inspect: (pid: number, token?: string) => ProcessSnapshot | undefined,
  owner: { pid?: number; processIdentity?: string }
): boolean => {
  if (typeof owner.pid !== 'number') {
    return false
  }
  const snapshot = inspect(owner.pid)
  return Boolean(snapshot && (!owner.processIdentity || snapshot.identity === owner.processIdentity))
}

const runPowerShellScript = (script: string): { status: number | null; stdout: string } => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 3000 })
  return { status: result.status, stdout: result.stdout }
}

const runPsCommand = (args: string[]): { status: number | null; stdout: string } => {
  const result = spawnSync('ps', args, { encoding: 'utf8', timeout: 3000 })
  return { status: result.status, stdout: result.stdout }
}

export const nodeProcessProbe: ProcessProbeShape = {
  platform: process.platform,
  processAlive,
  readFileBuffer: (path) => readFileSync(path),
  readFileUtf8: (path) => readFileSync(path, 'utf8'),
  runPowerShell: runPowerShellScript,
  runPs: runPsCommand,
}

export const inspectProcess = (pid: number, token?: string): ProcessSnapshot | undefined => inspectProcessWith(nodeProcessProbe)(pid, token)

export const ownershipMatches = (ownership: ProcessOwnership): boolean => ownershipMatchesWith(inspectProcess, ownership)

/** Legacy lock records have only a PID and are treated conservatively while it is alive. */
export const processOwnerIsActive = (owner: { pid?: number; processIdentity?: string }): boolean => processOwnerIsActiveWith(inspectProcess, owner)

export interface ProcessInspectorShape {
  readonly inspect: (pid: number, token?: string) => Effect.Effect<ProcessSnapshot | undefined>
  readonly alive: (pid: number) => Effect.Effect<boolean>
  readonly ownershipMatches: (ownership: ProcessOwnership) => Effect.Effect<boolean>
  readonly ownerIsActive: (owner: { pid?: number; processIdentity?: string }) => Effect.Effect<boolean>
}

export class ProcessInspector extends Context.Service<ProcessInspector, ProcessInspectorShape>()('@pi/ProcessInspector') {}

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
