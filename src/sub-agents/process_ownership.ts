import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

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

const inspectLinuxProcess = (pid: number, token?: string): ProcessSnapshot | undefined => {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const startTicks = fields.at(19)
  const commandLine = readFileSync(`/proc/${pid}/cmdline`)
  if (!startTicks || !commandLine.length) {
    return undefined
  }
  const environment = token ? readFileSync(`/proc/${pid}/environ`) : undefined
  return {
    identity: `linux:${startTicks}:${hashIdentity(commandLine)}`,
    ...(token
      ? {
          tokenMatches: environment?.includes(Buffer.from(`PI_SUBAGENT_OWNER_TOKEN=${token}\0`)) ?? false,
        }
      : {}),
  }
}

const inspectWindowsProcess = (pid: number): ProcessSnapshot | undefined => {
  const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { [Console]::Out.Write($p.CreationDate.ToUniversalTime().Ticks.ToString() + [char]0 + $p.CommandLine) }`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 3000 })
  const output = result.status === 0 ? result.stdout : ''
  return output ? { identity: `windows:${hashIdentity(output)}` } : undefined
}

const inspectUnixProcess = (pid: number, token?: string): ProcessSnapshot | undefined => {
  // Darwin does not reliably expose another process's environment through ps, even to its parent.
  const canVerifyToken = process.platform !== 'darwin'
  const result = spawnSync('ps', [canVerifyToken ? 'eww' : 'ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
    encoding: 'utf8',
    timeout: 3000,
  })
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
export const inspectProcess = (pid: number, token?: string): ProcessSnapshot | undefined => {
  if (!processAlive(pid)) {
    return undefined
  }
  try {
    if (process.platform === 'linux') {
      return inspectLinuxProcess(pid, token)
    }
    if (process.platform === 'win32') {
      return inspectWindowsProcess(pid)
    }
    return inspectUnixProcess(pid, token)
  } catch {
    return undefined
  }
}

export const ownershipMatches = (ownership: ProcessOwnership): boolean => {
  const snapshot = inspectProcess(ownership.pid, ownership.token)
  return snapshot?.identity === ownership.processIdentity && snapshot.tokenMatches !== false
}

/** Legacy lock records have only a PID and are treated conservatively while it is alive. */
export const processOwnerIsActive = (owner: { pid?: number; processIdentity?: string }): boolean => {
  if (typeof owner.pid !== 'number') {
    return false
  }
  const snapshot = inspectProcess(owner.pid)
  return Boolean(snapshot && (!owner.processIdentity || snapshot.identity === owner.processIdentity))
}
