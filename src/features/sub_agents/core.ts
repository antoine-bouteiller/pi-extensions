import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { homedir, tmpdir, userInfo } from 'node:os'

import { getAgentDir, migrateSessionEntries, parseSessionEntries, type SessionEntry, type ThemeColor } from '@earendil-works/pi-coding-agent'
import { Cause, Clock, Data, DateTime, Deferred, Effect, Exit, Fiber, HashMap, Option, Queue, Ref, Result, Scope, Semaphore, Stream } from 'effect'
import { ChildProcess } from 'effect/unstable/process'
import { type ChildProcessHandle } from 'effect/unstable/process/ChildProcessSpawner'
import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'

import {
  closeHeldFile,
  createHeldFile,
  heldFileContent,
  readHostDirectoryEntries,
  removeHeldFileIfUnchanged,
  withHeldFile,
  type HeldFile,
  type HostDirectoryEntry,
} from '#shared/effect/node_host_file_system'
import { nodeChildProcessSpawner, nodeFileSystem, nodePath, type NodeChildProcessSpawner } from '#shared/effect/node_services'
import { azureQuota, consumeSubagentAzureQuota } from '#shared/state/azure_quota'
import { jsonText, parseJsonText, prettyJsonText, type JsonObject } from '#shared/utils/json'
import { isEmptyString, isFalse, isNotEmptyString, isNotNullOrUndefined, isNullOrUndefined, isTrue } from '#shared/utils/predicates'
import { isRecord } from '#shared/utils/records'

import { buildChildEnv } from './child_env'
import {
  nodeProcessProbe,
  processAlive,
  processInspectorFromProbe,
  processOwnerIsActive,
  type ProcessInspectorApi,
  type ProcessSnapshot,
} from './process_ownership'
import {
  AGENT_CONFIGS,
  isClaudeModelId,
  persistedProfileColor,
  resolveAgentConfig,
  THEME_COLOR_VALUES,
  THINKING_LEVELS,
  type AgentProfileName,
  type AvailableModel,
  type ThinkingLevel,
} from './profiles'
import { consumeFirstMatchingMailboxEvent, RpcJsonlDecoder } from './rpc'

const { dirname, isAbsolute, join, resolve: resolvePath, sep } = nodePath
export { consumeFirstMatchingMailboxEvent, MAX_RPC_FRAME_CHARS, RpcJsonlDecoder } from './rpc'

const PACKAGE_BASENAME = 'pi-codex-subagents'
const SUBAGENT_DIR = join(getAgentDir(), PACKAGE_BASENAME)
const CONFIG_PATH = join(SUBAGENT_DIR, 'config.json')
const TEMP_ROOT = join(process.env.PI_SUBAGENT_TEMP_DIR || tmpdir(), PACKAGE_BASENAME, userInfo().username)
const LEGACY_RUNS_DIR = join(TEMP_ROOT, 'runs')
const SOCKET_DIR = join(TEMP_ROOT, 'sockets')

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const STDIN_BUFFER_CAPACITY = 64
const SHUTDOWN_LAUNCH_DRAIN_MS = 5000
/*
 * A grandchild that inherited the child's stdout or stderr keeps those pipes open after the child
 * itself exits, so waiting for EOF unconditionally would pin the live entry, its pending RPCs, and
 * its fibers until shutdown. Draining is bounded; closing `live.scope` then interrupts the readers.
 */
const POST_EXIT_DRAIN_MS = 2000
const DEFAULT_INACTIVITY_MINUTES = 5
const DEFAULT_RETENTION_DAYS = 7
const MAX_LIVE_CLAUDE_AGENTS = 3
const CLAUDE_CONTEXT_TOKEN_LIMIT = 112_000
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
  followUpUsed: Type.Optional(Type.Boolean()),
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
  inactivityMinutes?: number
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
  followUpUsed: boolean
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

export interface SpawnAgentOptions {
  signal?: AbortSignal
  waitForCompletion?: boolean
}

export interface SpawnAgentResult {
  task_name: string
  nickname: undefined
  profile: string
  color: ThemeColor
  is_readonly: boolean
  execution: 'foreground' | 'background'
  completion?: AgentCompletionEvent
}

interface LiveAgent {
  info: AgentInfo
  proc: ChildProcessHandle
  stdin: Queue.Queue<Uint8Array, Cause.Done>
  broadcaster: EventBroadcaster
  logger: SessionLogger
  pending: Ref.Ref<HashMap.HashMap<string, Deferred.Deferred<unknown, SubagentProcessError>>>
  childToken: string
  reqId: number
  stderr: string
  streamError?: SubagentProcessError
  expectedExit: boolean
  /** The OS process is gone. Flipped before output drains, unlike `processFinished`. */
  processExited: boolean
  processFinished: boolean
  finalizedRun: boolean
  exit: Deferred.Deferred<void>
  exited: Deferred.Deferred<void>
  termination?: Fiber.Fiber<void, SubagentError>
  inactivityTimeoutMs: number
  inactivityTimer?: NodeJS.Timeout
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

export interface AgentInactivityEvent {
  parentSessionId: string
  agentName: string
  inactiveForMs: number
  lastActivity: number
  profile?: string
  color: ThemeColor
  isReadonly?: boolean
}

export interface AgentManagerOptions {
  onActivityChange?: (event: AgentActivityEvent) => void
  onInactivity?: (event: AgentInactivityEvent) => void
  onUnclaimedCompletion?: (event: AgentCompletionEvent) => void
  /** Override the child Pi executable for embedding and tests. */
  piCommand?: {
    command: string
    prefixArgs?: string[]
  }
  /** Additional environment entries passed only to child Pi processes. */
  childEnv?: NodeJS.ProcessEnv
  /** Override the configured inactivity delay for tests. Set to 0 to disable monitoring. */
  inactivityTimeoutMs?: number
  /** Test hook invoked after a dead lock is inspected but before its instance is revalidated. */
  beforeReclaimTaskLockRemoval?: (lockFile: string) => Effect.Effect<void, Cause.UnknownError>
  /** Test hook invoked after a held lock is released normally but before its instance is revalidated. */
  beforeReleaseTaskLockRemoval?: (lockFile: string) => Effect.Effect<void, Cause.UnknownError>
  /** Override process identity inspection so tests can drive Linux/Darwin/Windows branches on any host. */
  processInspector?: ProcessInspectorApi
  processSpawner?: NodeChildProcessSpawner
  afterProcessSpawn?: () => Effect.Effect<void>
  /** Override the platform used to choose between POSIX signals and Windows taskkill for tests. */
  platform?: NodeJS.Platform
  /** Scales how long termination waits for a child that refuses to exit. Tests shrink it; production keeps 1. */
  exitWaitScale?: number
}

interface Waiter {
  foreground: boolean
  parentSessionId: string
  targets?: Set<string>
  deferred: Deferred.Deferred<AgentCompletionEvent, SubagentError>
}

interface WaiterClaim {
  /** Settles with the first matching completion, or fails with the caller's abort reason. */
  readonly await: Effect.Effect<AgentCompletionEvent, SubagentError>
  /** Withdraws the claim, returning false when a completion was already delivered to it. */
  readonly withdraw: () => boolean
}

interface SpawnExecution {
  foreground: boolean
  signal: AbortSignal
  shutdownSignal: AbortSignal
}

interface LaunchSpawnOptions extends SpawnExecution {
  releaseLock: () => Effect.Effect<void>
}

interface FollowUpClaim {
  handle: HeldFile
  file: string
  token: string
  settled: boolean
}

interface WaitAllClaim {
  parentSessionId: string
  targets: Set<string>
  suppressedEventIds: Set<string>
}

/** Every `AgentManager` effect fails with this; `cause` carries the caller's abort reason or the underlying error. */
class SubagentError extends Data.TaggedError('SubagentError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

class SubagentProcessError extends Data.TaggedError('SubagentProcessError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

type SubagentFailure = SubagentError | SubagentProcessError

const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const errorCode = (cause: unknown): unknown => {
  if (typeof cause !== 'object' || cause === null) {
    return undefined
  }
  if ('code' in cause) {
    return cause.code
  }
  return 'cause' in cause ? errorCode(cause.cause) : undefined
}

const subagentError = (message: string, cause?: unknown): SubagentError => new SubagentError({ cause, message })

const claudeLaunchLimitError = (): SubagentError =>
  subagentError(`At most ${MAX_LIVE_CLAUDE_AGENTS} Claude-backed subagents may run at once. Wait for one to finish or use a non-Claude profile.`)

const subagentProcessError = (message: string, cause?: unknown): SubagentProcessError => new SubagentProcessError({ cause, message })

/*
 * The single wall-clock read for this module's synchronous layers: atomic persistence, the child-stdout
 * callbacks, and the predicates Pi calls from TUI paint passes. Effect paths read `Clock` instead.
 */
const nowMs = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe())

const abortError = (signal?: AbortSignal): unknown => signal?.reason ?? new Error('Wait canceled.')

/** Keeps the caller's abort reason as `cause`, so callers can still compare it against `signal.reason`. */
const abortFailure = (signal?: AbortSignal): SubagentError => {
  const reason = abortError(signal)
  return subagentError(causeMessage(reason), reason)
}

const failIfAborted = (signal: AbortSignal): Effect.Effect<void, SubagentError> =>
  Effect.suspend(() => (signal.aborted ? Effect.fail(abortFailure(signal)) : Effect.void))

const awaitAbort = (signal: AbortSignal): Effect.Effect<never, SubagentError> =>
  Effect.callback<never, SubagentError>((resume) => {
    const abort = (): void => resume(Effect.fail(abortFailure(signal)))
    if (signal.aborted) {
      abort()
      return Effect.void
    }
    signal.addEventListener('abort', abort, { once: true })
    return Effect.sync(() => signal.removeEventListener('abort', abort))
  })

const spawnExecution = (options: SpawnAgentOptions, shutdownSignal: AbortSignal): SpawnExecution => ({
  foreground: isTrue(options.waitForCompletion),
  shutdownSignal,
  signal: options.signal === undefined ? shutdownSignal : AbortSignal.any([options.signal, shutdownSignal]),
})

/*
 * A background launch deliberately outlives its caller's abort, but never the manager: once shutdown
 * has started it must not publish a child, whose lifecycle fibers would attach to a scope shutdown
 * has already scanned and closed.
 */
const failIfLaunchAborted = (execution: SpawnExecution): Effect.Effect<void, SubagentError> =>
  failIfAborted(execution.foreground ? execution.signal : execution.shutdownSignal)

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
  const inactivityMinutes =
    typeof raw.inactivityMinutes === 'number' && Number.isFinite(raw.inactivityMinutes) && raw.inactivityMinutes >= 0
      ? raw.inactivityMinutes
      : undefined
  const retentionDays =
    typeof raw.retentionDays === 'number' && Number.isFinite(raw.retentionDays) && raw.retentionDays >= 0 ? raw.retentionDays : undefined
  const config: SubagentConfig = {}
  if (typeof raw.storageDir === 'string' && isNotEmptyString(raw.storageDir.trim())) {
    config.storageDir = raw.storageDir.trim()
  }
  if (inactivityMinutes !== undefined) {
    config.inactivityMinutes = inactivityMinutes
  }
  if (retentionDays !== undefined) {
    config.retentionDays = retentionDays
  }
  return config
}

/** An absent or malformed config file means defaults; an unreadable one is a real failure and must not be hidden. */
const loadSubagentConfigEffect = (): Effect.Effect<SubagentConfig> =>
  nodeFileSystem.readFileString(CONFIG_PATH).pipe(
    Effect.matchEffect({
      onFailure: (error) => (isMissingFileError(error) ? Effect.succeed<SubagentConfig>({}) : Effect.die(error)),
      onSuccess: (content) => Effect.try(() => normalizeConfig(parseJsonText(content))).pipe(Effect.orElseSucceed((): SubagentConfig => ({}))),
    })
  )

const DEFAULT_RUNS_DIR = join(SUBAGENT_DIR, 'runs')
let configuredRunsDir = DEFAULT_RUNS_DIR

const runsDirFromConfig = (config: SubagentConfig): string => {
  const configured = config.storageDir
  if (isNotNullOrUndefined(configured) && isNotEmptyString(configured)) {
    const expanded = expandHome(configured)
    return isAbsolute(expanded) ? expanded : resolvePath(SUBAGENT_DIR, expanded)
  }
  return DEFAULT_RUNS_DIR
}

export const getRunsDir = (): string => configuredRunsDir

const ensurePrivateDirEffect = (directory: string, enforceMode = false): Effect.Effect<void> =>
  Effect.gen(function* () {
    const existed = yield* nodeFileSystem.exists(directory)
    yield* nodeFileSystem.makeDirectory(directory, { mode: 0o700, recursive: true })
    if (process.platform !== 'win32' && (enforceMode || !existed)) {
      yield* nodeFileSystem.chmod(directory, 0o700)
    }
  }).pipe(Effect.orDie)

const ensureBaseDirsEffect = (config: SubagentConfig): Effect.Effect<void> =>
  Effect.gen(function* () {
    configuredRunsDir = runsDirFromConfig(config)
    const { storageDir } = config
    yield* ensurePrivateDirEffect(getRunsDir(), isNullOrUndefined(storageDir) || isEmptyString(storageDir))
    yield* ensurePrivateDirEffect(SOCKET_DIR, true)
  })

const SCOPE_DIR_PATTERN = /^[0-9a-f]{24}$/
const AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OUTPUT_FILE_PATTERN = /^\d+-[0-9a-f-]{36}\.txt$/i
const TASK_LOCK_PATTERN = /^\.task-[0-9a-f]{24}\.lock$/

const isAgentArtifact = (name: string, agentId: string): boolean =>
  name === `${agentId}.jsonl` ||
  name === `${agentId}.info.json` ||
  name === `${agentId}.log` ||
  name === `${agentId}.follow-up` ||
  new RegExp(`^${agentId}[.]info[.]json[.][0-9]+[.]tmp$`).test(name)

const fileMtimeMs = (path: string): Effect.Effect<number> =>
  nodeFileSystem.stat(path).pipe(
    Effect.map((info) => Option.match(info.mtime, { onNone: () => 0, onSome: (mtime) => mtime.getTime() })),
    Effect.orElseSucceed(() => 0)
  )

const latestArtifactMtime = (directory: string, agentEntries: HostDirectoryEntry[]): Effect.Effect<number> =>
  Effect.all(agentEntries.map((artifact) => fileMtimeMs(join(directory, artifact.name)))).pipe(Effect.map((mtimes) => Math.max(0, ...mtimes)))

const removeAgentArtifacts = (directory: string, artifacts: HostDirectoryEntry[]): Effect.Effect<boolean> =>
  Effect.all(artifacts.map((artifact) => Effect.exit(nodeFileSystem.remove(join(directory, artifact.name), { force: true })))).pipe(
    Effect.map((exits) => exits.some((exit) => Exit.isFailure(exit)))
  )

interface PruneAgentEntryParams {
  directory: string
  entries: HostDirectoryEntry[]
  entry: HostDirectoryEntry
  cutoff: number
}

const pruneAgentEntry = ({ directory, entries, entry, cutoff }: PruneAgentEntryParams): Effect.Effect<void> =>
  Effect.gen(function* () {
    const agentId = entry.name.slice(0, -'.info.json'.length)
    if (!AGENT_ID_PATTERN.test(agentId)) {
      return
    }
    const info = yield* readInfoFileEffect(join(directory, entry.name))
    const agentEntries = entries.filter((candidate) => candidate.isFile && isAgentArtifact(candidate.name, agentId))
    const baseline = Math.max(info?.lastActivity ?? 0, info?.updatedAt ?? 0, info?.createdAt ?? 0)
    const latest = Math.max(baseline, yield* latestArtifactMtime(directory, agentEntries))
    if ((yield* isRunActive(agentId)) || latest >= cutoff) {
      return
    }
    const otherArtifacts = agentEntries.filter((candidate) => candidate.name !== entry.name)
    if (yield* removeAgentArtifacts(directory, otherArtifacts)) {
      return
    }
    yield* nodeFileSystem.remove(join(directory, entry.name), { force: true }).pipe(Effect.ignore)
  })

const pruneStaleTaskLock = (directory: string, entry: HostDirectoryEntry, cutoff: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const lockFile = join(directory, entry.name)
    if ((yield* fileMtimeMs(lockFile)) >= cutoff) {
      return
    }
    yield* reclaimDeadTaskLock(lockFile)
  })

const pruneScope = (directory: string, cutoff: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const entries = yield* readHostDirectoryEntries(directory)
    yield* Effect.forEach(
      entries.filter((entry) => entry.isFile && entry.name.endsWith('.info.json')),
      (entry) => pruneAgentEntry({ cutoff, directory, entries, entry }),
      { discard: true }
    )
    yield* Effect.forEach(
      entries.filter((entry) => entry.isFile && TASK_LOCK_PATTERN.test(entry.name)),
      (entry) => pruneStaleTaskLock(directory, entry, cutoff),
      { discard: true }
    )
    yield* nodeFileSystem.remove(directory).pipe(Effect.ignore)
  }).pipe(Effect.ignore)

const pruneOutputFiles = (target: string, cutoff: number): Effect.Effect<void> =>
  readHostDirectoryEntries(target).pipe(
    Effect.flatMap((outputs) =>
      Effect.forEach(
        outputs.filter((output) => output.isFile && OUTPUT_FILE_PATTERN.test(output.name)),
        (output) =>
          Effect.gen(function* () {
            const outputPath = join(target, output.name)
            if ((yield* fileMtimeMs(outputPath)) < cutoff) {
              yield* nodeFileSystem.remove(outputPath, { force: true }).pipe(Effect.ignore)
            }
          }),
        { discard: true }
      )
    ),
    Effect.ignore
  )

const pruneRunsRoot = (root: string, cutoff: number): Effect.Effect<void> =>
  readHostDirectoryEntries(root).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries,
        (entry) => {
          const target = join(root, entry.name)
          if (entry.name === '_outputs' && entry.isDirectory) {
            return pruneOutputFiles(target, cutoff)
          }
          return entry.isDirectory && SCOPE_DIR_PATTERN.test(entry.name) ? pruneScope(target, cutoff) : Effect.void
        },
        { discard: true }
      )
    ),
    Effect.ignore
  )

const pruneExpiredRuns = (config: SubagentConfig): Effect.Effect<void> =>
  Effect.gen(function* () {
    const retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS
    if (retentionDays === 0) {
      return
    }
    const cutoff = (yield* Clock.currentTimeMillis) - retentionDays * 24 * 60 * 60 * 1000
    yield* Effect.forEach(runsRoots(), (root) => pruneRunsRoot(root, cutoff), { discard: true })
  })

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

const taskLockIsActive = (parentSessionId: string, taskName: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const content = yield* nodeFileSystem.readFileString(taskLockFile(parentSessionId, taskName))
    // A half-written lock is a normal race, not a defect: `Effect.try` keeps it a typed failure the fallback below recovers.
    const owner = yield* Effect.try(() => parseJsonText(content))
    return Check(TaskLockOwnerSchema, owner) && (yield* processOwnerIsActive(owner))
  }).pipe(Effect.orElseSucceed(() => false))

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

const reclaimDeadTaskLock = (
  lockFile: string,
  beforeRevalidate?: (lockFile: string) => Effect.Effect<void, Cause.UnknownError>
): Effect.Effect<boolean> =>
  withHeldFile(
    lockFile,
    (inspected) =>
      Effect.gen(function* () {
        const inspectedContent = heldFileContent(inspected)
        if (yield* processOwnerIsActive(parseTaskLockOwner(inspectedContent))) {
          return false
        }
        return yield* removeHeldFileIfUnchanged({
          beforeRevalidate,
          contentMatches: (content) => content === inspectedContent,
          handle: inspected,
          path: lockFile,
        })
      })
    // A lock this pass could not reclaim is left for the next one.
  ).pipe(Effect.orElseSucceed(() => false))

const releaseTaskLock = (
  lockFile: string,
  owned: HeldFile,
  token: string,
  beforeRevalidate?: (lockFile: string) => Effect.Effect<void, Cause.UnknownError>
): Effect.Effect<void> =>
  removeHeldFileIfUnchanged({
    beforeRevalidate,
    contentMatches: (content) => parseTaskLockOwner(content).token === token,
    handle: owned,
    path: lockFile,
  }).pipe(
    Effect.asVoid,
    // A lock file that cannot be removed is reclaimed by the next creation attempt once this pid is gone.
    Effect.ignore,
    Effect.ensuring(Effect.sync(() => closeHeldFile(owned)))
  )

const infoWrites = Semaphore.makeUnsafe(1)
const infoCache = new Map<string, AgentInfo>()

const saveInfo = (info: AgentInfo): Effect.Effect<void> =>
  infoWrites
    .withPermits(1)(
      Effect.gen(function* () {
        yield* nodeFileSystem.makeDirectory(dirname(info.infoFile), { mode: 0o700, recursive: true })
        info.updatedAt = yield* Clock.currentTimeMillis
        const snapshot = structuredClone(info)
        const temporary = `${info.infoFile}.${process.pid}.tmp`
        yield* nodeFileSystem.writeFileString(temporary, prettyJsonText(snapshot), { mode: 0o600 })
        yield* nodeFileSystem.rename(temporary, info.infoFile)
        infoCache.set(info.infoFile, snapshot)
      })
    )
    .pipe(Effect.orDie)

const closedStoredStatus = (parsed: Static<typeof StoredAgentInfoSchema>): AgentRuntimeStatus => {
  if (isNotNullOrUndefined(parsed.error) && isNotEmptyString(parsed.error)) {
    return 'failed'
  }
  return parsed.finalResponse === undefined ? 'interrupted' : 'completed'
}

const parseInfoFile = (file: string, content: string): AgentInfo | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  if (!Check(StoredAgentInfoSchema, parsed)) {
    return undefined
  }
  const status: AgentRuntimeStatus = parsed.status === 'closed' ? closedStoredStatus(parsed) : parsed.status
  const info: AgentInfo & { closedAt?: number } = {
    ...parsed,
    canonicalName: parsed.canonicalName ?? canonicalAgentName(parsed.taskName),
    cwd: parsed.cwd ?? '',
    followUpUsed: parsed.followUpUsed ?? false,
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
}

const publishInfoSnapshot = (file: string, info: AgentInfo | undefined): void => {
  if (info === undefined) {
    return
  }
  const current = infoCache.get(file)
  if (current === undefined || info.updatedAt > current.updatedAt) {
    infoCache.set(file, info)
  }
}

const isMissingFileError = (error: unknown): boolean => {
  const candidate = Cause.isUnknownError(error) ? error.cause : error
  return (
    isRecord(candidate) &&
    ((isRecord(candidate.reason) && candidate.reason._tag === 'NotFound') || candidate.code === 'ENOENT' || candidate.code === 'ENOTDIR')
  )
}

const readInfoFileEffect = (file: string) =>
  nodeFileSystem.readFileString(file).pipe(
    Effect.map((content) => parseInfoFile(file, content)),
    Effect.tap((info) => Effect.sync(() => publishInfoSnapshot(file, info))),
    Effect.catch((error) => (isMissingFileError(error) ? Effect.as(Effect.void, undefined as AgentInfo | undefined) : Effect.die(error)))
  )

const readInfos = (directory: string) =>
  nodeFileSystem.readDirectory(directory).pipe(
    Effect.flatMap((names) =>
      Effect.forEach(
        names.filter((name) => name.endsWith('.info.json')),
        (name) => readInfoFileEffect(join(directory, name))
      )
    ),
    Effect.map((infos) => infos.filter(isNotNullOrUndefined)),
    Effect.catch((error) => (isMissingFileError(error) ? Effect.succeed([]) : Effect.die(error)))
  )

const sortInfos = (infos: AgentInfo[]): AgentInfo[] =>
  infos.toSorted((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))

const readScopeInfos = (parentSessionId: string) =>
  infoWrites.withPermits(1)(
    Effect.forEach(scopeDirs(parentSessionId), readInfos).pipe(
      Effect.map((infos) => sortInfos(infos.flat())),
      Effect.tap((infos) =>
        Effect.sync(() => {
          const observed = new Set(infos.map((info) => info.infoFile))
          for (const [file, cached] of infoCache) {
            if (cached.parentSessionId === parentSessionId && !observed.has(file)) {
              infoCache.delete(file)
            }
          }
        })
      )
    )
  )

const readAllInfos = () => {
  const roots = runsRoots()
  return infoWrites.withPermits(1)(
    Effect.all(
      roots.map((root) =>
        readHostDirectoryEntries(root).pipe(
          Effect.map((entries) =>
            entries.filter((entry) => entry.isDirectory && SCOPE_DIR_PATTERN.test(entry.name)).map((entry) => join(root, entry.name))
          ),
          Effect.catch((error) => (isMissingFileError(error) ? Effect.succeed([]) : Effect.die(error)))
        )
      )
    ).pipe(
      Effect.flatMap((directories) => Effect.forEach(directories.flat(), readInfos)),
      Effect.map((infos) => sortInfos(infos.flat())),
      Effect.tap((infos) =>
        Effect.sync(() => {
          const observed = new Set(infos.map((info) => info.infoFile))
          for (const file of infoCache.keys()) {
            if (roots.some((root) => file.startsWith(`${root}${sep}`)) && !observed.has(file)) {
              infoCache.delete(file)
            }
          }
        })
      )
    )
  )
}

export const getAgent = (name: string, parentSessionId: string): Effect.Effect<AgentInfo | undefined> => {
  const taskName = normalizeTaskName(name)
  return readScopeInfos(parentSessionId).pipe(Effect.map((infos) => infos.find((info) => info.taskName === taskName)))
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

const markActive = (agentId: string, kind: 'active' | 'peek', marker: PeekMarker): Effect.Effect<void> =>
  Effect.gen(function* () {
    const file = markerPath(agentId, kind)
    const temporary = `${file}.${marker.token}.tmp`
    yield* nodeFileSystem.writeFileString(temporary, prettyJsonText(marker), { mode: 0o600 })
    yield* nodeFileSystem.rename(temporary, file)
  }).pipe(Effect.orDie)

const clearActive = (agentId: string, kind: 'active' | 'peek', owner?: Pick<PeekMarker, 'pid' | 'token'>): Effect.Effect<void> => {
  const file = markerPath(agentId, kind)
  return withHeldFile(file, (held) =>
    Effect.gen(function* () {
      const inspectedContent = heldFileContent(held)
      const current = yield* Effect.try(() => parseJsonText(inspectedContent))
      if (owner !== undefined && (!Check(PeekMarkerPartialSchema, current) || current.pid !== owner.pid || current.token !== owner.token)) {
        return
      }
      yield* removeHeldFileIfUnchanged({
        contentMatches: (content) => content === inspectedContent,
        handle: held,
        path: file,
      })
    })
  ).pipe(Effect.ignore)
}

const markerIsActive = (agentId: string, kind: 'active' | 'peek'): Effect.Effect<boolean> => {
  const file = markerPath(agentId, kind)
  return withHeldFile(file, (held) =>
    Effect.gen(function* () {
      const inspectedContent = heldFileContent(held)
      const marker = yield* Effect.try(() => parseJsonText(inspectedContent))
      if (!Check(PeekMarkerSchema, marker)) {
        return false
      }
      if (yield* processAlive(marker.pid)) {
        return true
      }
      yield* removeHeldFileIfUnchanged({
        contentMatches: (content) => content === inspectedContent,
        handle: held,
        path: file,
      })
      return false
    })
  ).pipe(Effect.orElseSucceed(() => false))
}

const isRunActive = (agentId: string): Effect.Effect<boolean> =>
  Effect.all([markerIsActive(agentId, 'active'), markerIsActive(agentId, 'peek')], { concurrency: 2 }).pipe(
    Effect.map(([active, peek]) => active || peek)
  )

export const isPeekActive = (agentId: string): Effect.Effect<boolean> => markerIsActive(agentId, 'peek')

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

interface SessionLogEntry {
  category: string
  data?: unknown
  level: string
  message: string
  ts: string
}

class SessionLogger {
  private readonly file: string
  private readonly writes = Semaphore.makeUnsafe(1)
  constructor(file: string) {
    this.file = file
  }
  private write(entry: { level: string; category: string; message: string; data?: unknown }): Effect.Effect<void> {
    const { level, category, message, data } = entry
    const loggedEntry: SessionLogEntry = {
      category,
      level,
      message,
      ts: DateTime.formatIso(DateTime.nowUnsafe()),
    }
    if (data !== undefined) {
      loggedEntry.data = data
    }
    const line = `${JSON.stringify(loggedEntry)}\n`
    return this.writes.withPermits(1)(
      nodeFileSystem
        .makeDirectory(dirname(this.file), { mode: 0o700, recursive: true })
        .pipe(Effect.andThen(nodeFileSystem.writeFileString(this.file, line, { flag: 'a', mode: 0o600 })), Effect.ignore)
    )
  }
  info(category: string, message: string, data?: unknown): Effect.Effect<void> {
    return this.write({ category, data, level: 'INFO', message })
  }
  stderr(chunk: string): Effect.Effect<void> {
    return this.write({ category: 'pi-process', level: 'STDERR', message: chunk.trim() })
  }
}

const broadcasterOwners = new Map<string, string>()
const broadcasterMutations = Semaphore.makeUnsafe(1)
const MAX_PEEK_PENDING_BYTES = 4 * 1024 * 1024

class EventBroadcaster {
  private server: Server | undefined = undefined
  private connections: Socket[] = []
  private readonly marker: PeekMarker = {
    pid: process.pid,
    startedAt: nowMs(),
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

  start(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      broadcasterOwners.set(this.agentId, this.marker.token)
      yield* broadcasterMutations.withPermits(1)(
        Effect.suspend(() => {
          if (!this.isCurrentOwner()) {
            return Effect.void
          }
          return Effect.gen({ self: this }, function* () {
            yield* ensurePrivateDirEffect(SOCKET_DIR, true)
            yield* markActive(this.agentId, 'active', this.marker)
            const socketPath = getSocketPath(this.agentId)
            if (process.platform !== 'win32') {
              yield* nodeFileSystem.remove(socketPath, { force: true }).pipe(Effect.ignore)
            }
            this.openSocket(socketPath)
          })
        })
      )
    })
  }

  private isCurrentOwner(): boolean {
    return broadcasterOwners.get(this.agentId) === this.marker.token
  }

  private publishPeekMarker(): Effect.Effect<void> {
    return broadcasterMutations.withPermits(1)(
      Effect.suspend(() => (this.isCurrentOwner() ? markActive(this.agentId, 'peek', this.marker) : Effect.void))
    )
  }

  /**
   * A peek overlay that stops reading would otherwise let events pile up in its socket buffer.
   * Dropping the slow client bounds the parent's memory; peek is a best-effort view and the
   * overlay can reconnect.
   */
  private writeBounded(connection: Socket, line: string): void {
    try {
      connection.write(line)
      if (connection.writableLength > MAX_PEEK_PENDING_BYTES) {
        connection.destroy()
      }
    } catch {
      // Best effort; a connection that closed mid-write is not an error.
    }
  }

  private openSocket(socketPath: string): void {
    this.server = createServer((connection) => {
      this.connections.push(connection)
      this.writeBounded(
        connection,
        `${JSON.stringify({
          activeTools: [...this.activeTools.values()],
          partialMessage: this.partialMessage,
          status: this.status,
          toolName: this.toolName,
          type: 'sync',
          userMessage: this.userMessage,
        } satisfies SyncBroadcastEvent)}\n`
      )
      const remove = () => {
        this.connections = this.connections.filter((candidate) => candidate !== connection)
      }
      connection.on('close', remove)
      connection.on('error', remove)
    })
    this.server.on('listening', () => Effect.runFork(this.publishPeekMarker()))
    this.server.on('error', () => Effect.runFork(this.stopSocket()))
    try {
      this.server.listen(socketPath)
    } catch {
      Effect.runFork(this.stopSocket())
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
    if (
      isNotNullOrUndefined(event.toolCallId) &&
      isNotEmptyString(event.toolCallId) &&
      isNotNullOrUndefined(event.toolName) &&
      isNotEmptyString(event.toolName)
    ) {
      this.activeTools.set(event.toolCallId, {
        args: event.args,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      })
    }
  }

  private applyToolExecutionUpdate(event: SubagentRpcEvent): void {
    if (isNullOrUndefined(event.toolCallId) || isEmptyString(event.toolCallId)) {
      return
    }
    const active = this.activeTools.get(event.toolCallId)
    if (active !== undefined) {
      active.partialResult = event.partialResult
    }
  }

  private applyToolExecutionEnd(event: SubagentRpcEvent): void {
    if (isNullOrUndefined(event.toolCallId) || isEmptyString(event.toolCallId)) {
      return
    }
    const active = this.activeTools.get(event.toolCallId)
    if (active !== undefined) {
      active.result = event.result
      active.isError = event.isError ?? false
    }
  }

  private applyMessageEnd(event: SubagentRpcEvent): void {
    if (event.message?.role === 'toolResult' && isNotNullOrUndefined(event.message.toolCallId) && isNotEmptyString(event.message.toolCallId)) {
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
      this.writeBounded(connection, line)
    }
  }

  private stopSocket(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      yield* clearActive(this.agentId, 'peek', this.marker)
      yield* Effect.sync(() => this.closeConnections())
    })
  }

  private closeConnections(): void {
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
  }

  stop(): Effect.Effect<void> {
    return clearActive(this.agentId, 'active', this.marker).pipe(
      Effect.andThen(this.stopSocket()),
      Effect.andThen(
        Effect.sync(() => {
          if (this.isCurrentOwner()) {
            broadcasterOwners.delete(this.agentId)
          }
        })
      )
    )
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
  if (isNullOrUndefined(text) || isEmptyString(text)) {
    return undefined
  }
  const normalized = text.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
}

interface AgentMetadata {
  color: ThemeColor
  isReadonly?: boolean
  profile?: string
}

const agentMetadata = (info: AgentInfo): AgentMetadata => {
  const metadata: AgentMetadata = { color: persistedProfileColor(info.profile, info.color) }
  if (isNotNullOrUndefined(info.profile) && isNotEmptyString(info.profile)) {
    metadata.profile = info.profile
  }
  if (info.isReadonly !== undefined) {
    metadata.isReadonly = info.isReadonly
  }
  return metadata
}

const getPiCommand = (override?: AgentManagerOptions['piCommand']) => {
  const configuredPiBin = process.env.PI_SUBAGENT_PI_BIN
  return Effect.gen(function* () {
    if (override !== undefined) {
      return { command: override.command, prefixArgs: override.prefixArgs ?? [] }
    }
    if (isNotNullOrUndefined(configuredPiBin) && isNotEmptyString(configuredPiBin)) {
      return { command: configuredPiBin, prefixArgs: [] }
    }
    const [, currentEntry] = process.argv
    return isNotEmptyString(currentEntry) && (yield* nodeFileSystem.exists(currentEntry).pipe(Effect.orElseSucceed(() => false)))
      ? { command: process.execPath, prefixArgs: [currentEntry] }
      : { command: process.execPath, prefixArgs: [] }
  })
}

const canonicalAgentName = (target: string): string => (target.startsWith('/') ? target : `/${target}`)

const stopReasonError = (stopReason: string | undefined, errorMessage: string | undefined): string | undefined => {
  if (stopReason !== 'error' && stopReason !== 'aborted') {
    return undefined
  }
  return isNotNullOrUndefined(errorMessage) && isNotEmptyString(errorMessage) ? errorMessage : `Agent ended with ${stopReason}.`
}

const targetMatches = (event: AgentCompletionEvent, targets?: Set<string>): boolean => targets === undefined || targets.has(event.agentName)

const latestContextTokens = (sessionFile: string): Effect.Effect<number | undefined> =>
  Effect.gen(function* () {
    const entries = parseSessionEntries(yield* nodeFileSystem.readFileString(sessionFile))
    migrateSessionEntries(entries)
    const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== 'session')
    const byId = new Map(sessionEntries.map((entry) => [entry.id, entry]))
    const branch: SessionEntry[] = []
    let current = sessionEntries.at(-1)
    while (current !== undefined) {
      branch.push(current)
      current = current.parentId === null ? undefined : byId.get(current.parentId)
    }
    const latestAssistant = branch.find((entry) => entry.type === 'message' && entry.message.role === 'assistant')
    if (latestAssistant?.type !== 'message' || latestAssistant.message.role !== 'assistant') {
      return undefined
    }
    const { input, cacheRead, cacheWrite } = latestAssistant.message.usage
    return [input, cacheRead, cacheWrite].every((value) => Number.isFinite(value) && value >= 0) ? input + cacheRead + cacheWrite : undefined
  }).pipe(Effect.orElseSucceed(() => undefined))

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
      isTrue(info.isReadonly)
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
  if (info.thinking !== undefined) {
    args.push('--thinking', info.thinking)
  }
  const tools = info.allowedTools?.join(',') ?? info.tools
  if (tools !== undefined) {
    if (tools.length > 0) {
      args.push('--tools', tools)
    } else {
      args.push('--no-builtin-tools')
    }
  }
  return args
}

/** Only a definite `mismatch` proves the child is gone; an unverifiable probe keeps us waiting. */
const waitForOwnedExit = (inspector: ProcessInspectorApi, ownership: ChildProcessOwnership, timeoutMs: number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if ((yield* inspector.ownershipVerdict(ownership)) === 'mismatch') {
        return true
      }
      yield* Effect.sleep(25)
    }
    return (yield* inspector.ownershipVerdict(ownership)) === 'mismatch'
  })

/**
 * Wait for an identity that survives two consecutive reads. A launcher such as a shebang
 * script or a bin shim replaces the command line in place while keeping the PID, so the
 * first readable identity can describe the launcher instead of the child Pi process.
 */
const verifyChildOwnership = (inspector: ProcessInspectorApi, pid: number, token: string): Effect.Effect<ProcessSnapshot, SubagentProcessError> =>
  Effect.gen(function* () {
    let previous: ProcessSnapshot | undefined
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = yield* inspector.inspect(pid, token)
      if (isNotNullOrUndefined(candidate) && !isFalse(candidate.tokenMatches) && candidate.identity === previous?.identity) {
        return candidate
      }
      previous = candidate
      yield* Effect.sleep(10)
    }
    return yield* new SubagentProcessError({ message: 'Unable to verify child Pi process ownership.' })
  })

/** Signals the whole detached group first, then the bare PID, because only the group reaches the child's own children. */
const signalProcessGroup = (pid: number, signal: NodeJS.Signals, useGroup: boolean): void => {
  try {
    process.kill(useGroup ? -pid : pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Best effort; the process may have already exited.
    }
  }
}

export class AgentManager {
  private readonly live = new Map<string, LiveAgent>()
  private readonly mailbox: AgentCompletionEvent[] = []
  private waiters: Waiter[] = []
  private reservedClaudeLaunches = 0
  private readonly waitAllClaims = new Set<WaitAllClaim>()
  private readonly defaultWaitAllTargets = new Map<string, Set<string>>()
  private readonly shutdownController = new AbortController()
  private shuttingDown?: Deferred.Deferred<void>
  private readonly inspector: ProcessInspectorApi
  private readonly platform: NodeJS.Platform
  private readonly processSpawner: NodeChildProcessSpawner
  private readonly exitWaitScale: number
  private ownerProcessIdentity: string | undefined
  private readonly reconciliation: Fiber.Fiber<void>
  /** Launches and terminations are forked here so an aborted caller leaves the child it started alone. */
  private readonly detachedScope: Scope.Closeable = Scope.makeUnsafe()
  private readonly launchesInFlight = new Set<Deferred.Deferred<void>>()
  private readonly options: AgentManagerOptions
  private config: SubagentConfig = {}

  constructor(options: AgentManagerOptions = {}) {
    this.options = options
    this.inspector = options.processInspector ?? processInspectorFromProbe(nodeProcessProbe)
    this.platform = options.platform ?? process.platform
    this.processSpawner = options.processSpawner ?? nodeChildProcessSpawner
    this.exitWaitScale = options.exitWaitScale ?? 1
    this.reconciliation = Effect.runFork(this.initialize())
  }

  private initialize(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.ownerProcessIdentity = (yield* this.inspector.inspect(process.pid))?.identity
      this.config = yield* loadSubagentConfigEffect()
      yield* ensureBaseDirsEffect(this.config)
      yield* pruneExpiredRuns(this.config)
      infoCache.clear()
      yield* this.reconcilePersistedChildren()
    })
  }

  ready(): Effect.Effect<void> {
    return Fiber.join(this.reconciliation)
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

  private clearInactivityMonitor(live: LiveAgent): void {
    clearTimeout(live.inactivityTimer)
    live.inactivityTimer = undefined
  }

  private resetInactivityMonitor(live: LiveAgent): void {
    this.clearInactivityMonitor(live)
    const { inactivityTimeoutMs: timeoutMs } = live
    if (timeoutMs <= 0 || live.processFinished || live.expectedExit || FINAL_STATUSES.has(live.info.status)) {
      return
    }
    const lastActivity = live.info.lastActivity ?? nowMs()
    // oxlint-disable-next-line effecttsgo/global-timers -- `Effect.sleep` cannot unref its timer, and this monitor must never keep Pi alive; the handle is unref'd below.
    live.inactivityTimer = setTimeout(
      () => {
        live.inactivityTimer = undefined
        if (live.processFinished || live.expectedExit || FINAL_STATUSES.has(live.info.status)) {
          return
        }
        const currentLastActivity = live.info.lastActivity ?? lastActivity
        const inactiveForMs = nowMs() - currentLastActivity
        if (inactiveForMs < timeoutMs) {
          this.resetInactivityMonitor(live)
          return
        }
        try {
          this.options.onInactivity?.({
            agentName: live.info.canonicalName,
            inactiveForMs,
            lastActivity: currentLastActivity,
            parentSessionId: live.info.parentSessionId,
            ...agentMetadata(live.info),
          })
        } catch {
          // Best effort; a throwing extension callback must not break the running agent.
        }
      },
      Math.max(1, timeoutMs - (nowMs() - lastActivity))
    )
    live.inactivityTimer.unref()
  }

  private recordActivity(live: LiveAgent, persist = true): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      live.info.lastActivity = yield* Clock.currentTimeMillis
      if (persist) {
        yield* saveInfo(live.info)
      }
      this.resetInactivityMonitor(live)
    })
  }

  private countLiveClaudeAgents(excludeAgentId?: string): number {
    return [...this.live.values()].filter((live) => live.info.id !== excludeAgentId && !live.processFinished && isClaudeModelId(live.info.modelId))
      .length
  }

  private claudeLaunchLimitReached(excludeAgentId?: string): boolean {
    return this.countLiveClaudeAgents(excludeAgentId) + this.reservedClaudeLaunches >= MAX_LIVE_CLAUDE_AGENTS
  }

  private assertClaudeLaunchAllowed(info: Pick<AgentInfo, 'id' | 'modelId'>): Effect.Effect<void, SubagentError> {
    return Effect.suspend(() =>
      isClaudeModelId(info.modelId) && this.claudeLaunchLimitReached(info.id) ? Effect.fail(claudeLaunchLimitError()) : Effect.void
    )
  }

  /**
   * Admission counts published agents, but publication only happens after asynchronous setup, so
   * concurrent launches would otherwise all pass the check. The reservation is taken in the same
   * synchronous step as the check and released on every exit; a launch therefore counts twice
   * between publication and release, which can only reject too eagerly, never over-admit.
   */
  private withClaudeLaunchSlot<Value, Failure>(
    info: Pick<AgentInfo, 'id' | 'modelId'>,
    launch: Effect.Effect<Value, Failure>
  ): Effect.Effect<Value, Failure | SubagentError> {
    if (!isClaudeModelId(info.modelId)) {
      return launch
    }
    return Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (this.claudeLaunchLimitReached(info.id)) {
          return Effect.fail(claudeLaunchLimitError())
        }
        this.reservedClaudeLaunches += 1
        return Effect.void
      }),
      () => launch,
      () =>
        Effect.sync(() => {
          this.reservedClaudeLaunches -= 1
        })
    )
  }

  private assertContinuationAllowed(info: AgentInfo, live: LiveAgent | undefined): Effect.Effect<void, SubagentError> {
    return Effect.gen(function* () {
      if (info.followUpUsed) {
        return yield* subagentError(`Agent ${info.canonicalName} already used its single follow-up. Spawn a fresh agent with a narrow task instead.`)
      }
      if (!isClaudeModelId(info.modelId)) {
        return undefined
      }
      const contextTokens = yield* latestContextTokens(info.sessionFile)
      if (contextTokens === undefined) {
        return yield* live === undefined
          ? subagentError(`Claude context usage is unavailable for ${info.canonicalName}. Spawn a fresh agent instead of continuing it.`)
          : Effect.void
      }
      if (contextTokens >= CLAUDE_CONTEXT_TOKEN_LIMIT) {
        return yield* subagentError(
          `Agent ${info.canonicalName} reached ${contextTokens} context input tokens. Spawn a fresh agent before continuing past ${CLAUDE_CONTEXT_TOKEN_LIMIT}.`
        )
      }
      return undefined
    })
  }

  private setFollowUpUsed(info: AgentInfo, live: LiveAgent | undefined, used: boolean): Effect.Effect<void> {
    info.followUpUsed = used
    if (live === undefined) {
      return saveInfo(info)
    }
    live.info.followUpUsed = used
    return saveInfo(live.info)
  }

  private claimFollowUp(info: AgentInfo, live: LiveAgent | undefined): Effect.Effect<FollowUpClaim, SubagentError> {
    const file = join(dirname(info.infoFile), `${info.id}.follow-up`)
    const token = randomUUID()
    return createHeldFile({ content: jsonText({ token }), path: file }).pipe(
      Effect.mapError((error) =>
        errorCode(error) === 'EEXIST'
          ? subagentError(`Agent ${info.canonicalName} already used its single follow-up. Spawn a fresh agent with a narrow task instead.`, error)
          : subagentError(causeMessage(error), error)
      ),
      Effect.flatMap((handle) =>
        this.setFollowUpUsed(info, live, true).pipe(
          Effect.as({ file, handle, settled: false, token }),
          // Anything short of a claimed follow-up must give the claim back, defects and interruption included.
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : releaseTaskLock(file, handle, token)))
        )
      ),
      /*
       * The descriptor is caller-owned, so acquiring it and installing the release above must be one
       * atomic step: an interrupt landing between them would strand both the descriptor and the file.
       */
      Effect.uninterruptible
    )
  }

  private commitFollowUp(claim: FollowUpClaim): void {
    claim.settled = true
    closeHeldFile(claim.handle)
  }

  /*
   * Spans claim to commit so interruption or a defect in the window after the message is accepted but
   * before it is committed still gives the single follow-up back instead of burning it and leaking
   * the held descriptor. A no-op once the call site has already settled the claim itself, which lets
   * those sites keep ordering their own recovery around the rollback.
   */
  private withFollowUpClaim<Value, Failure>(
    info: AgentInfo,
    claim: FollowUpClaim,
    body: Effect.Effect<Value, Failure>
  ): Effect.Effect<Value, Failure> {
    return body.pipe(Effect.onExit(() => this.rollbackFollowUp(info, this.live.get(info.id), claim)))
  }

  private rollbackFollowUp(info: AgentInfo, live: LiveAgent | undefined, claim: FollowUpClaim): Effect.Effect<void> {
    if (claim.settled) {
      return Effect.void
    }
    claim.settled = true
    return this.setFollowUpUsed(info, live, false).pipe(Effect.ensuring(releaseTaskLock(claim.file, claim.handle, claim.token)))
  }

  private restartForFollowUp(info: AgentInfo): Effect.Effect<LiveAgent, SubagentFailure> {
    return Effect.gen({ self: this }, function* () {
      if (info.childProcess !== undefined) {
        yield* this.terminateOwnedChild(info)
      }
      yield* this.markInterruptedIfRunning(info, { notify: false })
      return yield* this.startLiveAgent(info)
    })
  }

  private steerFollowUp(
    info: AgentInfo,
    live: LiveAgent,
    message: string,
    claim: FollowUpClaim
  ): Effect.Effect<{ delivery: 'steer' }, SubagentFailure> {
    return Effect.gen({ self: this }, function* () {
      /*
       * Once the child has accepted the message the follow-up is spent, so the commit cannot be
       * skipped by an interrupt arriving between acceptance and the claim being settled.
       */
      yield* Effect.uninterruptible(
        this.sendCommand(live, { message, type: 'steer' }).pipe(Effect.tap(() => Effect.sync(() => this.commitFollowUp(claim))))
      )
      live.info.lastTaskMessage = message
      yield* this.recordActivity(live)
      return { delivery: 'steer' as const }
    })
  }

  private promptFollowUp(
    info: AgentInfo,
    live: LiveAgent,
    message: string,
    claim: FollowUpClaim
  ): Effect.Effect<{ delivery: 'prompt' }, SubagentFailure> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.uninterruptible(
        this.prompt(live, message, message).pipe(
          Effect.tap(() => Effect.sync(() => this.commitFollowUp(claim))),
          Effect.tapError(() =>
            Effect.gen({ self: this }, function* () {
              yield* this.rollbackFollowUp(info, live, claim)
              yield* this.terminateProcess(live).pipe(Effect.ignore)
            })
          )
        )
      )
      return { delivery: 'prompt' as const }
    })
  }

  private clearChildOwnership(info: AgentInfo, expectedToken: string): Effect.Effect<void> {
    return Effect.gen(function* () {
      const persisted = yield* readInfoFileEffect(info.infoFile)
      if (persisted?.childProcess?.token === expectedToken) {
        delete persisted.childProcess
        yield* saveInfo(persisted)
      }
      if (info.childProcess?.token === expectedToken) {
        delete info.childProcess
      }
    })
  }

  private signalOwnedProcess(ownership: ChildProcessOwnership, signal: NodeJS.Signals): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if ((yield* this.inspector.ownershipVerdict(ownership)) === 'match') {
        signalProcessGroup(ownership.pid, signal, this.platform !== 'win32')
      }
    })
  }

  /** `taskkill` is the only reliable way to take down a detached Windows tree. */
  private killWindowsTree(pid: number): Effect.Effect<void> {
    const command = ChildProcess.make('taskkill', ['/pid', String(pid), '/T', '/F'], {
      detached: false,
      stderr: 'ignore',
      stdin: 'ignore',
      stdout: 'ignore',
    })
    return Effect.scoped(
      this.processSpawner.spawn(command).pipe(
        Effect.flatMap((child) => child.exitCode),
        Effect.ignore
      )
    )
  }

  private markInterrupted(info: AgentInfo, options: { notify: boolean }): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      info.status = 'interrupted'
      info.lastActivity = yield* Clock.currentTimeMillis
      yield* saveInfo(info)
      if (options.notify) {
        this.notifyStatusChange(info)
      }
    })
  }

  private markInterruptedIfRunning(info: AgentInfo, options: { notify: boolean } = { notify: true }): Effect.Effect<void> {
    return info.status === 'starting' || info.status === 'running' ? this.markInterrupted(info, options) : Effect.void
  }

  private terminateOwnedChild(info: AgentInfo): Effect.Effect<void, SubagentError> {
    return Effect.gen({ self: this }, function* () {
      const ownership = info.childProcess
      if (ownership === undefined) {
        return true
      }
      const verdict = yield* this.inspector.ownershipVerdict(ownership)
      if (verdict === 'mismatch') {
        yield* this.clearChildOwnership(info, ownership.token)
        return true
      }
      if (verdict === 'unverifiable') {
        return false
      }
      if (this.platform === 'win32') {
        yield* this.killWindowsTree(ownership.pid)
        yield* waitForOwnedExit(this.inspector, ownership, this.exitWait(2000))
      } else {
        yield* this.signalOwnedProcess(ownership, 'SIGTERM')
        if (!(yield* waitForOwnedExit(this.inspector, ownership, this.exitWait(1000)))) {
          yield* this.signalOwnedProcess(ownership, 'SIGKILL')
          yield* waitForOwnedExit(this.inspector, ownership, this.exitWait(1000))
        }
      }
      if ((yield* this.inspector.ownershipVerdict(ownership)) !== 'mismatch') {
        return false
      }
      yield* this.clearChildOwnership(info, ownership.token)
      return true
    }).pipe(
      Effect.flatMap((terminated) => (terminated ? Effect.void : subagentError(`Unable to terminate owned child process for ${info.canonicalName}.`)))
    )
  }

  private reconcilePersistedChildren(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const info of yield* readAllInfos()) {
        // Best effort reconciliation; a failure here is retried on the next manager start.
        yield* this.reconcilePersistedChild(info).pipe(Effect.ignore)
      }
    })
  }

  private reconcilePersistedChild(info: AgentInfo): Effect.Effect<void, SubagentError> {
    return Effect.gen({ self: this }, function* () {
      const ownership = info.childProcess
      if (ownership === undefined) {
        if (info.status === 'starting' && !(yield* taskLockIsActive(info.parentSessionId, info.taskName))) {
          yield* reclaimDeadTaskLock(taskLockFile(info.parentSessionId, info.taskName), this.options.beforeReclaimTaskLockRemoval)
          yield* this.markInterrupted(info, { notify: true })
        }
        return
      }
      const verdict = yield* this.inspector.ownershipVerdict(ownership)
      if (verdict === 'unverifiable') {
        return
      }
      if (verdict === 'mismatch') {
        yield* this.markInterruptedIfRunning(info)
        yield* this.clearChildOwnership(info, ownership.token)
        return
      }
      /*
       * `ownerIsActive` treats an unreadable probe as "still active", where `inspect` reports it as
       * `undefined`: a transient `ps` failure must not be read as "the other manager is gone" and
       * let this manager terminate a child that is still owned.
       */
      const ownedByAnotherProcess =
        ownership.ownerPid !== process.pid &&
        (yield* this.inspector.ownerIsActive({
          pid: ownership.ownerPid,
          ...(isNullOrUndefined(ownership.ownerProcessIdentity) ? undefined : { processIdentity: ownership.ownerProcessIdentity }),
        }))
      if (ownedByAnotherProcess) {
        return
      }
      yield* this.markInterruptedIfRunning(info)
      yield* this.terminateOwnedChild(info)
    })
  }

  /**
   * A launch is manager-owned from before the shutdown check until the child is published in
   * `this.live`. Without that window, shutdown can scan an empty map and close `detachedScope`
   * while a background setup is still about to publish a child nothing will then terminate.
   */
  private duringLaunch<Success, Failure>(body: Effect.Effect<Success, Failure>): Effect.Effect<Success, Failure> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const done = Deferred.makeUnsafe<void>()
        this.launchesInFlight.add(done)
        return done
      }),
      () => body,
      (done) => Effect.sync(() => this.launchesInFlight.delete(done)).pipe(Effect.andThen(Deferred.succeed(done, undefined)))
    )
  }

  private launchSpawn(
    info: AgentInfo,
    message: string,
    metadata: Omit<SpawnAgentResult, 'completion' | 'execution'>,
    options: LaunchSpawnOptions
  ): Effect.Effect<SpawnAgentResult, SubagentFailure> {
    return this.duringLaunch(
      Effect.gen({ self: this }, function* () {
        if (!options.foreground) {
          yield* failIfLaunchAborted(options)
          yield* this.startLiveAgent(info, message, message)
          return { ...metadata, execution: 'background' as const }
        }
        const claim = this.registerWaiter(info.parentSessionId, new Set([info.canonicalName]), options.signal, true)
        const launch = yield* Effect.forkIn(
          this.startLiveAgent(info, message, message).pipe(Effect.ensuring(options.releaseLock())),
          this.detachedScope
        )
        const [, completion] = yield* Effect.all([Fiber.join(launch), claim.await], { concurrency: 2 })
        return { ...metadata, completion, execution: 'foreground' as const }
      })
    )
  }

  /** Wins the per-task creation lock, retrying once after reclaiming a lock whose owner is gone. */
  private acquireTaskLock(lockFile: string, lockToken: string, taskName: string): Effect.Effect<HeldFile, SubagentError> {
    return Effect.gen({ self: this }, function* () {
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = yield* Effect.result(this.writeTaskLock(lockFile, lockToken))
        if (Result.isSuccess(outcome)) {
          return outcome.success
        }
        const exists = errorCode(outcome.failure) === 'EEXIST'
        if (attempt === 0 && exists && (yield* reclaimDeadTaskLock(lockFile, this.options.beforeReclaimTaskLockRemoval))) {
          continue
        }
        return yield* exists
          ? subagentError(`Agent ${taskName} is already being created.`, outcome.failure)
          : subagentError(causeMessage(outcome.failure), outcome.failure)
      }
      return yield* subagentError(`Unable to lock agent ${taskName} for creation.`)
    })
  }

  private writeTaskLock(lockFile: string, lockToken: string): Effect.Effect<HeldFile, Cause.UnknownError> {
    return createHeldFile({
      content: JSON.stringify({
        createdAt: nowMs(),
        pid: process.pid,
        processIdentity: this.ownerProcessIdentity,
        token: lockToken,
      }),
      path: lockFile,
    })
  }

  private newAgentInfo(params: SpawnAgentParams, resolved: ReturnType<typeof resolveAgentConfig>, taskName: string, createdAt: number): AgentInfo {
    const id = randomUUID()
    const directory = scopeDir(params.parentSessionId)
    return {
      agentType: resolved.key,
      allowedTools: [...resolved.allowedTools],
      canonicalName: `/${taskName}`,
      color: resolved.color,
      createdAt,
      cwd: resolvePath(params.cwd),
      followUpUsed: false,
      id,
      infoFile: join(directory, `${id}.info.json`),
      isReadonly: resolved.isReadonly,
      lastActivity: createdAt,
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
      startedAt: createdAt,
      status: 'starting',
      taskName,
      thinking: resolved.thinking,
      updatedAt: createdAt,
    }
  }

  spawnAgent(params: SpawnAgentParams, options: SpawnAgentOptions = {}): Effect.Effect<SpawnAgentResult, SubagentFailure> {
    return Effect.gen({ self: this }, function* () {
      const execution = spawnExecution(options, this.shutdownController.signal)
      yield* failIfLaunchAborted(execution)
      yield* this.ready()
      yield* failIfLaunchAborted(execution)
      const taskName = yield* Effect.try({
        catch: (cause) => subagentError(causeMessage(cause), cause),
        try: () => normalizeTaskName(params.task_name),
      })
      const resolved = yield* Effect.try({
        catch: (cause) => subagentError(causeMessage(cause), cause),
        try: () =>
          resolveAgentConfig(params.agent_type, {
            availableModels: params.availableModels,
            parentModel: params.parentModel,
          }),
      })
      yield* this.assertClaudeLaunchAllowed({ id: '', modelId: resolved.modelId })
      yield* ensurePrivateDirEffect(scopeDir(params.parentSessionId), true)

      const lockFile = taskLockFile(params.parentSessionId, taskName)
      const lockToken = randomUUID()
      let lock: HeldFile | undefined
      let launchOwnsLock = false
      const releaseLock = (): Effect.Effect<void> =>
        Effect.suspend(() => {
          if (lock === undefined) {
            return Effect.void
          }
          const descriptor = lock
          lock = undefined
          return releaseTaskLock(lockFile, descriptor, lockToken, this.options.beforeReleaseTaskLockRemoval)
        })
      const create = Effect.gen({ self: this }, function* () {
        lock = yield* this.acquireTaskLock(lockFile, lockToken, taskName)
        if ((yield* readScopeInfos(params.parentSessionId)).some((info) => info.taskName === taskName)) {
          return yield* subagentError(`Agent ${taskName} already exists in this parent session. Use a new task_name.`)
        }
        const info = this.newAgentInfo(params, resolved, taskName, yield* Clock.currentTimeMillis)
        yield* saveInfo(info)
        this.notifyStatusChange(info)
        const targets = this.defaultWaitAllTargets.get(params.parentSessionId) ?? new Set<string>()
        targets.add(info.canonicalName)
        this.defaultWaitAllTargets.set(params.parentSessionId, targets)
        const metadata = {
          color: resolved.color,
          is_readonly: resolved.isReadonly,
          nickname: undefined,
          profile: resolved.key,
          task_name: info.canonicalName,
        }
        launchOwnsLock = execution.foreground
        return yield* this.launchSpawn(info, params.message, metadata, { ...execution, releaseLock })
      })
      return yield* create.pipe(Effect.ensuring(Effect.suspend(() => (launchOwnsLock ? Effect.void : releaseLock()))))
    })
  }

  private consumeAzureQuota(live: LiveAgent): Effect.Effect<void> {
    const token = live.info.childProcess?.token
    if (isNullOrUndefined(token) || isEmptyString(token)) {
      return Effect.void
    }
    return consumeSubagentAzureQuota(token).pipe(
      Effect.tap((percent) => Effect.sync(() => percent === undefined || azureQuota.set(percent))),
      Effect.asVoid
    )
  }

  private finishProcess(live: LiveAgent, error?: Error, options: { retainOwnership?: boolean } = {}): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (live.processFinished) {
        return Effect.void
      }
      live.processFinished = true
      this.clearInactivityMonitor(live)
      const markExited = this.markProcessExited(live)
      /*
       * `processFinished` is already true, so a later termination call returns immediately: the
       * teardown below must therefore run even if persistence or ownership clearing dies, or the
       * scope, map entry, pending requests, and exit waiters would be stranded forever.
       */
      const release = Effect.gen({ self: this }, function* () {
        yield* markExited
        const pending = yield* Ref.getAndSet(live.pending, HashMap.empty())
        for (const [, deferred] of HashMap.entries(pending)) {
          yield* Deferred.fail(deferred, subagentProcessError(error?.message ?? 'Child Pi process exited before responding.', error))
        }
        if (this.live.get(live.info.id) === live) {
          this.live.delete(live.info.id)
        }
        yield* Scope.close(live.scope, Exit.void)
        yield* Deferred.succeed(live.exit, undefined)
      }).pipe(Effect.uninterruptible)

      return Effect.gen({ self: this }, function* () {
        yield* this.consumeAzureQuota(live)
        const persisted = yield* readInfoFileEffect(live.info.infoFile)
        if (persisted !== undefined && FINAL_STATUSES.has(persisted.status)) {
          live.info = persisted
          live.finalizedRun = true
        }
        if ((!live.expectedExit || live.streamError !== undefined) && !live.finalizedRun && !FINAL_STATUSES.has(live.info.status)) {
          yield* this.markFailed(live, error?.message ?? 'Child Pi process exited unexpectedly.')
        }
        /*
         * A child that survived termination stays reconcilable: its ownership record is the only
         * handle the next manager start has for reaping it, so it must outlive this teardown.
         */
        const ownership = live.info.childProcess
        if (ownership !== undefined && options.retainOwnership !== true) {
          yield* this.clearChildOwnership(live.info, ownership.token)
        }
      }).pipe(Effect.ensuring(release))
    })
  }

  private handleProcessStreamError(live: LiveAgent, source: string, cause: unknown): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const error = subagentProcessError(`${source}: ${causeMessage(cause)}`, cause)
      live.streamError ??= error
      yield* Queue.end(live.stdin)
      yield* Effect.forkIn(this.terminateProcess(live).pipe(Effect.ignore), this.detachedScope)
    })
  }

  private wireChildProcess(live: LiveAgent, decoder: RpcJsonlDecoder): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const { proc, logger } = live
      const stdoutDone = yield* Deferred.make<void>()
      const stderrDone = yield* Deferred.make<void>()
      const stdout = Stream.runForEach(proc.stdout, (chunk) =>
        Effect.try({ catch: (cause) => subagentProcessError(causeMessage(cause), cause), try: () => decoder.push(Buffer.from(chunk)) }).pipe(
          Effect.flatMap((lines) => Effect.forEach(lines, (line) => this.handleLine(live, line), { discard: true }))
        )
      ).pipe(
        /*
         * `Effect.try` keeps `decoder.end()` lazy. Called eagerly it runs while the pipeline is
         * still being built, flushes an empty buffer, and loses an unterminated final frame.
         */
        Effect.andThen(
          Effect.try({ catch: (cause) => subagentProcessError(causeMessage(cause), cause), try: () => decoder.end() }).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, (line) => this.handleLine(live, line), { discard: true }))
          )
        ),
        Effect.catch((error) => this.handleProcessStreamError(live, 'child stdout failed', error)),
        Effect.ensuring(Deferred.succeed(stdoutDone, undefined))
      )
      const stderr = Stream.runForEach(proc.stderr, (data) =>
        Effect.gen(function* () {
          const chunk = Buffer.from(data).toString()
          live.stderr = `${live.stderr}${chunk}`.slice(-64 * 1024)
          yield* logger.stderr(chunk)
        })
      ).pipe(
        Effect.catch((error) => this.handleProcessStreamError(live, 'child stderr failed', error)),
        Effect.ensuring(Deferred.succeed(stderrDone, undefined))
      )
      const stdin = Stream.run(Stream.fromQueue(live.stdin), proc.stdin).pipe(
        Effect.catch((error) => this.handleProcessStreamError(live, 'child stdin failed', error))
      )
      const awaitOutput = Effect.all([Deferred.await(stdoutDone), Deferred.await(stderrDone)], { concurrency: 2 }).pipe(
        Effect.timeoutOption(POST_EXIT_DRAIN_MS),
        Effect.asVoid
      )
      const exit = Effect.matchEffect(proc.exitCode, {
        onFailure: (cause) =>
          Effect.gen({ self: this }, function* () {
            yield* this.markProcessExited(live)
            yield* awaitOutput
            yield* logger.info('exit', 'child exited', { error: causeMessage(cause) })
            const suffix = isNotEmptyString(live.stderr.trim()) ? `: ${live.stderr.trim().slice(-1000)}` : ''
            const error =
              live.streamError ?? (live.expectedExit ? undefined : subagentProcessError(`Child Pi exited (${causeMessage(cause)})${suffix}`, cause))
            yield* this.finishProcess(live, error)
          }),
        onSuccess: (code) =>
          Effect.gen({ self: this }, function* () {
            yield* this.markProcessExited(live)
            yield* awaitOutput
            yield* logger.info('exit', 'child exited', { code: Number(code), signal: undefined })
            const suffix = isNotEmptyString(live.stderr.trim()) ? `: ${live.stderr.trim().slice(-1000)}` : ''
            const error =
              live.streamError ??
              (live.expectedExit ? undefined : subagentProcessError(`Child Pi exited (code=${Number(code)}, signal=null)${suffix}`))
            yield* this.finishProcess(live, error)
          }),
      })
      yield* Effect.forkIn(stdout, live.scope)
      yield* Effect.forkIn(stderr, live.scope)
      yield* Effect.forkIn(stdin, live.scope)
      yield* Effect.forkIn(exit, this.detachedScope)
    })
  }

  /**
   * Setup that ends without publishing a live agent would otherwise leave the persisted record at
   * `starting` forever, so spawn and handshake share one exit handler.
   */
  private finalizeAbandonedSetup(info: AgentInfo, exit: Exit.Exit<LiveAgent, SubagentFailure>): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (Exit.isSuccess(exit) || this.live.has(info.id) || FINAL_STATUSES.has(info.status)) {
        return Effect.void
      }
      if (Exit.hasInterrupts(exit)) {
        return this.markInterruptedIfRunning(info)
      }
      const error = Exit.findErrorOption<LiveAgent, SubagentFailure>(exit)
      return this.markSetupFailed(info, Option.isSome(error) ? error.value.message : 'Child Pi process setup failed.')
    })
  }

  private abandonHandshake(live: LiveAgent, exit: Exit.Exit<unknown, SubagentFailure>): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const error = Exit.findErrorOption(exit)
      if (!live.finalizedRun && !Exit.hasInterrupts(exit)) {
        yield* this.markFailed(live, Option.isSome(error) ? error.value.message : 'Child Pi process setup failed.').pipe(Effect.ignoreCause)
      }
      // A kill that fails here leaves the persisted ownership record in place, so
      // `reconcilePersistedChildren` reaps the child on the next manager start.
      yield* this.terminateProcess(live).pipe(Effect.ignoreCause)
    }).pipe(Effect.uninterruptible)
  }

  private markSetupFailed(info: AgentInfo, error: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      info.status = 'failed'
      info.error = error
      info.completedAt = yield* Clock.currentTimeMillis
      info.lastActivity = info.completedAt
      yield* saveInfo(info)
      this.notifyStatusChange(info)
    })
  }

  private startLiveAgent(info: AgentInfo, initialMessage?: string, displayMessage?: string): Effect.Effect<LiveAgent, SubagentFailure> {
    const launch = Effect.gen({ self: this }, function* () {
      if (info.status !== 'starting' && info.status !== 'running') {
        this.notifyStatusChange({ ...info, lastActivity: yield* Clock.currentTimeMillis, status: 'starting' })
      }
      const live = yield* this.spawnLiveAgent(info)
      return yield* this.handshake(live, initialMessage, displayMessage).pipe(
        /*
         * Exit-based, not `tapError`: persistence dies as a defect, and an interrupted handshake
         * must not leave a spawned child running either.
         */
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : this.abandonHandshake(live, exit)))
      )
    }).pipe(Effect.onExit((exit) => this.finalizeAbandonedSetup(info, exit)))
    return this.withClaudeLaunchSlot(info, launch)
  }

  private spawnLiveAgent(info: AgentInfo): Effect.Effect<LiveAgent, SubagentProcessError> {
    return Effect.gen({ self: this }, function* () {
      const launch = yield* getPiCommand(this.options.piCommand)
      const args = buildChildArgs(launch, info)
      const childToken = randomUUID()
      const childEnv = buildChildEnv({ childToken, isReadonly: info.isReadonly, profile: info.profile }, this.options.childEnv, process.env)
      const scope = yield* Scope.make()
      // Bounded so a child that stops reading backs pressure up into `dispatchCommand`, whose
      // `Effect.timeoutOrElse` then fails the send instead of buffering payloads without limit.
      const stdin = yield* Queue.bounded<Uint8Array, Cause.Done>(STDIN_BUFFER_CAPACITY)
      let transferred = false
      return yield* Effect.gen({ self: this }, function* () {
        const { broadcaster, logger } = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const createdLogger = new SessionLogger(info.logFile)
            const createdBroadcaster = new EventBroadcaster(info.id)
            yield* Scope.addFinalizer(
              scope,
              Effect.gen(function* () {
                yield* Queue.end(stdin)
                yield* createdBroadcaster.stop()
              })
            )
            yield* createdBroadcaster.start()
            return { broadcaster: createdBroadcaster, logger: createdLogger }
          })
        )
        yield* logger.info('spawn', 'starting child pi', { args, command: launch.command, cwd: info.cwd })
        const command = ChildProcess.make(launch.command, args, {
          cwd: info.cwd,
          detached: process.platform !== 'win32',
          env: childEnv,
          forceKillAfter: 1000,
          stderr: 'pipe',
          stdin: { endOnDone: true, stream: 'pipe' },
          stdout: 'pipe',
          windowsHide: false,
        })
        /*
         * The spawner's own finalizer signals `-pid` (the whole detached group) on scope close and
         * on any non-zero exit, without the `ownershipVerdict` check every other signal in this
         * module passes.
         *
         * ponytail: known ceiling — between the child exiting and `finishProcess` closing `scope`,
         * a recycled PGID could be signalled instead. Replace this with an ownership-verified
         * spawner adapter once the platform exposes an opt-out, or if a stray termination is
         * ever observed.
         */
        const proc = yield* this.processSpawner.spawn(command).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((cause) => subagentProcessError(causeMessage(cause), cause))
        )
        if (this.options.afterProcessSpawn !== undefined) {
          yield* this.options.afterProcessSpawn()
        }
        const live: LiveAgent = {
          broadcaster,
          candidateResponse: '',
          childToken,
          exit: Deferred.makeUnsafe<void>(),
          exited: Deferred.makeUnsafe<void>(),
          expectedExit: false,
          finalizedRun: false,
          inactivityTimeoutMs: this.options.inactivityTimeoutMs ?? (this.config.inactivityMinutes ?? DEFAULT_INACTIVITY_MINUTES) * 60_000,
          info,
          logger,
          pending: Ref.makeUnsafe(HashMap.empty()),
          proc,
          processExited: false,
          processFinished: false,
          reqId: 0,
          scope,
          stderr: '',
          stdin,
        }
        yield* this.wireChildProcess(live, new RpcJsonlDecoder())
        if (!live.processFinished) {
          /*
           * Shutdown waits for launches only for `SHUTDOWN_LAUNCH_DRAIN_MS`. Past that it has
           * already scanned `this.live`, so publishing now would strand a child nothing terminates.
           * Leaving `transferred` false instead tears the freshly spawned child down with the scope.
           */
          if (this.shutdownController.signal.aborted) {
            return yield* subagentProcessError('Agent manager is shutting down.')
          }
          this.live.set(info.id, live)
          this.resetInactivityMonitor(live)
        }
        transferred = true
        return live
      }).pipe(Effect.ensuring(Effect.suspend(() => (transferred ? Effect.void : Scope.close(scope, Exit.void)))))
    })
  }

  private handshake(live: LiveAgent, initialMessage?: string, displayMessage?: string): Effect.Effect<LiveAgent, SubagentFailure> {
    return Effect.gen({ self: this }, function* () {
      const { info } = live
      const pid = Number(live.proc.pid)
      const snapshot = yield* verifyChildOwnership(this.inspector, pid, live.childToken)
      // Persist ownership before the first RPC round trip. If this process crashes while
      // The child is starting, the next manager can identify and terminate the orphan.
      const provisionalOwnership: ChildProcessOwnership = {
        ownerPid: process.pid,
        ownerProcessIdentity: this.ownerProcessIdentity,
        pid,
        processIdentity: snapshot.identity,
        startedAt: yield* Clock.currentTimeMillis,
        token: live.childToken,
      }
      info.childProcess = provisionalOwnership
      yield* saveInfo(info)
      yield* this.sendCommand(live, { type: 'get_state' }, DEFAULT_STARTUP_TIMEOUT_MS)
      // The answered round trip proves the child reached its final program.
      // Its identity can no longer change underneath a later reconciliation.
      const settled = yield* this.inspector.inspect(pid, live.childToken)
      if (isNotNullOrUndefined(settled) && !isFalse(settled.tokenMatches) && settled.identity !== provisionalOwnership.processIdentity) {
        info.childProcess = { ...provisionalOwnership, processIdentity: settled.identity }
        yield* saveInfo(info)
      }
      if (isNotNullOrUndefined(initialMessage) && isNotEmptyString(initialMessage)) {
        yield* this.prompt(live, initialMessage, displayMessage)
      }
      return live
    })
  }

  private sendCommand(live: LiveAgent, command: JsonObject, timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS): Effect.Effect<unknown, SubagentProcessError> {
    return Effect.suspend(() =>
      live.processFinished || live.expectedExit
        ? Effect.fail(subagentProcessError(`Agent ${live.info.taskName} process is not available.`))
        : this.dispatchCommand(live, command, timeoutMs)
    )
  }

  /** Skips the availability guard so `terminateProcess` can still deliver its abort round trip. */
  private dispatchCommand(live: LiveAgent, command: JsonObject, timeoutMs: number): Effect.Effect<unknown, SubagentProcessError> {
    return Effect.suspend(() => {
      const id = `req-${++live.reqId}`
      const commandType = typeof command.type === 'string' ? command.type : 'unknown'
      const payload = `${jsonText({ id, ...command })}\n`
      const wait = Effect.gen(function* () {
        const deferred = yield* Deferred.make<unknown, SubagentProcessError>()
        yield* Ref.update(live.pending, HashMap.set(id, deferred))
        const accepted = yield* Queue.offer(live.stdin, new TextEncoder().encode(payload))
        if (!accepted) {
          return yield* subagentProcessError('Child Pi stdin is not available.')
        }
        return yield* Deferred.await(deferred)
      })
      return Effect.timeoutOrElse(wait, {
        duration: timeoutMs,
        orElse: () => subagentProcessError(`Timed out waiting for child Pi RPC command: ${commandType}`),
      }).pipe(Effect.ensuring(Ref.update(live.pending, HashMap.remove(id))))
    })
  }

  private prompt(live: LiveAgent, message: string, displayMessage?: string): Effect.Effect<void, SubagentProcessError> {
    return Effect.gen({ self: this }, function* () {
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
      live.info.messageCount += 1
      live.finalizedRun = false
      live.candidateResponse = ''
      live.candidateError = undefined
      delete live.info.finalResponse
      delete live.info.error
      delete live.info.completedAt
      yield* this.recordActivity(live)
      this.notifyStatusChange(live.info)
      yield* this.sendCommand(live, { message, type: 'prompt' }).pipe(Effect.tapError(() => this.restorePreviousFinalState(live, previousFinalState)))
    })
  }

  private restorePreviousFinalState(
    live: LiveAgent,
    previous: Pick<AgentInfo, 'completedAt' | 'error' | 'finalResponse' | 'status'>
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      live.info.status = previous.status
      if (previous.finalResponse === undefined) {
        delete live.info.finalResponse
      } else {
        live.info.finalResponse = previous.finalResponse
      }
      if (previous.error === undefined) {
        delete live.info.error
      } else {
        live.info.error = previous.error
      }
      if (previous.completedAt === undefined) {
        delete live.info.completedAt
      } else {
        live.info.completedAt = previous.completedAt
      }
      yield* saveInfo(live.info)
      this.notifyStatusChange(live.info)
    })
  }

  private handleResponseEvent(live: LiveAgent, event: SubagentRpcEvent): void {
    const { id } = event
    if (isNullOrUndefined(id) || isEmptyString(id)) {
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
        yield* isTrue(event.success)
          ? Deferred.succeed(deferred.value, event.data)
          : Deferred.fail(deferred.value, subagentProcessError(event.error || 'RPC command failed'))
      })
    )
  }

  private handleAgentStart(live: LiveAgent): Effect.Effect<void> {
    live.info.status = 'running'
    live.candidateResponse = ''
    live.candidateError = undefined
    return saveInfo(live.info).pipe(Effect.tap(() => Effect.sync(() => this.notifyStatusChange(live.info))))
  }

  private handleMessageEnd(live: LiveAgent, event: SubagentRpcEvent): void {
    if (event.message?.role !== 'assistant') {
      return
    }
    live.candidateResponse = extractTextFromMessage(event.message).trim()
    live.candidateError = stopReasonError(event.message.stopReason, event.message.errorMessage)
  }

  private handleAgentEnd(live: LiveAgent, event: SubagentRpcEvent): void {
    const lastAssistant = [...(event.messages ?? [])].toReversed().find((message) => message?.role === 'assistant')
    if (lastAssistant === undefined) {
      return
    }
    live.candidateResponse = extractTextFromMessage(lastAssistant).trim()
    live.candidateError = stopReasonError(lastAssistant.stopReason, lastAssistant.errorMessage)
  }

  private handleAgentSettled(live: LiveAgent): Effect.Effect<void> {
    if (live.info.status === 'interrupted' || live.finalizedRun) {
      return Effect.void
    }
    const finalize =
      isNotNullOrUndefined(live.candidateError) && isNotEmptyString(live.candidateError)
        ? this.markFailed(live, live.candidateError)
        : this.markCompleted(live)
    return Effect.gen({ self: this }, function* () {
      yield* finalize
      yield* Effect.forkIn(
        this.terminateProcess(live).pipe(
          Effect.tapError((error) => live.logger.info('hibernate', 'failed to terminate settled child', { error: error.message })),
          Effect.ignore
        ),
        this.detachedScope
      )
    })
  }

  private dispatchLiveEvent(live: LiveAgent, event: SubagentRpcEvent): Effect.Effect<void> {
    const runningStatusEvents = new Set(['message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end'])
    if (event.type === 'agent_start') {
      return this.handleAgentStart(live)
    }
    if (runningStatusEvents.has(event.type)) {
      live.info.status = 'running'
      return saveInfo(live.info)
    }
    if (event.type === 'message_end') {
      this.handleMessageEnd(live, event)
    } else if (event.type === 'agent_end') {
      this.handleAgentEnd(live, event)
    } else if (
      event.type === 'auto_retry_end' &&
      isFalse(event.success) &&
      isNotNullOrUndefined(event.finalError) &&
      isNotEmptyString(event.finalError)
    ) {
      live.candidateError = event.finalError
    } else if (event.type === 'agent_settled') {
      return this.handleAgentSettled(live)
    }
    return Effect.void
  }

  private handleLine(live: LiveAgent, line: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (isEmptyString(line.trim())) {
        return
      }
      // A malformed frame must not end stdout consumption, so parsing stays a typed failure and falls through to the log below.
      const parsed = yield* Effect.try(() => parseJsonText(line)).pipe(Effect.orElseSucceed(() => undefined))
      if (!Check(SubagentRpcEventSchema, parsed)) {
        yield* live.logger.info('rpc', 'ignored invalid JSON line', { line: line.slice(0, 1000) })
        return
      }
      yield* this.consumeAzureQuota(live)
      const event = parsed
      live.broadcaster.broadcast(event)
      if (event.type === 'response') {
        this.handleResponseEvent(live, event)
        return
      }
      const persisted = yield* readInfoFileEffect(live.info.infoFile)
      if (persisted !== undefined && FINAL_STATUSES.has(persisted.status) && persisted.status !== live.info.status) {
        live.info = persisted
        live.finalizedRun = true
        return
      }
      if (live.finalizedRun || live.expectedExit) {
        return
      }
      yield* this.recordActivity(live, false)
      yield* this.dispatchLiveEvent(live, event)
    })
  }

  private markCompleted(live: LiveAgent): Effect.Effect<void> {
    if (live.finalizedRun) {
      return Effect.void
    }
    return Effect.gen({ self: this }, function* () {
      live.finalizedRun = true
      this.clearInactivityMonitor(live)
      live.info.status = 'completed'
      live.info.finalResponse = live.candidateResponse
      delete live.info.error
      live.info.completedAt = yield* Clock.currentTimeMillis
      live.info.lastActivity = live.info.completedAt
      yield* saveInfo(live.info)
      this.notifyStatusChange(live.info)
      this.pushMailbox({
        agentName: live.info.canonicalName,
        createdAt: yield* Clock.currentTimeMillis,
        finalResponse: live.info.finalResponse,
        id: randomUUID(),
        parentSessionId: live.info.parentSessionId,
        status: 'completed',
        ...agentMetadata(live.info),
      })
    })
  }

  private markFailed(live: LiveAgent, error: string): Effect.Effect<void> {
    if (live.finalizedRun) {
      return Effect.void
    }
    return Effect.gen({ self: this }, function* () {
      live.finalizedRun = true
      this.clearInactivityMonitor(live)
      live.info.status = 'failed'
      live.info.error = error
      delete live.info.finalResponse
      live.info.completedAt = yield* Clock.currentTimeMillis
      live.info.lastActivity = live.info.completedAt
      yield* saveInfo(live.info)
      this.notifyStatusChange(live.info)
      this.pushMailbox({
        agentName: live.info.canonicalName,
        createdAt: yield* Clock.currentTimeMillis,
        error,
        id: randomUUID(),
        parentSessionId: live.info.parentSessionId,
        status: 'failed',
        ...agentMetadata(live.info),
      })
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
    const matches = (waiter: Waiter): boolean => waiter.parentSessionId === event.parentSessionId && targetMatches(event, waiter.targets)
    const foregroundIndex = this.waiters.findIndex((waiter) => waiter.foreground && matches(waiter))
    const waiterIndex = foregroundIndex === -1 ? this.waiters.findIndex(matches) : foregroundIndex
    if (waiterIndex !== -1) {
      const [waiter] = this.waiters.splice(waiterIndex, 1)
      Deferred.doneUnsafe(waiter.deferred, Effect.succeed(event))
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
      if (matchingClaims.length === 0) {
        this.notifyUnclaimedCompletion(event)
      }
    }
  }

  private agentListEntries(infos: AgentInfo[], pathPrefix: string | undefined, parentSessionId: string, includeAll: boolean): AgentListEntry[] {
    const prefix = pathPrefix?.trim().replace(/^\/+/, '')
    return sortInfos(infos)
      .filter((info) => includeAll || info.parentSessionId === parentSessionId)
      .filter((info) => isNullOrUndefined(prefix) || isEmptyString(prefix) || info.taskName.startsWith(prefix))
      .map((info) => {
        const entry: AgentListEntry = {
          agent_name: info.canonicalName,
          agent_status: info.status,
          color: persistedProfileColor(info.profile, info.color),
          last_task_message: previewText(info.lastTaskMessage),
        }
        if (includeAll) {
          entry.parent_session_id = info.parentSessionId
        }
        if (isNotNullOrUndefined(info.profile) && isNotEmptyString(info.profile)) {
          entry.profile = info.profile
        }
        if (info.isReadonly !== undefined) {
          entry.is_readonly = info.isReadonly
        }
        return entry
      })
  }

  listAgents(pathPrefix: string | undefined, parentSessionId: string, includeAll = false): AgentListEntry[] {
    return this.agentListEntries([...infoCache.values()], pathPrefix, parentSessionId, includeAll)
  }

  listAgentsFromDisk(pathPrefix: string | undefined, parentSessionId: string, includeAll = false): Effect.Effect<AgentListEntry[], SubagentError> {
    return (includeAll ? readAllInfos() : readScopeInfos(parentSessionId)).pipe(
      Effect.map((infos) => this.agentListEntries(infos, pathPrefix, parentSessionId, includeAll)),
      Effect.catchCause((cause) => Effect.fail(subagentError(causeMessage(Cause.squash(cause)), Cause.squash(cause))))
    )
  }

  getAgentInfo(target: string, parentSessionId: string): AgentInfo {
    const taskName = normalizeTaskName(target)
    const info = [...infoCache.values()].find((candidate) => candidate.parentSessionId === parentSessionId && candidate.taskName === taskName)
    if (info === undefined) {
      throw new Error(`Agent not found in this parent session: ${target}`)
    }
    return info
  }

  getAgentInfoFromDisk(target: string, parentSessionId: string): Effect.Effect<AgentInfo, SubagentError> {
    return this.requireAgent(target, parentSessionId)
  }

  readAgentResponse(target: string, parentSessionId: string): AgentResponseEntry {
    return this.agentResponse(this.getAgentInfo(target, parentSessionId))
  }

  readAgentResponseFromDisk(target: string, parentSessionId: string): Effect.Effect<AgentResponseEntry, SubagentError> {
    return this.getAgentInfoFromDisk(target, parentSessionId).pipe(Effect.map((info) => this.agentResponse(info)))
  }

  private agentResponse(info: AgentInfo): AgentResponseEntry {
    const response: AgentResponseEntry = {
      agent_name: info.canonicalName,
      color: persistedProfileColor(info.profile, info.color),
      last_task_message: previewText(info.lastTaskMessage),
      status: info.status,
    }
    if (info.finalResponse !== undefined) {
      response.finalResponse = info.finalResponse
    }
    if (isNotNullOrUndefined(info.error) && isNotEmptyString(info.error)) {
      response.error = info.error
    }
    if (isNotNullOrUndefined(info.profile) && isNotEmptyString(info.profile)) {
      response.profile = info.profile
    }
    if (info.isReadonly !== undefined) {
      response.is_readonly = info.isReadonly
    }
    return response
  }

  private finishWaitTarget(parentSessionId: string, agentName: string): void {
    this.defaultWaitAllTargets.get(parentSessionId)?.delete(canonicalAgentName(agentName))
  }

  private registerWaiter(parentSessionId: string, targets: Set<string> | undefined, signal: AbortSignal, foreground = false): WaiterClaim {
    const deferred = Deferred.makeUnsafe<AgentCompletionEvent, SubagentError>()
    const waiter: Waiter = { deferred, foreground, parentSessionId, targets }
    this.waiters.push(waiter)
    const remove = (): boolean => {
      const remaining = this.waiters.filter((candidate) => candidate !== waiter)
      const wasRegistered = remaining.length !== this.waiters.length
      this.waiters = remaining
      return wasRegistered
    }
    return {
      await: Effect.raceFirst(Deferred.await(deferred), awaitAbort(signal)).pipe(Effect.ensuring(Effect.sync(remove))),
      withdraw: remove,
    }
  }

  private waitSignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined ? this.shutdownController.signal : AbortSignal.any([signal, this.shutdownController.signal])
  }

  private settledTargetWait(
    parentSessionId: string,
    normalizedTargets: Set<string>
  ): Effect.Effect<{ message: string; event?: AgentCompletionEvent } | undefined, SubagentError> {
    return Effect.gen({ self: this }, function* () {
      const targetInfos = (yield* readScopeInfos(parentSessionId)).filter((info) => normalizedTargets.has(info.canonicalName))
      if (targetInfos.length === 0) {
        return yield* subagentError(`Agent not found in this parent session: ${[...normalizedTargets].join(', ')}`)
      }
      const finalInfo = targetInfos.find((info) => FINAL_STATUSES.has(info.status))
      if (finalInfo === undefined) {
        return undefined
      }
      this.finishWaitTarget(parentSessionId, finalInfo.canonicalName)
      return {
        event: {
          agentName: finalInfo.canonicalName,
          createdAt: yield* Clock.currentTimeMillis,
          error: finalInfo.error,
          finalResponse: finalInfo.finalResponse,
          id: randomUUID(),
          parentSessionId,
          status: finalInfo.status,
          ...agentMetadata(finalInfo),
        },
        message: `Wait completed: ${finalInfo.canonicalName} ${finalInfo.status}.`,
      }
    })
  }

  waitAgent(
    parentSessionId: string,
    targets?: string[],
    signal?: AbortSignal
  ): Effect.Effect<{ message: string; event?: AgentCompletionEvent }, SubagentError> {
    return Effect.gen({ self: this }, function* () {
      const waitSignal = this.waitSignal(signal)
      yield* failIfAborted(waitSignal)
      const normalizedTargets = targets !== undefined && targets.length > 0 ? new Set(targets.map(canonicalAgentName)) : undefined
      /*
       * Registered before the disk read: a completion arriving during it is delivered to this
       * waiter instead of the mailbox, so a later registration would block forever. `withdraw`
       * then reports whether the waiter is still unclaimed and may be replaced by a pre-check.
       */
      const waiter = this.registerWaiter(parentSessionId, normalizedTargets, waitSignal)
      const existing = consumeFirstMatchingMailboxEvent(this.mailbox, parentSessionId, normalizedTargets)
      if (existing !== undefined && waiter.withdraw()) {
        this.finishWaitTarget(parentSessionId, existing.agentName)
        return {
          event: existing,
          message: `Wait completed: ${existing.agentName} ${existing.status}.`,
        }
      }
      if (existing === undefined && normalizedTargets !== undefined) {
        const settled = yield* this.settledTargetWait(parentSessionId, normalizedTargets).pipe(
          Effect.tapError(() => Effect.sync(() => waiter.withdraw()))
        )
        if (settled !== undefined && waiter.withdraw()) {
          return settled
        }
      }
      const event = yield* waiter.await
      this.finishWaitTarget(parentSessionId, event.agentName)
      return { event, message: `Wait completed: ${event.agentName} ${event.status}.` }
    })
  }

  private releaseWaitAllClaim(claim: WaitAllClaim): void {
    this.waitAllClaims.delete(claim)
    for (const eventId of claim.suppressedEventIds) {
      const event = this.mailbox.find((candidate) => candidate.id === eventId)
      if (event === undefined) {
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

  waitAllAgents(
    parentSessionId: string,
    targets?: string[],
    signal?: AbortSignal
  ): Effect.Effect<{ message: string; responses: AgentResponseEntry[] }, SubagentError> {
    return Effect.gen({ self: this }, function* () {
      const waitSignal = this.waitSignal(signal)
      yield* failIfAborted(waitSignal)
      const explicitTargets = targets !== undefined && targets.length > 0 ? new Set(targets.map(canonicalAgentName)) : undefined
      const defaultTargets = this.defaultWaitAllTargets.get(parentSessionId) ?? new Set<string>()
      const targetSet = explicitTargets ?? new Set(defaultTargets)
      /*
       * Claimed before target validation reads the disk: a target completing during that read
       * would otherwise be auto-delivered and then also returned here, breaking exactly-once
       * completion delivery.
       */
      const claim: WaitAllClaim = { parentSessionId, suppressedEventIds: new Set<string>(), targets: targetSet }
      this.waitAllClaims.add(claim)
      const matchingInfos = () =>
        readScopeInfos(parentSessionId).pipe(Effect.map((infos) => infos.filter((info) => targetSet.has(info.canonicalName))))
      const pendingNames = () =>
        matchingInfos().pipe(Effect.map((infos) => infos.filter((info) => !FINAL_STATUSES.has(info.status)).map((info) => info.canonicalName)))
      const finalize = Effect.gen({ self: this }, function* () {
        const responses = (yield* matchingInfos()).filter((info) => FINAL_STATUSES.has(info.status)).map((info) => this.agentResponse(info))
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
      })
      const claimed = Effect.gen({ self: this }, function* () {
        if (explicitTargets !== undefined) {
          const infos = yield* readScopeInfos(parentSessionId)
          const missing = [...explicitTargets].filter((target) => !infos.some((info) => target === info.canonicalName))
          if (missing.length > 0) {
            return yield* subagentError(`Agent not found in this parent session: ${missing.join(', ')}`)
          }
        }
        while (true) {
          if ((yield* pendingNames()).length === 0) {
            return yield* finalize
          }
          yield* Effect.raceFirst(Effect.sleep(250), awaitAbort(waitSignal))
        }
      })
      return yield* claimed.pipe(Effect.ensuring(Effect.sync(() => this.releaseWaitAllClaim(claim))))
    })
  }

  private assertProfileAvailable(info: AgentInfo): Effect.Effect<void, SubagentError> {
    return Effect.suspend(() => {
      const profile = info.profile ?? info.agentType
      return isNotNullOrUndefined(profile) && isNotEmptyString(profile) && !Object.hasOwn(AGENT_CONFIGS, profile)
        ? Effect.fail(subagentError(`Agent ${info.canonicalName} uses an unavailable profile: ${profile}`))
        : Effect.void
    })
  }

  private requireAgent(target: string, parentSessionId: string): Effect.Effect<AgentInfo, SubagentError> {
    return Effect.try(() => getAgent(target, parentSessionId)).pipe(
      Effect.flatten,
      Effect.catchCause((cause) => Effect.fail(subagentError(causeMessage(Cause.squash(cause)), Cause.squash(cause)))),
      Effect.flatMap((info) =>
        info === undefined ? Effect.fail(subagentError(`Agent not found in this parent session: ${target}`)) : Effect.succeed(info)
      )
    )
  }

  sendMessage(parentSessionId: string, target: string, message: string): Effect.Effect<{ delivery: 'steer' | 'prompt' }, SubagentFailure> {
    return Effect.gen({ self: this }, function* () {
      yield* this.ready()
      let info = yield* this.requireAgent(target, parentSessionId)
      yield* this.assertProfileAvailable(info)
      let live = this.live.get(info.id)
      if (isTrue(live?.expectedExit)) {
        yield* live.termination === undefined ? Effect.void : Fiber.join(live.termination).pipe(Effect.ignore)
        live = undefined
        info = yield* this.requireAgent(target, parentSessionId)
        yield* this.assertProfileAvailable(info)
      }
      yield* this.assertClaudeLaunchAllowed(info)
      yield* this.assertContinuationAllowed(info, live)
      const wasLive = live !== undefined
      const claim = yield* this.claimFollowUp(info, live)
      return yield* this.withFollowUpClaim(
        info,
        claim,
        Effect.gen({ self: this }, function* () {
          const liveAgent = live ?? (yield* this.restartForFollowUp(info))
          return yield* wasLive && (info.status === 'starting' || info.status === 'running')
            ? this.steerFollowUp(info, liveAgent, message, claim)
            : this.promptFollowUp(info, liveAgent, message, claim)
        })
      )
    })
  }

  interruptAgent(parentSessionId: string, target: string): Effect.Effect<{ previous_status: AgentRuntimeStatus }, SubagentFailure> {
    return Effect.gen({ self: this }, function* () {
      yield* this.ready()
      const info = yield* this.requireAgent(target, parentSessionId)
      const previous = info.status
      if (previous !== 'starting' && previous !== 'running') {
        return { previous_status: previous }
      }
      const live = this.live.get(info.id)
      if (live !== undefined) {
        live.info.status = 'interrupted'
        live.finalizedRun = true
      }
      const interruptedAt = yield* Clock.currentTimeMillis
      const interrupted = live?.info ?? info
      interrupted.status = 'interrupted'
      interrupted.lastActivity = interruptedAt
      yield* saveInfo(interrupted)
      this.notifyStatusChange(interrupted)
      yield* live === undefined ? this.terminateOwnedChild(interrupted) : this.terminateProcess(live)
      this.finishWaitTarget(parentSessionId, info.canonicalName)
      this.pushMailbox(
        {
          agentName: info.canonicalName,
          createdAt: interruptedAt,
          id: randomUUID(),
          parentSessionId,
          status: 'interrupted',
          ...agentMetadata(info),
        },
        false
      )
      return { previous_status: previous }
    })
  }

  /**
   * The child can already be gone and its PID reused by the time this runs. The child handle is always safe, but a
   * process-group signal and a Windows tree kill reach unrelated processes, so both are gated on
   * a freshly re-verified ownership identity.
   */
  private killVerifiedTree(live: LiveAgent, kill: (ownership: ChildProcessOwnership) => Effect.Effect<void>): Effect.Effect<void> {
    const ownership = live.info.childProcess
    if (ownership === undefined) {
      return Effect.void
    }
    return Effect.gen({ self: this }, function* () {
      if ((yield* this.inspector.ownershipVerdict(ownership)) === 'match') {
        yield* kill(ownership)
      }
    })
  }

  /*
   * The child handle is not the safe fallback it looks like: the spawner kills the detached process
   * group (`process.kill(-pid)`, `taskkill /T` on Windows) before it ever falls back to the bare
   * PID, so an ungated `proc.kill` reaches whatever reused that PID. Every signal is therefore
   * gated on a re-verified identity, and the handle is used only before one exists to verify.
   */
  private signalProcessTree(live: LiveAgent, signal: ChildProcess.Signal): Effect.Effect<void> {
    if (live.info.childProcess === undefined) {
      // Pre-handshake: ownership has not been recorded yet, so the handle is the only reference.
      return live.proc.kill({ killSignal: signal }).pipe(Effect.ignore)
    }
    return this.killVerifiedTree(live, (ownership) =>
      this.platform === 'win32'
        ? live.proc.kill({ killSignal: signal }).pipe(Effect.ignore)
        : Effect.sync(() => signalProcessGroup(ownership.pid, signal, true))
    )
  }

  /**
   * Signalling waits on process death alone: `live.exit` additionally waits for the post-exit
   * output drain, so a child whose descendants hold the pipes open would look alive after it died.
   */
  private markProcessExited(live: LiveAgent): Effect.Effect<void> {
    return Effect.suspend(() => {
      live.processExited = true
      return Deferred.succeed(live.exited, undefined).pipe(Effect.asVoid)
    })
  }

  private exitWait(timeoutMs: number): number {
    return Math.max(1, Math.round(timeoutMs * this.exitWaitScale))
  }

  private awaitChildExit(live: LiveAgent, timeoutMs: number): Effect.Effect<void> {
    return Deferred.await(live.exited).pipe(Effect.timeoutOption(this.exitWait(timeoutMs)), Effect.asVoid)
  }

  private awaitChildCleanup(live: LiveAgent, timeoutMs: number): Effect.Effect<void> {
    return Deferred.await(live.exit).pipe(Effect.timeoutOption(this.exitWait(timeoutMs)), Effect.asVoid)
  }

  private terminationSequence(live: LiveAgent): Effect.Effect<void, SubagentError> {
    return Effect.gen({ self: this }, function* () {
      // Built before `expectedExit` flips so the abort request still reaches the child.
      // Awaited only after the flip, so a child exiting mid-round-trip is not reported as an unexpected exit.
      const abortRequest = this.dispatchCommand(live, { type: 'abort' }, 1000).pipe(Effect.ignore)
      live.expectedExit = true
      this.clearInactivityMonitor(live)
      yield* abortRequest
      yield* Queue.end(live.stdin)
      yield* this.awaitChildExit(live, 500)
      if (!live.processExited) {
        yield* this.signalProcessTree(live, 'SIGTERM')
        yield* this.awaitChildExit(live, 1000)
      }
      if (!live.processExited) {
        yield* this.platform === 'win32'
          ? this.killVerifiedTree(live, (ownership) => this.killWindowsTree(ownership.pid))
          : this.signalProcessTree(live, 'SIGKILL')
        yield* this.awaitChildExit(live, 1000)
      }
      if (live.processExited) {
        // The child is already gone; callers still expect its artifacts cleared, which only happens once output has drained.
        yield* this.awaitChildCleanup(live, POST_EXIT_DRAIN_MS + 1000)
      }
      return live.processExited
    }).pipe(
      Effect.flatMap((finished) => (finished ? Effect.void : subagentError(`Unable to terminate child Pi process for ${live.info.canonicalName}.`)))
    )
  }

  private terminateProcess(live: LiveAgent): Effect.Effect<void, SubagentError> {
    return Effect.suspend(() => {
      if (live.processFinished) {
        return Effect.void
      }
      if (live.termination !== undefined) {
        return Fiber.join(live.termination)
      }
      return Effect.gen({ self: this }, function* () {
        const fiber = yield* Effect.forkIn(this.terminationSequence(live), this.detachedScope)
        live.termination = fiber
        return yield* Fiber.join(fiber)
      })
    }).pipe(
      // A failed attempt must not be cached, or interrupt and shutdown would only rejoin the failure.
      Effect.tapError(() =>
        Effect.sync(() => {
          live.termination = undefined
        })
      )
    )
  }

  /**
   * Every caller awaits the same run: an interrupted first caller would otherwise abort the
   * controller and then leave children, scopes, and exit watchers alive with nothing to reclaim them.
   */
  shutdown(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const inFlight = this.shuttingDown
      if (inFlight !== undefined) {
        return Deferred.await(inFlight)
      }
      const completed = Deferred.makeUnsafe<void>()
      this.shuttingDown = completed
      return this.teardown.pipe(Effect.ensuring(Deferred.succeed(completed, undefined)), Effect.uninterruptible)
    })
  }

  private readonly teardown: Effect.Effect<void> = Effect.gen({ self: this }, function* () {
    this.shutdownController.abort(new Error('Agent manager shut down.'))
    yield* this.ready()
    // Bounded: a launch that ignores the abort must delay shutdown, not block it forever.
    yield* Effect.forEach([...this.launchesInFlight], Deferred.await, { concurrency: 'unbounded' }).pipe(
      Effect.timeoutOrElse({ duration: SHUTDOWN_LAUNCH_DRAIN_MS, orElse: () => Effect.void })
    )
    const stoppedAt = yield* Clock.currentTimeMillis
    const stopping: { live: LiveAgent; terminate: Effect.Effect<void, SubagentError> }[] = []
    for (const live of this.live.values()) {
      if (live.info.status === 'starting' || live.info.status === 'running') {
        live.info.status = 'interrupted'
        live.info.lastActivity = stoppedAt
        live.finalizedRun = true
        yield* saveInfo(live.info)
        this.notifyStatusChange(live.info)
      }
      stopping.push({ live, terminate: this.terminateProcess(live) })
    }
    /*
     * Exit watchers live in `detachedScope`, so closing it interrupts any watcher still waiting on
     * a child that refused to die, stranding that child's `live.scope` and its output readers.
     * `finishProcess` is idempotent, so agents whose watcher already ran are unaffected, and a
     * child that failed to terminate keeps its ownership record for the next start to reconcile.
     */
    yield* Effect.forEach(
      stopping,
      ({ live, terminate }) =>
        Effect.exit(terminate).pipe(Effect.flatMap((exit) => this.finishProcess(live, undefined, { retainOwnership: Exit.isFailure(exit) }))),
      { concurrency: 'unbounded', discard: true }
    )
    yield* Scope.close(this.detachedScope, Exit.void)
  })
}

export const writeFullToolOutput = (content: string) =>
  Effect.gen(function* () {
    const directory = join(getRunsDir(), '_outputs')
    yield* ensurePrivateDirEffect(directory, true)
    const file = join(directory, `${yield* Clock.currentTimeMillis}-${randomUUID()}.txt`)
    yield* nodeFileSystem.writeFileString(file, content)
    return file
  })
