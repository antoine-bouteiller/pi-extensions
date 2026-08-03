import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  createWriteStream,
  type Dirent,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { getAgentDir, type ThemeColor } from '@earendil-works/pi-coding-agent'
import { Clock, Deferred, Effect, Exit, HashMap, Option, Ref, Scope } from 'effect'
import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'

import { isRecord } from '../shared/records.js'
import {
  nodeProcessProbe,
  processAlive,
  processInspectorFromProbe,
  processOwnerIsActive,
  type ProcessInspectorShape,
  type ProcessSnapshot,
} from './process_ownership.js'
import {
  persistedProfileColor,
  resolveAgentConfig,
  THEME_COLOR_VALUES,
  THINKING_LEVELS,
  type AgentProfileName,
  type AvailableModel,
  type ThinkingLevel,
} from './profiles.js'
import { consumeFirstMatchingMailboxEvent, RpcJsonlDecoder } from './rpc.js'

export { consumeFirstMatchingMailboxEvent, RpcJsonlDecoder } from './rpc.js'

const PACKAGE_BASENAME = 'pi-codex-subagents'
const SUBAGENT_DIR = join(getAgentDir(), PACKAGE_BASENAME)
const CONFIG_PATH = join(SUBAGENT_DIR, 'config.json')
const TEMP_ROOT = join(process.env.PI_SUBAGENT_TEMP_DIR || tmpdir(), PACKAGE_BASENAME, userInfo().username)
const LEGACY_RUNS_DIR = join(TEMP_ROOT, 'runs')
const SOCKET_DIR = join(TEMP_ROOT, 'sockets')

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_RETENTION_DAYS = 7
const FINAL_STATUSES = new Set<AgentRuntimeStatus>(['completed', 'failed', 'interrupted'])

const AGENT_RUNTIME_STATUSES = ['starting', 'running', 'completed', 'failed', 'interrupted'] as const
export type AgentRuntimeStatus = (typeof AGENT_RUNTIME_STATUSES)[number]

const ThinkingLevelSchema = Type.Enum(THINKING_LEVELS)
const ThemeColorSchema = Type.Enum(THEME_COLOR_VALUES)
const AgentRuntimeStatusSchema = Type.Enum(AGENT_RUNTIME_STATUSES)

const ChildProcessOwnershipSchema = Type.Object({
  ownerPid: Type.Number(),
  ownerProcessIdentity: Type.Optional(Type.String()),
  pid: Type.Number(),
  processIdentity: Type.String(),
  startedAt: Type.Number(),
  token: Type.String(),
})

// Older on-disk records may predate a field added later; readInfoFile reconstructs those instead of rejecting the record.
const StoredAgentInfoSchema = Type.Object({
  agentType: Type.Optional(Type.String()),
  allowedTools: Type.Optional(Type.Array(Type.String())),
  canonicalName: Type.Optional(Type.String()),
  childProcess: Type.Optional(ChildProcessOwnershipSchema),
  closedAt: Type.Optional(Type.Number()),
  color: Type.Optional(ThemeColorSchema),
  completedAt: Type.Optional(Type.Number()),
  createdAt: Type.Number(),
  cwd: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  finalResponse: Type.Optional(Type.String()),
  id: Type.String(),
  infoFile: Type.Optional(Type.String()),
  isReadonly: Type.Optional(Type.Boolean()),
  lastActivity: Type.Optional(Type.Number()),
  lastTaskMessage: Type.Optional(Type.String()),
  logFile: Type.Optional(Type.String()),
  messageCount: Type.Optional(Type.Number()),
  model: Type.Optional(Type.String()),
  modelId: Type.Optional(Type.String()),
  parentSessionFile: Type.Optional(Type.String()),
  parentSessionId: Type.Optional(Type.String()),
  profile: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  sessionFile: Type.Optional(Type.String()),
  startedAt: Type.Optional(Type.Number()),
  status: Type.Union([AgentRuntimeStatusSchema, Type.Literal('closed')]),
  taskName: Type.String(),
  thinking: Type.Optional(ThinkingLevelSchema),
  tools: Type.Optional(Type.String()),
  updatedAt: Type.Number(),
})

interface SubagentConfig {
  storageDir?: string
  retentionDays?: number
}

export interface ChildProcessOwnership {
  pid: number
  processIdentity: string
  token: string
  ownerPid: number
  ownerProcessIdentity?: string
  startedAt: number
}

export interface AgentInfo {
  id: string
  taskName: string
  canonicalName: string
  parentSessionId: string
  parentSessionFile?: string
  profile?: string
  agentType?: string
  provider: string
  modelId: string
  model: string
  thinking?: ThinkingLevel
  allowedTools?: string[]
  prompt?: string
  color?: ThemeColor
  isReadonly?: boolean
  tools?: string
  cwd: string
  sessionFile: string
  infoFile: string
  logFile: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  lastActivity?: number
  messageCount: number
  status: AgentRuntimeStatus
  lastTaskMessage?: string
  finalResponse?: string
  error?: string
  childProcess?: ChildProcessOwnership
}

export interface AgentListEntry {
  agent_name: string
  agent_status: AgentRuntimeStatus
  last_task_message: string | undefined
  parent_session_id?: string
  profile?: string
  color: ThemeColor
  is_readonly?: boolean
}

export interface AgentResponseEntry {
  agent_name: string
  status: AgentRuntimeStatus
  finalResponse?: string
  error?: string
  last_task_message: string | undefined
  profile?: string
  color: ThemeColor
  is_readonly?: boolean
}

export interface SpawnAgentParams {
  task_name: string
  message: string
  agent_type: AgentProfileName
  cwd: string
  parentSessionId: string
  parentSessionFile?: string
  availableModels: readonly AvailableModel[]
  parentModel: AvailableModel
}

interface LiveAgent {
  info: AgentInfo
  proc: ChildProcessWithoutNullStreams
  broadcaster: EventBroadcaster
  logger: SessionLogger
  pending: Ref.Ref<HashMap.HashMap<string, Deferred.Deferred<unknown, Error>>>
  reqId: number
  stderr: string
  expectedExit: boolean
  processFinished: boolean
  finalizedRun: boolean
  exitPromise: Promise<void>
  resolveExit: () => void
  termination?: Promise<void>
  candidateResponse: string
  candidateError?: string
  /** Manager-owned scope for this child's lifetime; closed explicitly in finishProcess so returning from spawnAgent never tears the child down. */
  scope: Scope.Closeable
}

export const AgentCompletionEventSchema = Type.Object({
  agentName: Type.String(),
  color: ThemeColorSchema,
  createdAt: Type.Number(),
  error: Type.Optional(Type.String()),
  finalResponse: Type.Optional(Type.String()),
  id: Type.String(),
  isReadonly: Type.Optional(Type.Boolean()),
  parentSessionId: Type.String(),
  profile: Type.Optional(Type.String()),
  status: AgentRuntimeStatusSchema,
})

export type AgentCompletionEvent = Static<typeof AgentCompletionEventSchema>

interface AgentActivityEvent {
  parentSessionId: string
  agentName: string
  active: boolean
  profile?: string
  color: ThemeColor
  isReadonly?: boolean
}

export interface AgentManagerOptions {
  onActivityChange?: (event: AgentActivityEvent) => void
  onUnclaimedCompletion?: (event: AgentCompletionEvent) => void
  /** Override the child Pi executable for embedding and tests. */
  piCommand?: {
    command: string
    prefixArgs?: string[]
  }
  /** Additional environment entries passed only to child Pi processes. */
  childEnv?: NodeJS.ProcessEnv
  /** Test hook invoked after a dead lock is inspected but before its instance is revalidated. */
  beforeReclaimTaskLockRemoval?: (lockFile: string) => void
  /** Test hook invoked after a held lock is released normally but before its instance is revalidated. */
  beforeReleaseTaskLockRemoval?: (lockFile: string) => void
  /** Override process identity inspection so tests can drive Linux/Darwin/Windows branches on any host. */
  processInspector?: ProcessInspectorShape
  /** Override the platform used to choose between POSIX signals and Windows taskkill for tests. */
  platform?: NodeJS.Platform
}

interface Waiter {
  parentSessionId: string
  targets?: Set<string>
  resolve: (event: AgentCompletionEvent) => void
}

const abortError = (signal?: AbortSignal): Error => (signal?.reason instanceof Error ? signal.reason : new Error('Wait canceled.'))

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw abortError(signal)
  }
}

const expandHome = (value: string): string => {
  if (value === '~') {
    return homedir()
  }
  if (value.startsWith('~/')) {
    return join(homedir(), value.slice(2))
  }
  return value
}

const normalizeConfig = (value: unknown): SubagentConfig => {
  if (!isRecord(value) || Array.isArray(value)) {
    return {}
  }
  const raw = value
  const retentionDays =
    typeof raw.retentionDays === 'number' && Number.isFinite(raw.retentionDays) && raw.retentionDays >= 0 ? raw.retentionDays : undefined
  return {
    ...(typeof raw.storageDir === 'string' && raw.storageDir.trim() ? { storageDir: raw.storageDir.trim() } : {}),
    ...(retentionDays === undefined ? {} : { retentionDays }),
  }
}

const loadSubagentConfig = (): SubagentConfig => {
  try {
    if (existsSync(CONFIG_PATH)) {
      return normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))
    }
  } catch {
    // Best effort; a missing or unreadable config file falls back to defaults.
  }
  return {}
}

export const getRunsDir = (): string => {
  const configured = loadSubagentConfig().storageDir
  if (configured) {
    const expanded = expandHome(configured)
    return isAbsolute(expanded) ? expanded : resolvePath(SUBAGENT_DIR, expanded)
  }
  return join(SUBAGENT_DIR, 'runs')
}

const ensurePrivateDir = (directory: string, enforceMode = false): void => {
  const existed = existsSync(directory)
  mkdirSync(directory, { mode: 0o700, recursive: true })
  if (process.platform !== 'win32' && (enforceMode || !existed)) {
    chmodSync(directory, 0o700)
  }
}

const ensureBaseDirs = (): void => {
  ensurePrivateDir(getRunsDir(), !loadSubagentConfig().storageDir)
  ensurePrivateDir(SOCKET_DIR, true)
}

const SCOPE_DIR_PATTERN = /^[0-9a-f]{24}$/
const AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OUTPUT_FILE_PATTERN = /^\d+-[0-9a-f-]{36}\.txt$/i
const TASK_LOCK_PATTERN = /^\.task-[0-9a-f]{24}\.lock$/

const isAgentArtifact = (name: string, agentId: string): boolean =>
  name === `${agentId}.jsonl` ||
  name === `${agentId}.info.json` ||
  name === `${agentId}.log` ||
  new RegExp(`^${agentId}\\.info\\.json\\.\\d+\\.tmp$`).test(name)

const latestArtifactMtime = (directory: string, agentEntries: Dirent[]): number => {
  let latest = 0
  for (const artifact of agentEntries) {
    try {
      latest = Math.max(latest, statSync(join(directory, artifact.name)).mtimeMs)
    } catch {
      // Missing files between the readdir snapshot and stat don't affect staleness.
    }
  }
  return latest
}

const removeAgentArtifacts = (directory: string, artifacts: Dirent[]): boolean => {
  let failed = false
  for (const artifact of artifacts) {
    try {
      rmSync(join(directory, artifact.name), { force: true })
    } catch {
      failed = true
    }
  }
  return failed
}

interface PruneAgentEntryParams {
  directory: string
  entries: Dirent[]
  entry: Dirent
  cutoff: number
}

const pruneAgentEntry = ({ directory, entries, entry, cutoff }: PruneAgentEntryParams): void => {
  const agentId = entry.name.slice(0, -'.info.json'.length)
  if (!AGENT_ID_PATTERN.test(agentId)) {
    return
  }
  const info = readInfoFile(join(directory, entry.name))
  const agentEntries = entries.filter((candidate) => candidate.isFile() && isAgentArtifact(candidate.name, agentId))
  const baseline = Math.max(info?.lastActivity ?? 0, info?.updatedAt ?? 0, info?.createdAt ?? 0)
  const latest = Math.max(baseline, latestArtifactMtime(directory, agentEntries))
  if (isRunActive(agentId) || latest >= cutoff) {
    return
  }
  const otherArtifacts = agentEntries.filter((candidate) => candidate.name !== entry.name)
  if (removeAgentArtifacts(directory, otherArtifacts)) {
    return
  }
  try {
    rmSync(join(directory, entry.name), { force: true })
  } catch {
    // Best effort cleanup; a concurrent deletion is not an error.
  }
}

const pruneStaleTaskLock = (directory: string, entry: Dirent, cutoff: number): void => {
  const lockFile = join(directory, entry.name)
  try {
    if (statSync(lockFile).mtimeMs >= cutoff) {
      return
    }
  } catch {
    return
  }
  reclaimDeadTaskLock(lockFile)
}

const pruneScope = (directory: string, cutoff: number): void => {
  const entries = readdirSync(directory, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.info.json')) {
      pruneAgentEntry({ cutoff, directory, entries, entry })
    }
  }

  for (const entry of entries) {
    if (entry.isFile() && TASK_LOCK_PATTERN.test(entry.name)) {
      pruneStaleTaskLock(directory, entry, cutoff)
    }
  }

  try {
    rmdirSync(directory)
  } catch {
    // Best effort cleanup; a non-empty or already-removed directory is not an error.
  }
}

const pruneOutputFiles = (target: string, cutoff: number): void => {
  let outputs: Dirent[]
  try {
    outputs = readdirSync(target, { withFileTypes: true })
  } catch {
    return
  }
  for (const output of outputs) {
    if (!output.isFile() || !OUTPUT_FILE_PATTERN.test(output.name)) {
      continue
    }
    const outputPath = join(target, output.name)
    try {
      if (statSync(outputPath).mtimeMs < cutoff) {
        rmSync(outputPath, { force: true })
      }
    } catch {
      // Best effort cleanup; a concurrent deletion is not an error.
    }
  }
}

const pruneRunsRoot = (root: string, cutoff: number): void => {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const target = join(root, entry.name)
    if (entry.name === '_outputs' && entry.isDirectory()) {
      pruneOutputFiles(target, cutoff)
      continue
    }
    if (!entry.isDirectory() || !SCOPE_DIR_PATTERN.test(entry.name)) {
      continue
    }
    try {
      pruneScope(target, cutoff)
    } catch {
      // Best effort cleanup; a partially-removed scope directory is not an error.
    }
  }
}

const pruneExpiredRuns = (): void => {
  const retentionDays = loadSubagentConfig().retentionDays ?? DEFAULT_RETENTION_DAYS
  if (retentionDays === 0) {
    return
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  for (const root of runsRoots()) {
    pruneRunsRoot(root, cutoff)
  }
}

export const parentScopeKey = (parentSessionId: string): string => createHash('sha256').update(parentSessionId).digest('hex').slice(0, 24)

export const taskStorageKey = (taskName: string): string => createHash('sha256').update(taskName).digest('hex').slice(0, 24)

const runsRoots = (): string[] => [...new Set([getRunsDir(), LEGACY_RUNS_DIR])]

const scopeDir = (parentSessionId: string): string => join(getRunsDir(), parentScopeKey(parentSessionId))

const scopeDirs = (parentSessionId: string): string[] => {
  const key = parentScopeKey(parentSessionId)
  return runsRoots().map((root) => join(root, key))
}

const normalizeTaskName = (name: string): string => {
  const normalized = name.trim().replaceAll(/^\/+|\/+$/g, '')
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(normalized)) {
    throw new Error('task_name must use letters, digits, underscores, dashes, and optional slash path separators')
  }
  return normalized
}

const taskLockFile = (parentSessionId: string, taskName: string): string => join(scopeDir(parentSessionId), `.task-${taskStorageKey(taskName)}.lock`)

const TaskLockOwnerSchema = Type.Object({
  pid: Type.Optional(Type.Number()),
  processIdentity: Type.Optional(Type.String()),
  token: Type.Optional(Type.String()),
})

const taskLockIsActive = (parentSessionId: string, taskName: string): boolean => {
  try {
    const owner: unknown = JSON.parse(readFileSync(taskLockFile(parentSessionId, taskName), 'utf8'))
    return Check(TaskLockOwnerSchema, owner) && processOwnerIsActive(owner)
  } catch {
    return false
  }
}

interface TaskLockOwner {
  pid?: number
  processIdentity?: string
  token?: string
}

const parseTaskLockOwner = (content: string): TaskLockOwner => {
  try {
    const parsed: unknown = JSON.parse(content)
    return Check(TaskLockOwnerSchema, parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const sameFileInstance = (first: Stats, second: Stats): boolean => first.dev === second.dev && first.ino === second.ino

const reclaimDeadTaskLock = (lockFile: string, beforeRevalidate?: (lockFile: string) => void): boolean => {
  let inspectedFd: number | undefined
  let currentFd: number | undefined
  try {
    // Keep the inspected instance open, then reopen the pathname immediately before unlinking.
    // Comparing both file identity and content prevents deleting a replacement lock that won a
    // Race after the dead owner's record was read.
    inspectedFd = openSync(lockFile, 'r')
    const inspectedStat = fstatSync(inspectedFd)
    const inspectedContent = readFileSync(inspectedFd, 'utf8')
    const owner = parseTaskLockOwner(inspectedContent)
    if (processOwnerIsActive(owner)) {
      return false
    }

    beforeRevalidate?.(lockFile)

    currentFd = openSync(lockFile, 'r')
    const currentStat = fstatSync(currentFd)
    const currentContent = readFileSync(currentFd, 'utf8')
    if (!sameFileInstance(inspectedStat, currentStat) || inspectedContent !== currentContent) {
      return false
    }
    unlinkSync(lockFile)
    return true
  } catch {
    return false
  } finally {
    if (currentFd !== undefined) {
      closeSync(currentFd)
    }
    if (inspectedFd !== undefined) {
      closeSync(inspectedFd)
    }
  }
}

const releaseTaskLock = (lockFile: string, ownedFd: number, token: string, beforeRevalidate?: (lockFile: string) => void): void => {
  let currentFd: number | undefined
  try {
    const ownedStat = fstatSync(ownedFd)
    beforeRevalidate?.(lockFile)
    currentFd = openSync(lockFile, 'r')
    const currentStat = fstatSync(currentFd)
    const currentOwner = parseTaskLockOwner(readFileSync(currentFd, 'utf8'))
    if (sameFileInstance(ownedStat, currentStat) && currentOwner.token === token) {
      unlinkSync(lockFile)
    }
  } catch {
    // A missing or replaced pathname is no longer this caller's lock to release.
  } finally {
    if (currentFd !== undefined) {
      closeSync(currentFd)
    }
    closeSync(ownedFd)
  }
}

const saveInfo = (info: AgentInfo): void => {
  mkdirSync(dirname(info.infoFile), { recursive: true })
  info.updatedAt = Date.now()
  const temporary = `${info.infoFile}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(info, undefined, 2))
  renameSync(temporary, info.infoFile)
}

const closedStoredStatus = (parsed: Static<typeof StoredAgentInfoSchema>): AgentRuntimeStatus => {
  if (parsed.error) {
    return 'failed'
  }
  return parsed.finalResponse === undefined ? 'interrupted' : 'completed'
}

const readInfoFile = (file: string): AgentInfo | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Check(StoredAgentInfoSchema, parsed)) {
      return undefined
    }
    const status: AgentRuntimeStatus = parsed.status === 'closed' ? closedStoredStatus(parsed) : parsed.status
    const info: AgentInfo & { closedAt?: number } = {
      ...parsed,
      canonicalName: parsed.canonicalName ?? canonicalAgentName(parsed.taskName),
      cwd: parsed.cwd ?? '',
      infoFile: parsed.infoFile ?? file,
      logFile: parsed.logFile ?? '',
      messageCount: parsed.messageCount ?? 0,
      model: parsed.model ?? '',
      modelId: parsed.modelId ?? '',
      parentSessionId: parsed.parentSessionId ?? '',
      provider: parsed.provider ?? '',
      sessionFile: parsed.sessionFile ?? '',
      status,
    }
    delete info.closedAt
    return info
  } catch {
    return undefined
  }
}

const readInfos = (directory: string): AgentInfo[] => {
  if (!existsSync(directory)) {
    return []
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith('.info.json'))
    .flatMap((name) => {
      const info = readInfoFile(join(directory, name))
      return info ? [info] : []
    })
}

const sortInfos = (infos: AgentInfo[]): AgentInfo[] =>
  infos.toSorted((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))

const readScopeInfos = (parentSessionId: string): AgentInfo[] => sortInfos(scopeDirs(parentSessionId).flatMap(readInfos))

const readAllInfos = (): AgentInfo[] => {
  const directories = runsRoots().flatMap((root) => {
    if (!existsSync(root)) {
      return []
    }
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SCOPE_DIR_PATTERN.test(entry.name))
      .map((entry) => join(root, entry.name))
  })
  return sortInfos(directories.flatMap(readInfos))
}

export const getAgent = (name: string, parentSessionId: string): AgentInfo | undefined => {
  const taskName = normalizeTaskName(name)
  return readScopeInfos(parentSessionId).find((info) => info.taskName === taskName)
}

interface PeekMarker {
  pid: number
  startedAt: number
  token: string
}

const PeekMarkerSchema = Type.Object({
  pid: Type.Number(),
  startedAt: Type.Number(),
  token: Type.String(),
})

const PeekMarkerPartialSchema = Type.Partial(PeekMarkerSchema)

export const getSocketPath = (agentId: string): string =>
  process.platform === 'win32' ? `\\\\.\\pipe\\${PACKAGE_BASENAME}-${userInfo().username}-${agentId}` : join(SOCKET_DIR, `${agentId}.sock`)

const markerPath = (agentId: string, kind: 'active' | 'peek'): string => join(SOCKET_DIR, `${agentId}.${kind}.json`)

const markActive = (agentId: string, kind: 'active' | 'peek', marker: PeekMarker): void => {
  writeFileSync(markerPath(agentId, kind), JSON.stringify(marker, undefined, 2))
}

const clearActive = (agentId: string, kind: 'active' | 'peek', owner?: Pick<PeekMarker, 'pid' | 'token'>): void => {
  const file = markerPath(agentId, kind)
  try {
    if (owner && existsSync(file)) {
      const current: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!Check(PeekMarkerPartialSchema, current) || current.pid !== owner.pid || current.token !== owner.token) {
        return
      }
    }
    unlinkSync(file)
  } catch {
    // Best effort cleanup; a missing or already-removed marker is not an error.
  }
}

const isActive = (agentId: string, kind: 'active' | 'peek'): boolean => {
  const file = markerPath(agentId, kind)
  try {
    if (!existsSync(file)) {
      return false
    }
    const marker: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Check(PeekMarkerSchema, marker)) {
      return false
    }
    if (processAlive(marker.pid)) {
      return true
    }
    clearActive(agentId, kind, marker)
  } catch {
    // Best effort; treat an unreadable marker file as inactive.
  }
  return false
}

const isRunActive = (agentId: string): boolean => isActive(agentId, 'active') || isActive(agentId, 'peek')

export const isPeekActive = (agentId: string): boolean => isActive(agentId, 'peek')

interface SubagentMessage {
  role?: string
  content?: unknown
  stopReason?: string
  errorMessage?: string
  toolCallId?: string
}

interface ActiveToolSnapshot {
  toolCallId: string
  toolName: string
  args: unknown
  partialResult?: unknown
  result?: unknown
  isError?: boolean
}

interface SyncBroadcastEvent {
  type: 'sync'
  activeTools: ActiveToolSnapshot[]
  partialMessage: SubagentMessage | undefined
  status: 'thinking' | 'streaming' | 'tool' | 'done'
  toolName: string | undefined
  userMessage: SubagentMessage | undefined
}

export interface SubagentRpcEvent {
  type: string
  id?: string
  success?: boolean
  data?: unknown
  error?: string
  message?: SubagentMessage
  messages?: SubagentMessage[]
  assistantMessageEvent?: { type?: string }
  toolCallId?: string
  toolName?: string
  args?: unknown
  partialResult?: unknown
  result?: unknown
  isError?: boolean
  finalError?: string
}

const SubagentMessageSchema = Type.Object({
  content: Type.Optional(Type.Unknown()),
  errorMessage: Type.Optional(Type.String()),
  role: Type.Optional(Type.String()),
  stopReason: Type.Optional(Type.String()),
  toolCallId: Type.Optional(Type.String()),
})

const SubagentRpcEventSchema = Type.Object({
  args: Type.Optional(Type.Unknown()),
  assistantMessageEvent: Type.Optional(Type.Object({ type: Type.Optional(Type.String()) })),
  data: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String()),
  finalError: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  isError: Type.Optional(Type.Boolean()),
  message: Type.Optional(SubagentMessageSchema),
  messages: Type.Optional(Type.Array(SubagentMessageSchema)),
  partialResult: Type.Optional(Type.Unknown()),
  result: Type.Optional(Type.Unknown()),
  success: Type.Optional(Type.Boolean()),
  toolCallId: Type.Optional(Type.String()),
  toolName: Type.Optional(Type.String()),
  type: Type.String(),
})

class SessionLogger {
  private stream: WriteStream | undefined = undefined
  private readonly file: string
  constructor(file: string) {
    this.file = file
  }
  private write(entry: { level: string; category: string; message: string; data?: unknown }): void {
    const { level, category, message, data } = entry
    mkdirSync(dirname(this.file), { recursive: true })
    if (!this.stream) {
      this.stream = createWriteStream(this.file, { flags: 'a' })
    }
    this.stream.write(
      `${JSON.stringify({
        category,
        level,
        message,
        ts: new Date().toISOString(),
        ...(data === undefined ? {} : { data }),
      })}\n`
    )
  }
  info(category: string, message: string, data?: unknown): void {
    this.write({ category, data, level: 'INFO', message })
  }
  stderr(chunk: string): void {
    this.write({ category: 'pi-process', level: 'STDERR', message: chunk.trim() })
  }
  close(): void {
    this.stream?.end()
    this.stream = undefined
  }
}

class EventBroadcaster {
  private server: Server | undefined = undefined
  private connections: Socket[] = []
  private readonly marker: PeekMarker = {
    pid: process.pid,
    startedAt: Date.now(),
    token: randomUUID(),
  }
  private status: 'thinking' | 'streaming' | 'tool' | 'done' = 'thinking'
  private toolName?: string
  private partialMessage: SubagentMessage | undefined = undefined
  private userMessage: SubagentMessage | undefined = undefined
  private readonly activeTools = new Map<string, ActiveToolSnapshot>()
  private readonly agentId: string

  constructor(agentId: string) {
    this.agentId = agentId
  }

  start(): void {
    ensurePrivateDir(SOCKET_DIR, true)
    markActive(this.agentId, 'active', this.marker)
    const socketPath = getSocketPath(this.agentId)
    if (process.platform !== 'win32') {
      try {
        if (existsSync(socketPath)) {
          unlinkSync(socketPath)
        }
      } catch {
        // Best effort; a missing stale socket file is not an error.
      }
    }
    this.server = createServer((connection) => {
      this.connections.push(connection)
      try {
        connection.write(
          `${JSON.stringify({
            activeTools: [...this.activeTools.values()],
            partialMessage: this.partialMessage,
            status: this.status,
            toolName: this.toolName,
            type: 'sync',
            userMessage: this.userMessage,
          } satisfies SyncBroadcastEvent)}\n`
        )
      } catch {
        // Best effort; a connection that closed before the sync write is not an error.
      }
      const remove = () => {
        this.connections = this.connections.filter((candidate) => candidate !== connection)
      }
      connection.on('close', remove)
      connection.on('error', remove)
    })
    this.server.on('listening', () => markActive(this.agentId, 'peek', this.marker))
    this.server.on('error', () => this.stopSocket())
    try {
      this.server.listen(socketPath)
    } catch {
      this.stopSocket()
    }
  }

  private applyMessageStart(event: SubagentRpcEvent): void {
    if (event.message?.role === 'user') {
      this.userMessage = event.message
    } else if (event.message?.role === 'assistant') {
      this.partialMessage = event.message
      this.status = 'thinking'
    }
  }

  private applyMessageUpdate(event: SubagentRpcEvent): void {
    if (event.message?.role !== 'assistant') {
      return
    }
    this.partialMessage = event.message
    const delta = event.assistantMessageEvent
    if (delta?.type === 'thinking_delta') {
      this.status = 'thinking'
    }
    if (delta?.type === 'text_delta') {
      this.status = 'streaming'
    }
  }

  private applyToolExecutionStart(event: SubagentRpcEvent): void {
    this.status = 'tool'
    this.toolName = event.toolName
    if (event.toolCallId && event.toolName) {
      this.activeTools.set(event.toolCallId, {
        args: event.args,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      })
    }
  }

  private applyToolExecutionUpdate(event: SubagentRpcEvent): void {
    if (!event.toolCallId) {
      return
    }
    const active = this.activeTools.get(event.toolCallId)
    if (active) {
      active.partialResult = event.partialResult
    }
  }

  private applyToolExecutionEnd(event: SubagentRpcEvent): void {
    if (!event.toolCallId) {
      return
    }
    const active = this.activeTools.get(event.toolCallId)
    if (active) {
      active.result = event.result
      active.isError = event.isError ?? false
    }
  }

  private applyMessageEnd(event: SubagentRpcEvent): void {
    if (event.message?.role === 'toolResult' && event.message.toolCallId) {
      this.activeTools.delete(event.message.toolCallId)
    }
    this.partialMessage = undefined
    this.userMessage = undefined
  }

  private applyAgentSettled(): void {
    this.partialMessage = undefined
    this.userMessage = undefined
    this.activeTools.clear()
    this.status = 'done'
    this.toolName = undefined
  }

  broadcast(event: SubagentRpcEvent): void {
    if (event.type === 'message_start') {
      this.applyMessageStart(event)
    } else if (event.type === 'message_update') {
      this.applyMessageUpdate(event)
    } else if (event.type === 'tool_execution_start') {
      this.applyToolExecutionStart(event)
    } else if (event.type === 'tool_execution_update') {
      this.applyToolExecutionUpdate(event)
    } else if (event.type === 'tool_execution_end') {
      this.applyToolExecutionEnd(event)
    } else if (event.type === 'message_end') {
      this.applyMessageEnd(event)
    } else if (event.type === 'agent_settled') {
      this.applyAgentSettled()
    }
    const line = `${JSON.stringify(event)}\n`
    for (const connection of this.connections) {
      try {
        connection.write(line)
      } catch {
        // Best effort; a connection that closed mid-broadcast is not an error.
      }
    }
  }

  private stopSocket(): void {
    clearActive(this.agentId, 'peek', this.marker)
    for (const connection of this.connections) {
      try {
        connection.destroy()
      } catch {
        // Best effort; a connection that is already closed is not an error.
      }
    }
    this.connections = []
    try {
      this.server?.close()
    } catch {
      // Best effort; a server that is already closed is not an error.
    }
    this.server = undefined
    if (process.platform !== 'win32') {
      try {
        if (existsSync(getSocketPath(this.agentId))) {
          unlinkSync(getSocketPath(this.agentId))
        }
      } catch {
        // Best effort; a missing stale socket file is not an error.
      }
    }
  }

  stop(): void {
    clearActive(this.agentId, 'active', this.marker)
    this.stopSocket()
  }
}

const isTextContentPart = (part: unknown): part is { type: 'text'; text: string } =>
  typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string'

const extractTextFromMessage = (message: SubagentMessage | undefined): string => {
  const content = message?.content
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter(isTextContentPart)
    .map((part) => part.text)
    .join('\n\n')
}

const previewText = (text: string | undefined, maxLength = 180): string | undefined => {
  if (!text) {
    return undefined
  }
  const normalized = text.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
}

const agentMetadata = (
  info: AgentInfo
): {
  profile?: string
  color: ThemeColor
  isReadonly?: boolean
} => ({
  ...(info.profile ? { profile: info.profile } : {}),
  color: persistedProfileColor(info.profile, info.color),
  ...(info.isReadonly === undefined ? {} : { isReadonly: info.isReadonly }),
})

const getPiCommand = (
  override?: AgentManagerOptions['piCommand']
): {
  command: string
  prefixArgs: string[]
} => {
  if (override) {
    return { command: override.command, prefixArgs: override.prefixArgs ?? [] }
  }
  if (process.env.PI_SUBAGENT_PI_BIN) {
    return { command: process.env.PI_SUBAGENT_PI_BIN, prefixArgs: [] }
  }
  const [, currentEntry] = process.argv
  if (currentEntry && existsSync(currentEntry)) {
    return { command: process.execPath, prefixArgs: [currentEntry] }
  }
  return { command: process.execPath, prefixArgs: [] }
}

const canonicalAgentName = (target: string): string => (target.startsWith('/') ? target : `/${target}`)

const targetMatches = (event: AgentCompletionEvent, targets?: Set<string>): boolean => !targets || targets.has(event.agentName)

const buildChildArgs = (launch: { command: string; prefixArgs: string[] }, info: AgentInfo): string[] => {
  const args = [
    ...launch.prefixArgs,
    '--mode',
    'rpc',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--append-system-prompt',
    [
      info.prompt,
      info.isReadonly
        ? 'This subagent role is read-only. Do not modify local or remote state. The configured tool allowlist remains the local capability boundary.'
        : undefined,
    ]
      .filter(Boolean)
      .join('\n\n'),
    '--provider',
    info.provider,
    '--model',
    info.modelId,
    '--session',
    info.sessionFile,
  ]
  if (info.thinking) {
    args.push('--thinking', info.thinking)
  }
  const tools = info.allowedTools?.join(',') ?? info.tools
  if (tools !== undefined) {
    if (tools) {
      args.push('--tools', tools)
    } else {
      args.push('--no-builtin-tools')
    }
  }
  return args
}

const waitForOwnedExitEffect = (inspector: ProcessInspectorShape, ownership: ChildProcessOwnership, timeoutMs: number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (!(yield* inspector.ownershipMatches(ownership))) {
        return true
      }
      yield* Effect.sleep(25)
    }
    return !(yield* inspector.ownershipMatches(ownership))
  })

/**
 * Wait for an identity that survives two consecutive reads. A launcher such as a shebang
 * script or a bin shim replaces the command line in place while keeping the PID, so the
 * first readable identity can describe the launcher instead of the child Pi process.
 */
const verifyChildOwnershipEffect = (inspector: ProcessInspectorShape, pid: number, token: string): Effect.Effect<ProcessSnapshot, Error> =>
  Effect.gen(function* () {
    let previous: ProcessSnapshot | undefined
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = yield* inspector.inspect(pid, token)
      if (candidate && candidate.tokenMatches !== false && candidate.identity === previous?.identity) {
        return candidate
      }
      previous = candidate
      yield* Effect.sleep(10)
    }
    return yield* Effect.fail(new Error('Unable to verify child Pi process ownership.'))
  })

const buildChildEnv = (info: AgentInfo, childToken: string, extraChildEnv: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv => {
  const childEnv = { ...process.env, ...extraChildEnv }
  delete childEnv.PI_SESSION_ID
  delete childEnv.PI_SESSION_FILE
  delete childEnv.PI_PROVIDER
  delete childEnv.PI_MODEL
  delete childEnv.PI_REASONING_LEVEL
  childEnv.PI_SUBAGENT_OWNER_TOKEN = childToken
  childEnv.PI_SUBAGENT_PROFILE = info.profile ?? ''
  childEnv.PI_SUBAGENT_READONLY = info.isReadonly ? '1' : '0'
  return childEnv
}

export class AgentManager {
  private readonly live = new Map<string, LiveAgent>()
  private readonly mailbox: AgentCompletionEvent[] = []
  private waiters: Waiter[] = []
  private readonly waitAllClaims = new Set<{
    parentSessionId: string
    targets: Set<string>
    suppressedEventIds: Set<string>
  }>()
  private readonly defaultWaitAllTargets = new Map<string, Set<string>>()
  private readonly shutdownController = new AbortController()
  private readonly inspector: ProcessInspectorShape
  private readonly platform: NodeJS.Platform
  private readonly ownerProcessIdentity: string | undefined
  private readonly reconciliation: Promise<void>
  private readonly options: AgentManagerOptions

  constructor(options: AgentManagerOptions = {}) {
    this.options = options
    this.inspector = options.processInspector ?? processInspectorFromProbe(nodeProcessProbe)
    this.platform = options.platform ?? process.platform
    this.ownerProcessIdentity = Effect.runSync(this.inspector.inspect(process.pid))?.identity
    ensureBaseDirs()
    pruneExpiredRuns()
    this.reconciliation = this.reconcilePersistedChildren()
  }

  async ready(): Promise<void> {
    await this.reconciliation
  }

  private notifyStatusChange(info: AgentInfo): void {
    try {
      this.options.onActivityChange?.({
        active: info.status === 'starting' || info.status === 'running',
        agentName: info.canonicalName,
        parentSessionId: info.parentSessionId,
        ...agentMetadata(info),
      })
    } catch {
      // Best effort; a throwing extension callback must not break status tracking.
    }
  }

  private notifyUnclaimedCompletion(event: AgentCompletionEvent): void {
    try {
      this.options.onUnclaimedCompletion?.(event)
    } catch {
      // Best effort; a throwing extension callback must not break event delivery.
    }
  }

  private clearChildOwnership(info: AgentInfo, expectedToken: string): void {
    const persisted = readInfoFile(info.infoFile)
    if (persisted?.childProcess?.token === expectedToken) {
      delete persisted.childProcess
      saveInfo(persisted)
    }
    if (info.childProcess?.token === expectedToken) {
      delete info.childProcess
    }
  }

  private waitForOwnedExit(ownership: ChildProcessOwnership, timeoutMs: number): Promise<boolean> {
    return Effect.runPromise(waitForOwnedExitEffect(this.inspector, ownership, timeoutMs))
  }

  private signalOwnedProcess(ownership: ChildProcessOwnership, signal: NodeJS.Signals): void {
    if (!Effect.runSync(this.inspector.ownershipMatches(ownership))) {
      return
    }
    try {
      if (this.platform === 'win32') {
        process.kill(ownership.pid, signal)
      } else {
        process.kill(-ownership.pid, signal)
      }
    } catch {
      try {
        process.kill(ownership.pid, signal)
      } catch {
        // Best effort; the process may have already exited.
      }
    }
  }

  private async terminateOwnedChild(info: AgentInfo): Promise<void> {
    const ownership = info.childProcess
    if (!ownership) {
      return
    }
    if (!Effect.runSync(this.inspector.ownershipMatches(ownership))) {
      this.clearChildOwnership(info, ownership.token)
      return
    }
    if (this.platform === 'win32') {
      await new Promise<void>((finished) => {
        const killer = spawn('taskkill', ['/pid', String(ownership.pid), '/T', '/F'], {
          stdio: 'ignore',
        })
        killer.once('error', () => finished())
        killer.once('exit', () => finished())
      })
      await this.waitForOwnedExit(ownership, 2000)
    } else {
      this.signalOwnedProcess(ownership, 'SIGTERM')
      if (!(await this.waitForOwnedExit(ownership, 1000))) {
        this.signalOwnedProcess(ownership, 'SIGKILL')
        await this.waitForOwnedExit(ownership, 1000)
      }
    }
    if (Effect.runSync(this.inspector.ownershipMatches(ownership))) {
      throw new Error(`Unable to terminate owned child process for ${info.canonicalName}.`)
    }
    this.clearChildOwnership(info, ownership.token)
  }

  private async reconcilePersistedChildren(): Promise<void> {
    for (const info of readAllInfos()) {
      const ownership = info.childProcess
      if (!ownership) {
        if (info.status === 'starting' && !taskLockIsActive(info.parentSessionId, info.taskName)) {
          reclaimDeadTaskLock(taskLockFile(info.parentSessionId, info.taskName), this.options.beforeReclaimTaskLockRemoval)
          info.status = 'interrupted'
          info.lastActivity = Date.now()
          saveInfo(info)
          this.notifyStatusChange(info)
        }
        continue
      }
      try {
        if (!Effect.runSync(this.inspector.ownershipMatches(ownership))) {
          if (info.status === 'starting' || info.status === 'running') {
            info.status = 'interrupted'
            info.lastActivity = Date.now()
            saveInfo(info)
            this.notifyStatusChange(info)
          }
          this.clearChildOwnership(info, ownership.token)
          continue
        }
        const ownerSnapshot = Effect.runSync(this.inspector.inspect(ownership.ownerPid))
        const ownerStillActive =
          ownership.ownerPid !== process.pid &&
          ownerSnapshot &&
          (!ownership.ownerProcessIdentity || ownerSnapshot.identity === ownership.ownerProcessIdentity)
        if (ownerStillActive) {
          continue
        }
        if (info.status === 'starting' || info.status === 'running') {
          info.status = 'interrupted'
          info.lastActivity = Date.now()
          saveInfo(info)
          this.notifyStatusChange(info)
        }
        await this.terminateOwnedChild(info)
      } catch {
        // Best effort reconciliation; a failure here is retried on the next manager start.
      }
    }
  }

  async spawnAgent(params: SpawnAgentParams): Promise<{
    task_name: string
    nickname: undefined
    profile: string
    color: ThemeColor
    is_readonly: boolean
  }> {
    await this.reconciliation
    const taskName = normalizeTaskName(params.task_name)
    const resolved = resolveAgentConfig(params.agent_type, {
      availableModels: params.availableModels,
      parentModel: params.parentModel,
    })
    const cwd = resolvePath(params.cwd)
    const directory = scopeDir(params.parentSessionId)
    ensurePrivateDir(directory, true)

    const lockFile = taskLockFile(params.parentSessionId, taskName)
    const lockToken = randomUUID()
    let lock: number | undefined
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          lock = openSync(lockFile, 'wx')
          writeFileSync(
            lock,
            JSON.stringify({
              createdAt: Date.now(),
              pid: process.pid,
              processIdentity: this.ownerProcessIdentity,
              token: lockToken,
            })
          )
          break
        } catch (error: unknown) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
            throw error
          }
          if (attempt === 0 && reclaimDeadTaskLock(lockFile, this.options.beforeReclaimTaskLockRemoval)) {
            continue
          }
          throw new Error(`Agent ${taskName} is already being created.`, { cause: error })
        }
      }
      if (lock === undefined) {
        throw new Error(`Unable to lock agent ${taskName} for creation.`)
      }
      if (readScopeInfos(params.parentSessionId).some((info) => info.taskName === taskName)) {
        throw new Error(`Agent ${taskName} already exists in this parent session. Use a new task_name.`)
      }
      const id = randomUUID()
      const info: AgentInfo = {
        agentType: resolved.key,
        allowedTools: [...resolved.allowedTools],
        canonicalName: `/${taskName}`,
        color: resolved.color,
        createdAt: Date.now(),
        cwd,
        id,
        infoFile: join(directory, `${id}.info.json`),
        isReadonly: resolved.isReadonly,
        lastActivity: Date.now(),
        lastTaskMessage: params.message,
        logFile: join(directory, `${id}.log`),
        messageCount: 0,
        model: `${resolved.provider}:${resolved.modelId}`,
        modelId: resolved.modelId,
        parentSessionFile: params.parentSessionFile,
        parentSessionId: params.parentSessionId,
        profile: resolved.key,
        prompt: resolved.prompt,
        provider: resolved.provider,
        sessionFile: join(directory, `${id}.jsonl`),
        startedAt: Date.now(),
        status: 'starting',
        taskName,
        thinking: resolved.thinking,
        updatedAt: Date.now(),
      }
      saveInfo(info)
      this.notifyStatusChange(info)
      const targets = this.defaultWaitAllTargets.get(params.parentSessionId) ?? new Set<string>()
      targets.add(info.canonicalName)
      this.defaultWaitAllTargets.set(params.parentSessionId, targets)
      await this.startLiveAgent(info, params.message, params.message)
      return {
        color: resolved.color,
        is_readonly: resolved.isReadonly,
        nickname: undefined,
        profile: resolved.key,
        task_name: info.canonicalName,
      }
    } finally {
      if (lock !== undefined) {
        releaseTaskLock(lockFile, lock, lockToken, this.options.beforeReleaseTaskLockRemoval)
      }
    }
  }

  private teardownChildStreams(live: LiveAgent): void {
    live.proc.stdin.removeAllListeners()
    live.proc.stdout.removeAllListeners()
    live.proc.stderr.removeAllListeners()
    live.proc.removeAllListeners()
    try {
      live.proc.stdin.destroy()
    } catch {
      // Best effort; the stream may already be destroyed.
    }
    try {
      live.proc.stdout.destroy()
    } catch {
      // Best effort; the stream may already be destroyed.
    }
    try {
      live.proc.stderr.destroy()
    } catch {
      // Best effort; the stream may already be destroyed.
    }
  }

  private finishProcess(live: LiveAgent, error?: Error): void {
    if (live.processFinished) {
      return
    }
    live.processFinished = true
    const persisted = readInfoFile(live.info.infoFile)
    if (persisted && FINAL_STATUSES.has(persisted.status)) {
      live.info = persisted
      live.finalizedRun = true
    }
    Effect.runSync(
      Effect.gen(function* () {
        const pending = yield* Ref.getAndSet(live.pending, HashMap.empty())
        for (const [, deferred] of HashMap.entries(pending)) {
          yield* Deferred.fail(deferred, error ?? new Error('Child Pi process exited before responding.'))
        }
      })
    )
    if (!live.expectedExit && !live.finalizedRun && !FINAL_STATUSES.has(live.info.status)) {
      this.markFailed(live, error?.message ?? 'Child Pi process exited unexpectedly.')
    }
    const ownership = live.info.childProcess
    if (ownership) {
      this.clearChildOwnership(live.info, ownership.token)
    }
    if (this.live.get(live.info.id) === live) {
      this.live.delete(live.info.id)
    }
    Effect.runSync(Scope.close(live.scope, Exit.void))
    live.resolveExit()
  }

  private wireChildProcess(live: LiveAgent, decoder: RpcJsonlDecoder): void {
    const { proc, logger } = live
    proc.stdout.on('data', (chunk) => {
      for (const line of decoder.push(chunk)) {
        this.handleLine(live, line)
      }
    })
    proc.stdout.on('end', () => {
      for (const line of decoder.end()) {
        this.handleLine(live, line)
      }
    })
    proc.stderr.on('data', (data) => {
      const chunk = data.toString()
      live.stderr = `${live.stderr}${chunk}`.slice(-64 * 1024)
      logger.stderr(chunk)
    })
    proc.stdin.on('error', (error) => {
      logger.info('stdin', 'child stdin error', { error: error.message })
      if (!live.expectedExit) {
        const persisted = readInfoFile(live.info.infoFile)
        if (persisted && FINAL_STATUSES.has(persisted.status)) {
          live.info = persisted
          live.finalizedRun = true
        } else if (!live.finalizedRun) {
          this.markFailed(live, error.message)
        }
        void this.terminateProcess(live)
      }
    })
    proc.on('error', (error) => this.finishProcess(live, error))
    proc.on('exit', (code, signal) => {
      logger.info('exit', 'child exited', { code, signal })
      const suffix = live.stderr.trim() ? `: ${live.stderr.trim().slice(-1000)}` : ''
      this.finishProcess(live, live.expectedExit ? undefined : new Error(`Child Pi exited (code=${code}, signal=${signal})${suffix}`))
    })
  }

  private async startLiveAgent(info: AgentInfo, initialMessage?: string, displayMessage?: string): Promise<LiveAgent> {
    if (info.status !== 'starting' && info.status !== 'running') {
      this.notifyStatusChange({ ...info, lastActivity: Date.now(), status: 'starting' })
    }
    const logger = new SessionLogger(info.logFile)
    const broadcaster = new EventBroadcaster(info.id)
    broadcaster.start()
    const launch = getPiCommand(this.options.piCommand)
    const args = buildChildArgs(launch, info)
    const childToken = randomUUID()
    logger.info('spawn', 'starting child pi', { args, command: launch.command, cwd: info.cwd })
    const childEnv = buildChildEnv(info, childToken, this.options.childEnv)
    const proc = spawn(launch.command, args, {
      cwd: info.cwd,
      detached: process.platform !== 'win32',
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let resolveExit!: () => void
    const exitPromise = new Promise<void>((markExited) => {
      resolveExit = markExited
    })
    const scope = Effect.runSync(Scope.make())
    const live: LiveAgent = {
      broadcaster,
      candidateResponse: '',
      exitPromise,
      expectedExit: false,
      finalizedRun: false,
      info,
      logger,
      pending: Effect.runSync(Ref.make(HashMap.empty())),
      proc,
      processFinished: false,
      reqId: 0,
      resolveExit,
      scope,
      stderr: '',
    }
    Effect.runSync(
      Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          live.broadcaster.stop()
          live.logger.close()
          this.teardownChildStreams(live)
        })
      )
    )
    this.live.set(info.id, live)
    const decoder = new RpcJsonlDecoder()
    this.wireChildProcess(live, decoder)

    try {
      if (!proc.pid) {
        throw new Error('Child Pi process did not provide a PID.')
      }
      const snapshot = await Effect.runPromise(verifyChildOwnershipEffect(this.inspector, proc.pid, childToken))
      // Persist ownership before the first RPC round trip. If this process crashes while
      // The child is starting, the next manager can identify and terminate the orphan.
      info.childProcess = {
        ownerPid: process.pid,
        ownerProcessIdentity: this.ownerProcessIdentity,
        pid: proc.pid,
        processIdentity: snapshot.identity,
        startedAt: Date.now(),
        token: childToken,
      }
      const provisionalOwnership = info.childProcess
      saveInfo(info)
      await this.sendCommand(live, { type: 'get_state' }, DEFAULT_STARTUP_TIMEOUT_MS)
      // The answered round trip proves the child reached its final program.
      // Its identity can no longer change underneath a later reconciliation.
      const settled = await Effect.runPromise(this.inspector.inspect(proc.pid, childToken))
      if (settled && settled.tokenMatches !== false && settled.identity !== provisionalOwnership.processIdentity) {
        info.childProcess = { ...provisionalOwnership, processIdentity: settled.identity }
        saveInfo(info)
      }
      if (initialMessage) {
        await this.prompt(live, initialMessage, displayMessage)
      }
      return live
    } catch (error) {
      if (!live.finalizedRun) {
        this.markFailed(live, error instanceof Error ? error.message : String(error))
      }
      await this.terminateProcess(live)
      throw error
    }
  }

  private sendCommand(live: LiveAgent, command: Record<string, unknown>, timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS): Promise<unknown> {
    if (live.processFinished || live.expectedExit) {
      return Promise.reject(new Error(`Agent ${live.info.taskName} process is not available.`))
    }
    const id = `req-${++live.reqId}`
    const commandType = typeof command.type === 'string' ? command.type : 'unknown'
    const payload = `${JSON.stringify({ id, ...command })}\n`
    const wait = Effect.gen(function* () {
      const deferred = yield* Deferred.make<unknown, Error>()
      yield* Ref.update(live.pending, HashMap.set(id, deferred))
      yield* Effect.sync(() => {
        live.proc.stdin.write(payload, (error) => {
          if (error) {
            Effect.runSync(Deferred.fail(deferred, error))
          }
        })
      })
      return yield* Deferred.await(deferred)
    })
    return Effect.runPromise(
      Effect.timeoutOrElse(wait, {
        duration: timeoutMs,
        orElse: () => Effect.fail(new Error(`Timed out waiting for child Pi RPC command: ${commandType}`)),
      }).pipe(Effect.ensuring(Ref.update(live.pending, HashMap.remove(id))))
    )
  }

  private async prompt(live: LiveAgent, message: string, displayMessage?: string): Promise<void> {
    const previousFinalState = {
      completedAt: live.info.completedAt,
      error: live.info.error,
      finalResponse: live.info.finalResponse,
      status: live.info.status,
    }
    this.removeMailboxEvents(live.info.parentSessionId, live.info.canonicalName)
    const targets = this.defaultWaitAllTargets.get(live.info.parentSessionId) ?? new Set<string>()
    targets.add(live.info.canonicalName)
    this.defaultWaitAllTargets.set(live.info.parentSessionId, targets)
    live.info.status = 'running'
    live.info.lastTaskMessage = displayMessage ?? message
    live.info.lastActivity = Date.now()
    live.info.messageCount += 1
    live.finalizedRun = false
    live.candidateResponse = ''
    live.candidateError = undefined
    delete live.info.finalResponse
    delete live.info.error
    delete live.info.completedAt
    saveInfo(live.info)
    this.notifyStatusChange(live.info)
    try {
      await this.sendCommand(live, { message, type: 'prompt' })
    } catch (error) {
      live.info.status = previousFinalState.status
      if (previousFinalState.finalResponse === undefined) {
        delete live.info.finalResponse
      } else {
        live.info.finalResponse = previousFinalState.finalResponse
      }
      if (previousFinalState.error === undefined) {
        delete live.info.error
      } else {
        live.info.error = previousFinalState.error
      }
      if (previousFinalState.completedAt === undefined) {
        delete live.info.completedAt
      } else {
        live.info.completedAt = previousFinalState.completedAt
      }
      saveInfo(live.info)
      this.notifyStatusChange(live.info)
      throw error
    }
  }

  private handleResponseEvent(live: LiveAgent, event: SubagentRpcEvent): void {
    const { id } = event
    if (!id) {
      return
    }
    Effect.runSync(
      Effect.gen(function* () {
        const pending = yield* Ref.get(live.pending)
        const deferred = HashMap.get(pending, id)
        if (Option.isNone(deferred)) {
          return
        }
        yield* Ref.update(live.pending, HashMap.remove(id))
        yield* event.success
          ? Deferred.succeed(deferred.value, event.data)
          : Deferred.fail(deferred.value, new Error(event.error || 'RPC command failed'))
      })
    )
  }

  private handleAgentStart(live: LiveAgent): void {
    live.info.status = 'running'
    live.info.lastActivity = Date.now()
    live.candidateResponse = ''
    live.candidateError = undefined
    saveInfo(live.info)
    this.notifyStatusChange(live.info)
  }

  private handleMessageEnd(live: LiveAgent, event: SubagentRpcEvent): void {
    if (event.message?.role !== 'assistant') {
      return
    }
    live.candidateResponse = extractTextFromMessage(event.message).trim()
    live.candidateError =
      event.message.stopReason === 'error' || event.message.stopReason === 'aborted'
        ? event.message.errorMessage || `Agent ended with ${event.message.stopReason}.`
        : undefined
  }

  private handleAgentEnd(live: LiveAgent, event: SubagentRpcEvent): void {
    const lastAssistant = [...(event.messages ?? [])].toReversed().find((message) => message?.role === 'assistant')
    if (!lastAssistant) {
      return
    }
    live.candidateResponse = extractTextFromMessage(lastAssistant).trim()
    live.candidateError =
      lastAssistant.stopReason === 'error' || lastAssistant.stopReason === 'aborted'
        ? lastAssistant.errorMessage || `Agent ended with ${lastAssistant.stopReason}.`
        : undefined
  }

  private handleAgentSettled(live: LiveAgent): void {
    if (live.info.status === 'interrupted' || live.finalizedRun) {
      return
    }
    if (live.candidateError) {
      this.markFailed(live, live.candidateError)
    } else {
      this.markCompleted(live)
    }
    void this.terminateProcess(live).catch((error) => {
      live.logger.info('hibernate', 'failed to terminate settled child', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private dispatchLiveEvent(live: LiveAgent, event: SubagentRpcEvent): void {
    const runningStatusEvents = new Set(['message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end'])
    if (event.type === 'agent_start') {
      this.handleAgentStart(live)
    } else if (runningStatusEvents.has(event.type)) {
      live.info.status = 'running'
      live.info.lastActivity = Date.now()
      saveInfo(live.info)
    } else if (event.type === 'message_end') {
      this.handleMessageEnd(live, event)
    } else if (event.type === 'agent_end') {
      this.handleAgentEnd(live, event)
    } else if (event.type === 'auto_retry_end' && event.success === false && event.finalError) {
      live.candidateError = event.finalError
    } else if (event.type === 'agent_settled') {
      this.handleAgentSettled(live)
    }
  }

  private handleLine(live: LiveAgent, line: string): void {
    if (!line.trim()) {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      parsed = undefined
    }
    if (!Check(SubagentRpcEventSchema, parsed)) {
      live.logger.info('rpc', 'ignored invalid JSON line', { line: line.slice(0, 1000) })
      return
    }
    const event = parsed
    live.broadcaster.broadcast(event)
    if (event.type === 'response') {
      this.handleResponseEvent(live, event)
      return
    }
    const persisted = readInfoFile(live.info.infoFile)
    if (persisted && FINAL_STATUSES.has(persisted.status) && persisted.status !== live.info.status) {
      live.info = persisted
      live.finalizedRun = true
      return
    }
    if (live.finalizedRun || live.expectedExit) {
      return
    }
    this.dispatchLiveEvent(live, event)
  }

  private markCompleted(live: LiveAgent): void {
    if (live.finalizedRun) {
      return
    }
    live.finalizedRun = true
    live.info.status = 'completed'
    live.info.finalResponse = live.candidateResponse
    delete live.info.error
    live.info.completedAt = Date.now()
    live.info.lastActivity = Date.now()
    saveInfo(live.info)
    this.notifyStatusChange(live.info)
    this.pushMailbox({
      agentName: live.info.canonicalName,
      createdAt: Date.now(),
      finalResponse: live.info.finalResponse,
      id: randomUUID(),
      parentSessionId: live.info.parentSessionId,
      status: 'completed',
      ...agentMetadata(live.info),
    })
  }

  private markFailed(live: LiveAgent, error: string): void {
    if (live.finalizedRun) {
      return
    }
    live.finalizedRun = true
    live.info.status = 'failed'
    live.info.error = error
    delete live.info.finalResponse
    live.info.completedAt = Date.now()
    live.info.lastActivity = Date.now()
    saveInfo(live.info)
    this.notifyStatusChange(live.info)
    this.pushMailbox({
      agentName: live.info.canonicalName,
      createdAt: Date.now(),
      error,
      id: randomUUID(),
      parentSessionId: live.info.parentSessionId,
      status: 'failed',
      ...agentMetadata(live.info),
    })
  }

  private removeMailboxEvents(parentSessionId: string, agentName: string): void {
    for (let index = this.mailbox.length - 1; index >= 0; index--) {
      const event = this.mailbox[index]
      if (event.parentSessionId === parentSessionId && event.agentName === agentName) {
        this.mailbox.splice(index, 1)
      }
    }
  }

  private pushMailbox(event: AgentCompletionEvent, notify = true): void {
    this.removeMailboxEvents(event.parentSessionId, event.agentName)
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.parentSessionId === event.parentSessionId && targetMatches(event, waiter.targets))
    if (waiterIndex !== -1) {
      const [waiter] = this.waiters.splice(waiterIndex, 1)
      waiter.resolve(event)
      return
    }
    this.mailbox.push(event)
    const matchingClaims = [...this.waitAllClaims].filter(
      (claim) => claim.parentSessionId === event.parentSessionId && claim.targets.has(event.agentName)
    )
    if (notify) {
      for (const claim of matchingClaims) {
        claim.suppressedEventIds.add(event.id)
      }
      if (!matchingClaims.length) {
        this.notifyUnclaimedCompletion(event)
      }
    }
  }

  listAgents(pathPrefix: string | undefined, parentSessionId: string, includeAll = false): AgentListEntry[] {
    const prefix = pathPrefix?.trim().replace(/^\/+/, '')
    const infos = includeAll ? readAllInfos() : readScopeInfos(parentSessionId)
    return infos
      .filter((info) => !prefix || info.taskName.startsWith(prefix))
      .map((info) => ({
        agent_name: info.canonicalName,
        agent_status: info.status,
        last_task_message: previewText(info.lastTaskMessage),
        ...(includeAll ? { parent_session_id: info.parentSessionId } : {}),
        ...(info.profile ? { profile: info.profile } : {}),
        color: persistedProfileColor(info.profile, info.color),
        ...(info.isReadonly === undefined ? {} : { is_readonly: info.isReadonly }),
      }))
  }

  getAgentInfo(target: string, parentSessionId: string): AgentInfo {
    const info = getAgent(target, parentSessionId)
    if (!info) {
      throw new Error(`Agent not found in this parent session: ${target}`)
    }
    return info
  }

  readAgentResponse(target: string, parentSessionId: string): AgentResponseEntry {
    return this.agentResponse(this.getAgentInfo(target, parentSessionId))
  }

  private agentResponse(info: AgentInfo): AgentResponseEntry {
    return {
      agent_name: info.canonicalName,
      status: info.status,
      ...(info.finalResponse === undefined ? {} : { finalResponse: info.finalResponse }),
      ...(info.error ? { error: info.error } : {}),
      last_task_message: previewText(info.lastTaskMessage),
      ...(info.profile ? { profile: info.profile } : {}),
      color: persistedProfileColor(info.profile, info.color),
      ...(info.isReadonly === undefined ? {} : { is_readonly: info.isReadonly }),
    }
  }

  private finishWaitTarget(parentSessionId: string, agentName: string): void {
    this.defaultWaitAllTargets.get(parentSessionId)?.delete(canonicalAgentName(agentName))
  }

  async waitAgent(parentSessionId: string, targets?: string[], signal?: AbortSignal): Promise<{ message: string; event?: AgentCompletionEvent }> {
    const waitSignal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    throwIfAborted(waitSignal)
    const normalizedTargets = targets?.length ? new Set(targets.map(canonicalAgentName)) : undefined
    const existing = consumeFirstMatchingMailboxEvent(this.mailbox, parentSessionId, normalizedTargets)
    if (existing) {
      this.finishWaitTarget(parentSessionId, existing.agentName)
      return {
        event: existing,
        message: `Wait completed: ${existing.agentName} ${existing.status}.`,
      }
    }
    if (normalizedTargets) {
      const targetInfos = readScopeInfos(parentSessionId).filter((info) => normalizedTargets.has(info.canonicalName))
      if (!targetInfos.length) {
        throw new Error(`Agent not found in this parent session: ${[...normalizedTargets].join(', ')}`)
      }
      const finalInfo = targetInfos.find((info) => FINAL_STATUSES.has(info.status))
      if (finalInfo) {
        this.finishWaitTarget(parentSessionId, finalInfo.canonicalName)
        return {
          event: {
            agentName: finalInfo.canonicalName,
            createdAt: Date.now(),
            error: finalInfo.error,
            finalResponse: finalInfo.finalResponse,
            id: randomUUID(),
            parentSessionId,
            status: finalInfo.status,
            ...agentMetadata(finalInfo),
          },
          message: `Wait completed: ${finalInfo.canonicalName} ${finalInfo.status}.`,
        }
      }
    }
    return await new Promise((resolve, reject) => {
      let settled = false
      const settle = (callback: () => void) => {
        if (settled) {
          return
        }
        settled = true
        waitSignal.removeEventListener('abort', onAbort)
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter)
        callback()
      }
      const onAbort = () => settle(() => reject(abortError(waitSignal)))
      const waiter: Waiter = {
        parentSessionId,
        resolve: (event) =>
          settle(() => {
            this.finishWaitTarget(parentSessionId, event.agentName)
            resolve({ event, message: `Wait completed: ${event.agentName} ${event.status}.` })
          }),
        targets: normalizedTargets,
      }
      this.waiters.push(waiter)
      waitSignal.addEventListener('abort', onAbort, { once: true })
      if (waitSignal.aborted) {
        onAbort()
      }
    })
  }

  async waitAllAgents(
    parentSessionId: string,
    targets?: string[],
    signal?: AbortSignal
  ): Promise<{ message: string; responses: AgentResponseEntry[] }> {
    const waitSignal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    throwIfAborted(waitSignal)
    const explicitTargets = targets?.length ? new Set(targets.map(canonicalAgentName)) : undefined
    const defaultTargets = this.defaultWaitAllTargets.get(parentSessionId) ?? new Set<string>()
    const targetSet = explicitTargets ?? new Set(defaultTargets)
    if (explicitTargets) {
      const infos = readScopeInfos(parentSessionId)
      const missing = [...explicitTargets].filter((target) => !infos.some((info) => target === info.canonicalName))
      if (missing.length) {
        throw new Error(`Agent not found in this parent session: ${missing.join(', ')}`)
      }
    }
    const matchingInfos = () => readScopeInfos(parentSessionId).filter((info) => targetSet.has(info.canonicalName))
    const pendingNames = () =>
      matchingInfos()
        .filter((info) => !FINAL_STATUSES.has(info.status))
        .map((info) => info.canonicalName)
    const finalize = () => {
      const responses = matchingInfos()
        .filter((info) => FINAL_STATUSES.has(info.status))
        .map((info) => this.agentResponse(info))
      for (const response of responses) {
        this.finishWaitTarget(parentSessionId, response.agent_name)
      }
      for (let index = this.mailbox.length - 1; index >= 0; index--) {
        const event = this.mailbox[index]
        if (event.parentSessionId === parentSessionId && targetSet.has(event.agentName)) {
          this.mailbox.splice(index, 1)
        }
      }
      return {
        message: 'All target agents reached final status.',
        responses,
      }
    }
    const claim = { parentSessionId, suppressedEventIds: new Set<string>(), targets: targetSet }
    this.waitAllClaims.add(claim)
    try {
      while (true) {
        throwIfAborted(waitSignal)
        if (!pendingNames().length) {
          return finalize()
        }
        await delay(250, undefined, { signal: waitSignal })
      }
    } finally {
      this.waitAllClaims.delete(claim)
      for (const eventId of claim.suppressedEventIds) {
        const event = this.mailbox.find((candidate) => candidate.id === eventId)
        if (!event) {
          continue
        }
        const claimedElsewhere = [...this.waitAllClaims].some(
          (candidate) => candidate.parentSessionId === event.parentSessionId && candidate.targets.has(event.agentName)
        )
        if (!claimedElsewhere) {
          this.notifyUnclaimedCompletion(event)
        }
      }
    }
  }

  async sendMessage(parentSessionId: string, target: string, message: string): Promise<{ delivery: 'steer' | 'prompt' }> {
    await this.reconciliation
    let info = this.getAgentInfo(target, parentSessionId)
    let live = this.live.get(info.id)
    if (live?.expectedExit) {
      await live.termination
      live = undefined
      info = this.getAgentInfo(target, parentSessionId)
    }
    const wasLive = Boolean(live)
    if (!live) {
      if (info.childProcess) {
        await this.terminateOwnedChild(info)
      }
      if (info.status === 'starting' || info.status === 'running') {
        info.status = 'interrupted'
        info.lastActivity = Date.now()
        saveInfo(info)
      }
      live = await this.startLiveAgent(info)
    }
    if (wasLive && (info.status === 'starting' || info.status === 'running')) {
      await this.sendCommand(live, { message, type: 'steer' })
      info.lastTaskMessage = message
      info.lastActivity = Date.now()
      saveInfo(info)
      return { delivery: 'steer' }
    }
    try {
      await this.prompt(live, message, message)
      return { delivery: 'prompt' }
    } catch (error) {
      await this.terminateProcess(live)
      throw error
    }
  }

  async interruptAgent(parentSessionId: string, target: string): Promise<{ previous_status: AgentRuntimeStatus }> {
    await this.reconciliation
    const info = this.getAgentInfo(target, parentSessionId)
    const previous = info.status
    if (previous !== 'starting' && previous !== 'running') {
      return { previous_status: previous }
    }
    const live = this.live.get(info.id)
    info.status = 'interrupted'
    info.lastActivity = Date.now()
    saveInfo(info)
    this.notifyStatusChange(info)
    if (live) {
      live.info.status = 'interrupted'
      live.info.lastActivity = info.lastActivity
      live.finalizedRun = true
      await this.terminateProcess(live)
    } else {
      await this.terminateOwnedChild(info)
    }
    this.finishWaitTarget(parentSessionId, info.canonicalName)
    this.pushMailbox(
      {
        agentName: info.canonicalName,
        createdAt: Date.now(),
        id: randomUUID(),
        parentSessionId,
        status: 'interrupted',
        ...agentMetadata(info),
      },
      false
    )
    return { previous_status: previous }
  }

  private signalProcessTree(live: LiveAgent, signal: NodeJS.Signals): void {
    try {
      if (this.platform !== 'win32' && live.proc.pid) {
        process.kill(-live.proc.pid, signal)
      } else {
        live.proc.kill(signal)
      }
    } catch {
      try {
        live.proc.kill(signal)
      } catch {
        // Best effort; the process may have already exited.
      }
    }
  }

  private async forceKillWindowsTree(live: LiveAgent): Promise<void> {
    if (this.platform !== 'win32' || !live.proc.pid) {
      return
    }
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(live.proc.pid), '/T', '/F'], {
        stdio: 'ignore',
      })
      killer.once('error', () => resolve())
      killer.once('exit', () => resolve())
    })
  }

  private terminateProcess(live: LiveAgent): Promise<void> {
    if (live.processFinished) {
      return Promise.resolve()
    }
    if (live.termination) {
      return live.termination
    }
    live.termination = (async () => {
      const abortRequest = this.sendCommand(live, { type: 'abort' }, 1000)
      live.expectedExit = true
      try {
        await abortRequest
      } catch {
        // Best effort; the child may already be exiting.
      }
      try {
        live.proc.stdin.end()
      } catch {
        // Best effort; the stream may already be closed.
      }
      await Promise.race([live.exitPromise, delay(500)])
      if (!live.processFinished) {
        this.signalProcessTree(live, 'SIGTERM')
        await Promise.race([live.exitPromise, delay(1000)])
      }
      if (!live.processFinished) {
        if (this.platform === 'win32') {
          await this.forceKillWindowsTree(live)
        } else {
          this.signalProcessTree(live, 'SIGKILL')
        }
        await Promise.race([live.exitPromise, delay(1000)])
      }
      if (!live.processFinished) {
        throw new Error(`Unable to terminate child Pi process for ${live.info.canonicalName}.`)
      }
    })()
    return live.termination
  }

  async shutdown(): Promise<void> {
    this.shutdownController.abort(new Error('Agent manager shut down.'))
    await this.reconciliation
    const terminations: Promise<void>[] = []
    for (const live of this.live.values()) {
      if (live.info.status === 'starting' || live.info.status === 'running') {
        live.info.status = 'interrupted'
        live.info.lastActivity = Date.now()
        live.finalizedRun = true
        saveInfo(live.info)
        this.notifyStatusChange(live.info)
      }
      terminations.push(this.terminateProcess(live))
    }
    await Promise.allSettled(terminations)
  }
}

export const writeFullToolOutput = (content: string): string => {
  const directory = join(getRunsDir(), '_outputs')
  ensurePrivateDir(directory, true)
  const file = join(directory, `${Date.now()}-${randomUUID()}.txt`)
  writeFileSync(file, content)
  return file
}
