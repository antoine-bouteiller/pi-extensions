import { Clock, Context, Deferred, Effect, Exit, Layer, Ref, Schema, Scope, Semaphore } from 'effect'
import { Value } from 'typebox/value'

import { AgentActivity, type AgentActivityApi } from '#shared/effect/app_services'
import { validateWorkerSessionPath } from '#shared/effect/bun_host_file_system'
import { bunPath } from '#shared/effect/bun_services'
import { type RunningAgent } from '#shared/state/agent_activity'

import {
  ChildCommandErrorFrameSchema,
  ChildProgressFrameSchema,
  ChildReadyFrameSchema,
  ChildResultFrameSchema,
  ChildSteerAckFrameSchema,
  type AdmissionSnapshot,
  type AgentListEntry,
  type AgentRecordView,
  type AgentResult,
  type CommandError,
  type PersistedResolvedProfile,
  type RunningAcceptance,
  type SettledInterruptNoop,
  type SpawnAgentInput,
  type SteeringAck,
  type ToolErrorCode,
  deriveChildEnvironment,
  deriveWorkerConfig,
} from './model.js'
import { createActivityProjection } from './operator.js'
import { ChildProcess, type ChildProcessApi, type ProcessError, type ProcessIdentity, type RunningChild, type TerminationResult } from './process.js'
import { MAX_ARTIFACT_BYTES, MAX_FRAME_BYTES, ProtocolError, encodeFrame } from './protocol.js'
import {
  ArtifactTooLargeError,
  ProfileResolver,
  NotificationSink,
  SubagentStore,
  type AgentTurnRecord,
  type LaunchLease,
  type NotificationSinkApi,
  type NotificationToken,
  type ProfileResolverApi,
  type StoreError,
  type SubagentRecord,
  type SubagentStoreApi,
} from './store.js'

type SessionKey = string
type SettledRecord = Extract<SubagentRecord, { readonly settledAt: number }>
export class PublicRefusalError extends Schema.TaggedError<PublicRefusalError>()('PublicRefusalError', {
  cause: Schema.optional(Schema.Unknown),
  code: Schema.Literals([
    'unknown_profile',
    'duplicate_task_name',
    'capacity_exceeded',
    'missing_provider',
    'missing_model',
    'unavailable_tool',
    'unsafe_tool',
    'startup_timeout',
    'startup_failed',
    'frame_too_large',
    'protocol_error',
    'unknown_agent',
    'empty_targets',
    'duplicate_target',
    'not_ready',
    'follow_up_used',
    'not_resumable',
    'context_limit',
    'agent_failed',
    'turn_timeout',
    'interrupted',
    'result_too_large',
    'session_unavailable',
  ]),
  message: Schema.String,
  task_name: Schema.optional(Schema.String),
}) {}
export class LifecycleError extends Schema.TaggedError<LifecycleError>()('LifecycleError', {
  cause: Schema.optional(Schema.Unknown),
  message: Schema.String,
  operation: Schema.Literals(['close_session', 'initialize', 'open_session']),
  reason: Schema.Literals(['cleanup_incomplete', 'host_failure', 'session_not_open']),
}) {}
export type OrchestrationError = PublicRefusalError | LifecycleError

export interface SubagentOrchestratorApi {
  readonly initialize: Effect.Effect<void, OrchestrationError>
  readonly openSession: (session: SessionKey) => Effect.Effect<number, OrchestrationError>
  readonly closeSession: (session: SessionKey) => Effect.Effect<void, OrchestrationError>
  readonly spawn: (
    session: SessionKey,
    admission: AdmissionSnapshot,
    request: SpawnAgentInput
  ) => Effect.Effect<AgentResult | RunningAcceptance, OrchestrationError>
  readonly waitOne: (session: SessionKey, targets?: readonly string[]) => Effect.Effect<AgentResult, OrchestrationError>
  readonly waitAll: (session: SessionKey, targets?: readonly string[]) => Effect.Effect<readonly AgentResult[], OrchestrationError>
  readonly list: (session: SessionKey) => Effect.Effect<readonly AgentListEntry[], OrchestrationError>
  readonly read: (session: SessionKey, target: string) => Effect.Effect<AgentRecordView, OrchestrationError>
  readonly send: (
    session: SessionKey,
    admission: AdmissionSnapshot,
    target: string,
    message: string
  ) => Effect.Effect<SteeringAck | CommandError | AgentResult, OrchestrationError>
  readonly interrupt: (session: SessionKey, target: string) => Effect.Effect<AgentResult | SettledInterruptNoop, OrchestrationError>
  readonly interruptAll: (session: SessionKey) => Effect.Effect<void, OrchestrationError>
  readonly hasLiveChildren: (session: SessionKey) => boolean
}
export class SubagentOrchestrator extends Context.Service<SubagentOrchestrator, SubagentOrchestratorApi>()(
  'pi-extensions/features/sub_agents/orchestrator/SubagentOrchestrator'
) {}

type Phase = 'closed' | 'open' | 'opening' | 'closing'
type TurnState = 'running' | 'settling' | 'settled'
interface Reservation {
  readonly agentId: string
  readonly profile: PersistedResolvedProfile
  readonly slotId: string
  readonly taskName: string
}
interface WaitDelivery {
  readonly claim: number
  readonly kind: 'wait'
  readonly previous: Delivery
  state: 'active' | 'committed' | 'abandoned'
}
type Delivery = 'unclaimed' | 'notice' | WaitDelivery
interface Turn extends Reservation {
  readonly activity: Ref.Ref<number>
  readonly child: RunningChild
  readonly background: boolean
  readonly deferred: Deferred.Deferred<AgentResult, PublicRefusalError>
  readonly deadlineMonotonic: bigint
  readonly deadlineWall: number
  readonly delivery: Delivery
  readonly followUp: Ref.Ref<'available' | 'pending' | 'used'>
  readonly generation: number
  readonly logPath: string
  readonly sessionKey: string
  readonly sessionPath: string
  readonly settledAt?: number
  readonly state: TurnState
  readonly steerResponse: Ref.Ref<Deferred.Deferred<SteeringAck | CommandError> | undefined>
  readonly result?: AgentResult
  readonly warningEnqueued: boolean
  readonly turn: number
  readonly turns: readonly AgentTurnRecord[]
  readonly released: boolean
  readonly resourceReleased: Ref.Ref<boolean>
}
const ownsWaitClaim = (current: Turn | undefined, claim: Turn): current is Turn =>
  typeof current?.delivery === 'object' &&
  typeof claim.delivery === 'object' &&
  current.generation === claim.generation &&
  current.delivery.claim === claim.delivery.claim
const restoredDelivery = (delivery: Delivery): Delivery => {
  if (typeof delivery !== 'object' || delivery.state !== 'abandoned') {
    return delivery
  }
  return restoredDelivery(delivery.previous)
}
const commitWaitClaims = (claims: readonly Turn[]): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const claim of claims) {
      if (typeof claim.delivery === 'object' && claim.delivery.state === 'active') {
        claim.delivery.state = 'committed'
      }
    }
  })

interface Notice {
  readonly id: number
  readonly kind: 'settlement' | 'warning'
  readonly message: string
  readonly result?: AgentResult
  readonly settledAt: number
  readonly taskName: string
}
interface Provisional extends Reservation {
  readonly child: RunningChild
  readonly deleteArtifacts: boolean
  readonly generation: number
  readonly logPath: string
  readonly resourceReleased: Ref.Ref<boolean>
  readonly session: SessionKey
}
interface Snapshot {
  readonly agents: ReadonlyMap<string, Turn>
  readonly notices: readonly Notice[]
  readonly phase: Phase
  readonly provisional: ReadonlyMap<string, Provisional>
  readonly slots: ReadonlyMap<string, Reservation>
  readonly starting: ReadonlyMap<string, Reservation>
}
interface Session {
  readonly generation: number
  readonly key: SessionKey
  readonly mutex: Semaphore.Semaphore
  readonly scope: Scope.Closeable
  readonly state: Ref.Ref<Snapshot>
}
const notificationToken = (session: Session): NotificationToken => ({
  generation: session.generation,
  session: session.key,
})
interface Cleanup {
  readonly child?: RunningChild
  readonly identity: ProcessIdentity
  readonly logPath?: string
  readonly preserveRecord?: boolean
  readonly release?: Effect.Effect<void, ProcessError>
  readonly profile?: PersistedResolvedProfile
  readonly session: SessionKey
  readonly taskName: string
}
interface ChildDecoder {
  readonly end: () => void
  readonly push: (chunk: Uint8Array) => unknown[]
}
interface DecodedChunk {
  readonly error?: unknown
  readonly values: readonly unknown[]
}
interface DecodedChild {
  readonly command_id: string
  readonly agent_id: string
  readonly turn: number
  readonly type: string
}
interface StopResult {
  readonly errors: readonly unknown[]
  readonly stopped: 'exited' | TerminationResult
}
interface InterruptPlan {
  readonly notices: readonly Notice[]
  readonly turn: Turn
  readonly value?: SettledInterruptNoop
}
interface WaitOnePlan {
  readonly consumedNotice?: Notice
  readonly notice?: AgentResult
  readonly turns: readonly Turn[]
}

const refusal = (code: ToolErrorCode, message: string, cause?: unknown): PublicRefusalError =>
  PublicRefusalError.make(cause === undefined ? { code, message } : { cause, code, message })
const unavailable = (): PublicRefusalError => refusal('session_unavailable', 'The session is not open.')
const failure = (operation: LifecycleError['operation'], reason: LifecycleError['reason'], error: unknown): LifecycleError =>
  LifecycleError.make({
    cause: error,
    message: error instanceof Error ? error.message : String(error),
    operation,
    reason,
  })
export const WORKER_ENTRYPOINT = Bun.fileURLToPath(new URL('worker.ts', import.meta.url))
const TURN_DEADLINE_MILLIS = 30 * 60 * 1000
const FOLLOW_UP_OUTPUT_RESERVE_TOKENS = 8192
const MAX_NOTIFICATION_BYTES = 50 * 1024
const MAX_NOTIFICATION_LINES = 2000
const notificationDirections = 'Use list_agents for omitted tasks and read_agent_response for detail.'
const notificationBytes = new TextEncoder()
const boundedNotification = (message: string): string => {
  let bytes = notificationBytes.encode(notificationDirections).byteLength
  let lines = notificationDirections.split('\n').length
  let bounded = ''
  for (const character of message) {
    const characterBytes = notificationBytes.encode(character).byteLength
    if (bytes + characterBytes + 1 > MAX_NOTIFICATION_BYTES || (character === '\n' && lines + 1 > MAX_NOTIFICATION_LINES)) {
      return `${bounded}…`
    }
    bounded += character
    bytes += characterBytes
    if (character === '\n') {
      lines += 1
    }
  }
  return bounded
}
const resultMessage = (result: AgentResult): string =>
  boundedNotification(
    result.status === 'completed'
      ? `Sub-agent ${result.task_name} completed: ${result.conclusion}`
      : `Sub-agent ${result.task_name} ${result.status}: ${result.error.message}`
  )
const boundedInlineResult = (value: string): boolean =>
  notificationBytes.encode(value).byteLength <= MAX_NOTIFICATION_BYTES && value.split('\n').length <= MAX_NOTIFICATION_LINES
interface InlineResultFrame {
  readonly conclusion?: string
  readonly conclusion_preview?: string
}
const oversizedInlineResult = (frame: InlineResultFrame): boolean =>
  (frame.conclusion !== undefined && !boundedInlineResult(frame.conclusion)) ||
  (frame.conclusion_preview !== undefined && !boundedInlineResult(frame.conclusion_preview))
const knownTurns = (state: Snapshot, targets: readonly string[]): readonly Turn[] | string => {
  const unknown = targets.find((target) => !state.agents.has(target))
  if (unknown !== undefined) {
    return unknown
  }
  return targets.flatMap((target) => {
    const turn = state.agents.get(target)
    return turn === undefined ? [] : [turn]
  })
}
const correlatedInitial = (frame: DecodedChild, agentId: string, turn: number): boolean =>
  frame.agent_id === agentId && frame.turn === turn && frame.command_id === 'initial'
const childLifecycleFrame = (frame: unknown): frame is DecodedChild =>
  Value.Check(ChildProgressFrameSchema, frame) ||
  Value.Check(ChildResultFrameSchema, frame) ||
  Value.Check(ChildSteerAckFrameSchema, frame) ||
  Value.Check(ChildCommandErrorFrameSchema, frame)
const correlatedLifecycle = (frame: unknown, agentId: string, turn: number): frame is DecodedChild =>
  childLifecycleFrame(frame) && correlatedInitial(frame, agentId, turn)
const validBeforeReady = (frame: unknown, sessionPath: string | undefined): boolean =>
  sessionPath !== undefined || Value.Check(ChildProgressFrameSchema, frame)
const outcome = (taskName: string, status: 'failed' | 'interrupted', code: ToolErrorCode, message: string, turn = 1): AgentResult => ({
  error: { code, message },
  status,
  task_name: taskName,
  turn,
})
const copy = <Key, Value>(map: ReadonlyMap<Key, Value>): Map<Key, Value> => new Map(map)
const cleanupKey = (agentId: string, identity: ProcessIdentity): string => `${agentId}:${identity.pid}:${identity.birthMarker}`
const attempt = <Value, Error>(effect: Effect.Effect<Value, Error>) =>
  effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) => Effect.succeed({ error, ok: false as const }))
  )
const releaseChild = (child: RunningChild, released: Ref.Ref<boolean>): Effect.Effect<void, ProcessError> =>
  Ref.modify(released, (wasReleased): readonly [boolean, boolean] => [wasReleased, true]).pipe(
    Effect.flatMap((wasReleased) => (wasReleased ? Effect.void : child.release))
  )
const releaseProcess = (turn: Turn): Effect.Effect<void, ProcessError> => releaseChild(turn.child, turn.resourceReleased)
const releaseProvisional = (provisional: Provisional): Effect.Effect<void, ProcessError> =>
  releaseChild(provisional.child, provisional.resourceReleased)
const locked = <Value, Error>(session: Session, effect: Effect.Effect<Value, Error>): Effect.Effect<Value, Error> =>
  session.mutex.withPermits(1)(effect)
const snapshot = (session: Session): Effect.Effect<Snapshot> => Ref.get(session.state)
const oversizedFrame = (error: unknown): boolean => error instanceof ProtocolError && error.message === 'Frame exceeds the 1 MiB limit.'
const recordContains = (record: SubagentRecord | undefined, result: AgentResult): boolean => {
  const persisted = record?.turns.at(-1)?.result
  return (
    record?.status === result.status &&
    persisted?.status === result.status &&
    persisted.task_name === result.task_name &&
    persisted.turn === result.turn
  )
}
const resolvePendingSteer = (turn: Turn, value: AgentResult, commandId: string): Effect.Effect<void> =>
  Ref.getAndSet(turn.steerResponse, undefined).pipe(
    Effect.flatMap((waiting) =>
      waiting === undefined
        ? Effect.void
        : Ref.set(turn.followUp, 'available').pipe(
            Effect.andThen(
              commandId === 'protocol_error'
                ? Effect.void
                : Deferred.succeed(waiting, {
                    accepted: false,
                    error: { code: 'turn_settled', message: 'The turn settled before steering was accepted.' },
                    status: value.status,
                    task_name: turn.taskName,
                    turn: turn.turn,
                  })
            )
          )
    ),
    Effect.asVoid
  )
const decodeChunk = (frames: ChildDecoder, chunk: Uint8Array): DecodedChunk => {
  const values: unknown[] = []
  let start = 0
  try {
    while (start < chunk.byteLength) {
      const newline = chunk.indexOf(10, start)
      const end = newline === -1 ? chunk.byteLength : newline + 1
      values.push(...frames.push(chunk.slice(start, end)))
      start = end
    }
    return { values }
  } catch (error) {
    return { error, values }
  }
}
const decoder = (): ChildDecoder => {
  const parts: Uint8Array[] = []
  let size = 0
  return {
    end: () => {
      if (size !== 0) {
        throw new ProtocolError('Worker stdout ended with an unterminated frame.')
      }
    },
    push: (chunk) => {
      const frames: unknown[] = []
      let start = 0
      for (let index = 0; index < chunk.byteLength; index += 1) {
        size += 1
        if (size > MAX_FRAME_BYTES) {
          throw new ProtocolError('Frame exceeds the 1 MiB limit.')
        }
        if (chunk[index] !== 10) {
          continue
        }
        parts.push(chunk.slice(start, index + 1))
        const line = new Uint8Array(size)
        let offset = 0
        for (const part of parts) {
          line.set(part, offset)
          offset += part.byteLength
        }
        if (line[0] === undefined || line[0] === 13 || line.at(-1) !== 10 || line.includes(13)) {
          throw new ProtocolError('Invalid strict-LF frame.')
        }
        try {
          frames.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line.subarray(0, -1))))
        } catch {
          throw new ProtocolError('Frame is not valid UTF-8 JSON.')
        }
        parts.length = 0
        size = 0
        start = index + 1
      }
      if (start < chunk.byteLength) {
        parts.push(chunk.slice(start))
      }
      return frames
    },
  }
}

const inactivity = (turn: Turn, warn: (turn: Turn) => Effect.Effect<void>): Effect.Effect<void> => {
  const watch = (): Effect.Effect<void> =>
    Ref.get(turn.activity).pipe(
      Effect.flatMap((seen) =>
        Effect.sleep('5 minutes').pipe(
          Effect.flatMap(() => Ref.get(turn.activity).pipe(Effect.flatMap((current) => (current === seen ? warn(turn) : watch()))))
        )
      )
    )
  return watch()
}

interface MadeOrchestrator {
  readonly api: SubagentOrchestratorApi
  readonly dispose: Effect.Effect<void>
}

interface OrchestratorDependencies {
  readonly activity: AgentActivityApi
  readonly cleanup: Ref.Ref<ReadonlyMap<string, Cleanup>>
  readonly notifications: NotificationSinkApi
  readonly process: ChildProcessApi
  readonly resolver: ProfileResolverApi
  readonly store: SubagentStoreApi
}

const activityColor = (profile: string): RunningAgent['color'] => {
  switch (profile) {
    case 'implementer': {
      return 'success'
    }
    case 'librarian': {
      return 'accent'
    }
    case 'reviewer': {
      return 'warning'
    }
    case 'scout': {
      return 'thinkingLow'
    }
    default: {
      return 'muted'
    }
  }
}

const make = ({ activity, cleanup, notifications, process, resolver, store }: OrchestratorDependencies): MadeOrchestrator => {
  const sessions = new Map<string, Session>()
  // Ponytail: global session lifecycle lock; use per-session locks when cross-session contention is measured
  const lifecycle = Semaphore.makeUnsafe(1)
  const activityProjection = createActivityProjection({
    publish: activity.publish,
  })
  let initialized: Deferred.Deferred<void, OrchestrationError> | undefined
  let ownerIdentity: ProcessIdentity | undefined
  let slotIdentifiers = 0
  let generations = 0
  let noticeIdentifiers = 0
  let deliveryClaims = 0
  const touch = (turn: Turn): Effect.Effect<void> =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((lastActivityAt) =>
        Ref.update(turn.activity, (value) => value + 1).pipe(Effect.andThen(activityProjection.updateActivity(turn.agentId, lastActivityAt)))
      )
    )
  const active = (key: string): Effect.Effect<Session, PublicRefusalError> =>
    Effect.sync(() => sessions.get(key)).pipe(
      Effect.flatMap((session) =>
        session === undefined
          ? Effect.fail(unavailable())
          : snapshot(session).pipe(Effect.flatMap((state) => (state.phase === 'open' ? Effect.succeed(session) : Effect.fail(unavailable()))))
      )
    )
  const retainCleanup = (agentId: string, item: Cleanup) =>
    store.listLeases.pipe(
      Effect.flatMap((leases) => {
        const lease = leases.find((candidate) => candidate.agentId === agentId)?.lease
        const owned = lease === undefined || (lease.identity.pid === item.identity.pid && lease.identity.birthMarker === item.identity.birthMarker)
        return owned
          ? store.createLease(agentId, {
              identity: item.identity,
              owner: ownerIdentity,
              preserveRecord: item.preserveRecord,
              session: item.session,
              taskName: item.taskName,
            })
          : Effect.void
      }),
      Effect.andThen(Ref.update(cleanup, (items) => new Map(items).set(cleanupKey(agentId, item.identity), item))),
      Effect.asVoid
    )
  const releaseCleanup = (agentId: string, item: Cleanup, removeArtifacts = false) =>
    (item.release ?? item.child?.release ?? Effect.void).pipe(
      Effect.andThen(
        store.listLeases.pipe(
          Effect.flatMap((leases) => {
            const lease = leases.find((candidate) => candidate.agentId === agentId)?.lease
            if (lease !== undefined && (lease.identity.pid !== item.identity.pid || lease.identity.birthMarker !== item.identity.birthMarker)) {
              return Effect.void
            }
            return removeArtifacts && item.preserveRecord !== true ? store.delete(agentId) : store.removeLease(agentId, item.identity)
          })
        )
      ),
      Effect.andThen(item.logPath === undefined ? Effect.void : store.removeLog(agentId, item.logPath)),
      Effect.andThen(
        Ref.update(cleanup, (items) => {
          const next = new Map(items)
          next.delete(cleanupKey(agentId, item.identity))
          return next
        })
      ),
      Effect.asVoid
    )
  const superviseCleanup = (agentId: string, item: Cleanup): Effect.Effect<void> => {
    if (item.child === undefined) {
      return Effect.void
    }
    const { child } = item
    const retry = (): Effect.Effect<void> =>
      Effect.race(child.wait.pipe(Effect.as('exited' as const)), Effect.sleep('5 seconds').pipe(Effect.as('retry' as const))).pipe(
        Effect.flatMap((observed) =>
          observed === 'exited'
            ? releaseCleanup(agentId, item).pipe(Effect.catch(() => Effect.sleep('5 seconds').pipe(Effect.andThen(retry))))
            : process.terminateVerified(child.identity).pipe(
                Effect.orElseSucceed(() => 'stillAlive' as const),
                Effect.flatMap((result) =>
                  result === 'exited' || result === 'mismatch' || result === 'signalled'
                    ? releaseCleanup(agentId, item, result === 'mismatch').pipe(
                        Effect.catch(() => Effect.sleep('5 seconds').pipe(Effect.andThen(retry)))
                      )
                    : retry()
                )
              )
        )
      )
    return retry()
  }
  const superviseHandoff = (agentId: string, item: Cleanup): Effect.Effect<void> =>
    Ref.update(cleanup, (items) => new Map(items).set(cleanupKey(agentId, item.identity), item)).pipe(
      Effect.andThen(Effect.forkDetach(superviseCleanup(agentId, item))),
      Effect.asVoid
    )
  const handoff = (agentId: string, item: Cleanup): Effect.Effect<void> =>
    retainCleanup(agentId, item).pipe(
      Effect.andThen(Effect.forkDetach(superviseCleanup(agentId, item))),
      Effect.asVoid,
      Effect.catch((error) => superviseHandoff(agentId, item).pipe(Effect.andThen(Effect.fail(error)))),
      Effect.orDie
    )
  const findTurn = (session: Session, name: string): Effect.Effect<Turn | undefined> =>
    snapshot(session).pipe(Effect.map((state) => state.agents.get(name)))
  const batch = (notices: readonly Notice[]): readonly Notice[] => {
    const accepted: Notice[] = []
    let bytes = notificationBytes.encode(notificationDirections).byteLength
    let lines = notificationDirections.split('\n').length
    for (const notice of notices) {
      const messageBytes = notificationBytes.encode(notice.message).byteLength + 1
      const messageLines = notice.message.split('\n').length + 1
      if (accepted.length > 0 && (bytes + messageBytes > MAX_NOTIFICATION_BYTES || lines + messageLines > MAX_NOTIFICATION_LINES)) {
        break
      }
      if (messageBytes + bytes <= MAX_NOTIFICATION_BYTES && messageLines + lines <= MAX_NOTIFICATION_LINES) {
        accepted.push(notice)
        bytes += messageBytes
        lines += messageLines
      }
    }
    return accepted
  }
  const flushNotifications = (session: Session): Effect.Effect<void> =>
    Effect.suspend(() =>
      Effect.yieldNow.pipe(
        Effect.andThen(
          locked(
            session,
            snapshot(session).pipe(
              Effect.flatMap((state) => {
                const claimed = batch(state.notices)
                if (claimed.length === 0) {
                  return Effect.succeed([] as readonly Notice[])
                }
                const ids = new Set(claimed.map((notice) => notice.id))
                return Ref.set(session.state, {
                  ...state,
                  notices: state.notices.filter((notice) => !ids.has(notice.id)),
                }).pipe(Effect.as(claimed))
              })
            )
          )
        ),
        Effect.flatMap((claimed) => {
          if (claimed.length === 0) {
            return Effect.void
          }
          return Effect.uninterruptibleMask((restore) =>
            Ref.make(false).pipe(
              Effect.flatMap((invoked) =>
                restore(Effect.yieldNow).pipe(
                  Effect.andThen(Ref.set(invoked, true)),
                  Effect.andThen(
                    notifications
                      .publish([...claimed.map((notice) => notice.message), notificationDirections], notificationToken(session))
                      .pipe(Effect.ignore)
                  ),
                  Effect.ensuring(
                    Ref.get(invoked).pipe(
                      Effect.flatMap((didInvoke) =>
                        didInvoke
                          ? Effect.void
                          : locked(
                              session,
                              snapshot(session).pipe(
                                Effect.flatMap((state) =>
                                  Ref.set(session.state, {
                                    ...state,
                                    notices: [...claimed, ...state.notices],
                                  })
                                )
                              )
                            )
                      )
                    )
                  )
                )
              )
            )
          ).pipe(Effect.andThen(flushNotifications(session)))
        })
      )
    )
  const enqueueNotice = (session: Session, notice: Omit<Notice, 'id'>): Effect.Effect<void> =>
    locked(
      session,
      snapshot(session).pipe(
        Effect.flatMap((state) =>
          Ref.set(session.state, {
            ...state,
            notices: [...state.notices, { ...notice, id: ++noticeIdentifiers }],
          })
        )
      )
    ).pipe(Effect.andThen(Effect.forkIn(flushNotifications(session), session.scope)), Effect.asVoid)
  const warnInactive = (session: Session, token: Turn): Effect.Effect<void> =>
    locked(
      session,
      Effect.gen(function* () {
        const state = yield* snapshot(session)
        const current = state.agents.get(token.taskName)
        if (current === undefined || current.generation !== token.generation || current.state !== 'running' || current.warningEnqueued) {
          return false
        }
        const agents = copy(state.agents)
        agents.set(token.taskName, { ...current, warningEnqueued: true })
        yield* Ref.set(session.state, { ...state, agents })
        return true
      })
    ).pipe(
      Effect.flatMap((enqueue) =>
        enqueue
          ? Clock.currentTimeMillis.pipe(
              Effect.flatMap((settledAt) =>
                enqueueNotice(session, {
                  kind: 'warning',
                  message: `Sub-agent ${token.taskName} has produced no verified progress for 5 minutes; it is still running.`,
                  settledAt,
                  taskName: token.taskName,
                })
              )
            )
          : Effect.void
      )
    )
  const registerProvisional = (session: Session, provisional: Provisional): Effect.Effect<void, PublicRefusalError> =>
    locked(
      session,
      snapshot(session).pipe(
        Effect.flatMap((state) =>
          state.phase === 'open'
            ? Ref.set(session.state, {
                ...state,
                provisional: new Map(state.provisional).set(provisional.slotId, provisional),
              })
            : Effect.fail(unavailable())
        )
      )
    )
  const removeProvisional = (session: Session, slotId: string): Effect.Effect<void> =>
    locked(
      session,
      snapshot(session).pipe(
        Effect.flatMap((state) => {
          const provisional = copy(state.provisional)
          provisional.delete(slotId)
          const slots = copy(state.slots)
          slots.delete(slotId)
          const starting = copy(state.starting)
          starting.delete(slotId)
          return Ref.set(session.state, { ...state, provisional, slots, starting })
        })
      )
    )
  const clearStarting = (session: Session, reservationId: string): Effect.Effect<void> =>
    locked(
      session,
      snapshot(session).pipe(
        Effect.flatMap((state) => {
          const starting = copy(state.starting)
          starting.delete(reservationId)
          const slots = copy(state.slots)
          slots.delete(reservationId)
          return Ref.set(session.state, { ...state, slots, starting })
        })
      )
    )
  const clearProvisionalStarting = (session: Session, slotId: string): Effect.Effect<void> =>
    locked(
      session,
      snapshot(session).pipe(
        Effect.flatMap((state) => {
          const starting = copy(state.starting)
          starting.delete(slotId)
          const slots = copy(state.slots)
          slots.delete(slotId)
          return Ref.set(session.state, { ...state, slots, starting })
        })
      )
    )
  const releaseSlot = (session: Session, turn: Turn): Effect.Effect<void> =>
    locked(
      session,
      Effect.gen(function* () {
        const state = yield* snapshot(session)
        const latest = state.agents.get(turn.taskName)
        if (latest === undefined || latest.generation !== turn.generation || latest.released) {
          return
        }
        const agents = copy(state.agents)
        agents.set(turn.taskName, { ...latest, released: true })
        const slots = copy(state.slots)
        slots.delete(turn.slotId)
        yield* Ref.set(session.state, { ...state, agents, slots })
      })
    )
  const stop = (turn: Turn, commandId: string): Effect.Effect<StopResult> => {
    let frame: string
    try {
      frame = encodeFrame({
        agent_id: turn.agentId,
        command_id: commandId,
        turn: turn.turn,
        type: 'interrupt',
      })
    } catch {
      return Effect.succeed({ errors: [], stopped: 'stillAlive' })
    }
    return Effect.gen(function* () {
      const write = yield* attempt(turn.child.write(frame))
      const closeInput = yield* attempt(turn.child.closeInput)
      const waited = yield* attempt(Effect.race(Effect.as(turn.child.wait, true), Effect.as(Effect.sleep('5 seconds'), false)))
      const terminated = waited.ok && waited.value ? undefined : yield* attempt(process.terminateVerified(turn.child.identity))
      const attempts = [write, closeInput, waited, ...(terminated === undefined ? [] : [terminated])]
      let stopped: StopResult['stopped'] = 'stillAlive'
      if (waited.ok && waited.value) {
        stopped = 'exited'
      } else if (terminated?.ok === true) {
        stopped = terminated.value
      }
      return {
        errors: attempts.flatMap((result) => (result.ok ? [] : [result.error])),
        stopped,
      }
    })
  }
  const handoffTurn = (session: Session, key: string, turn: Turn): Effect.Effect<void> =>
    locked(
      session,
      handoff(turn.agentId, {
        child: turn.child,
        identity: turn.child.identity,
        preserveRecord: turn.turn > 1,
        profile: turn.profile,
        release: releaseProcess(turn),
        session: key,
        taskName: turn.taskName,
      }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const state = yield* snapshot(session)
            const latest = state.agents.get(turn.taskName)
            const agents = copy(state.agents)
            if (latest !== undefined && latest.generation === turn.generation) {
              agents.set(turn.taskName, { ...latest, released: true })
            }
            const slots = copy(state.slots)
            slots.delete(turn.slotId)
            yield* Ref.set(session.state, { ...state, agents, slots })
          })
        )
      )
    )
  const removeUnpersistedRecord = (session: Session, turn: Turn): Effect.Effect<void> =>
    snapshot(session).pipe(
      Effect.flatMap((state) => {
        const result = state.agents.get(turn.taskName)?.result
        if (result === undefined) {
          return Effect.void
        }
        return store.readRecord(turn.agentId).pipe(
          Effect.flatMap((record) => (recordContains(record, result) ? Effect.void : store.delete(turn.agentId))),
          Effect.ignore
        )
      })
    )
  const completeStop = (session: Session, key: string, turn: Turn, stopped: StopResult['stopped']): Effect.Effect<void> => {
    if (stopped === 'exited') {
      return Effect.all([releaseProcess(turn).pipe(Effect.ignore), releaseSlot(session, turn), removeUnpersistedRecord(session, turn)]).pipe(
        Effect.asVoid
      )
    }
    if (stopped === 'mismatch') {
      const removeArtifacts = turn.turn === 1 ? store.delete(turn.agentId) : store.removeLease(turn.agentId)
      return Effect.all([removeArtifacts.pipe(Effect.ignore), releaseProcess(turn).pipe(Effect.ignore), releaseSlot(session, turn)]).pipe(
        Effect.asVoid
      )
    }
    return handoffTurn(session, key, turn)
  }
  const replaceRecordVerified = (agentId: string, record: SubagentRecord, result: AgentResult) =>
    Effect.gen(function* () {
      const written = yield* Effect.result(store.replaceRecord(agentId, record))
      if (written._tag === 'Success') {
        return { persisted: true as const, retryable: false as const }
      }
      const existing = yield* Effect.result(store.readRecord(agentId))
      if (existing._tag === 'Failure') {
        return { failure: written.failure, persisted: false as const, retryable: false as const }
      }
      return recordContains(existing.success, result)
        ? { persisted: true as const, retryable: false as const }
        : { failure: written.failure, persisted: false as const, retryable: true as const }
    })
  const persistSettlement = (current: Turn, record: SettledRecord, value: AgentResult) =>
    Effect.gen(function* () {
      const written = yield* replaceRecordVerified(current.agentId, record, value)
      if (written.persisted) {
        return { value }
      }
      const failed = outcome(current.taskName, 'failed', 'agent_failed', written.failure.message, current.turn)
      if (!written.retryable) {
        return { failure: written.failure, value: failed }
      }
      const fallbackRecord: SubagentRecord = {
        ...record,
        status: 'failed',
        turns: [...current.turns, { profile: current.profile, result: failed }],
      }
      const fallback = yield* replaceRecordVerified(current.agentId, fallbackRecord, failed)
      return fallback.persisted ? { value: failed } : { failure: fallback.failure, value: failed }
    })
  const settle = (
    session: Session,
    token: Turn,
    value: AgentResult,
    commandId: string,
    options: { readonly contextTokens?: number; readonly stopAfter?: boolean } = {}
  ): Effect.Effect<boolean> =>
    locked(
      session,
      Effect.gen(function* () {
        const state = yield* snapshot(session)
        const current = state.agents.get(token.taskName)
        if (current === undefined || current.generation !== token.generation || current.state !== 'running') {
          return false
        }
        const agents = copy(state.agents)
        agents.set(token.taskName, { ...current, state: 'settling' })
        yield* Ref.set(session.state, { ...state, agents })
        const settledAt = yield* Clock.currentTimeMillis
        const settledRecord: SettledRecord = {
          logPath: current.logPath,
          profile: current.profile,
          session: current.sessionKey,
          sessionPath: current.sessionPath,
          settledAt,
          status: value.status,
          taskName: current.taskName,
          turns: [...current.turns, { profile: current.profile, result: value }],
        }
        const persisted = yield* persistSettlement(
          current,
          options.contextTokens === undefined ? settledRecord : { ...settledRecord, contextTokens: options.contextTokens },
          value
        )
        const settledValue = persisted.value
        const persistenceFailure = persisted.failure
        yield* resolvePendingSteer(current, settledValue, commandId)
        const after = yield* snapshot(session)
        const latest = after.agents.get(token.taskName)
        if (latest === undefined || latest.generation !== token.generation) {
          return true
        }
        const settledAgents = copy(after.agents)
        const notify = persistenceFailure === undefined && latest.background && latest.delivery === 'unclaimed'
        const settled = {
          ...latest,
          delivery: notify ? ('notice' as const) : latest.delivery,
          result: settledValue,
          settledAt,
          state: 'settled' as const,
          turns: [...latest.turns, { profile: latest.profile, result: settledValue }],
        }
        settledAgents.set(token.taskName, settled)
        const notices = notify
          ? [
              ...after.notices,
              {
                id: ++noticeIdentifiers,
                kind: 'settlement' as const,
                message: resultMessage(settledValue),
                result: settledValue,
                settledAt,
                taskName: latest.taskName,
              },
            ]
          : after.notices
        yield* Ref.set(session.state, {
          ...after,
          agents: settledAgents,
          notices,
        })
        yield* activityProjection.remove(latest.agentId)
        yield* persistenceFailure === undefined
          ? Deferred.succeed(settled.deferred, settledValue)
          : Deferred.fail(settled.deferred, refusal('agent_failed', persistenceFailure.message))
        if (notify) {
          yield* Effect.forkIn(flushNotifications(session), session.scope)
        }
        return true
      })
    ).pipe(
      Effect.flatMap((claimed) =>
        claimed && options.stopAfter !== false && commandId !== 'close'
          ? stop(token, commandId).pipe(
              Effect.flatMap(({ stopped }) => completeStop(session, token.sessionKey, token, stopped)),
              Effect.as(true)
            )
          : Effect.succeed(claimed)
      ),
      Effect.uninterruptible
    )
  const restoreWaitClaims = (
    session: Session,
    claims: readonly Turn[],
    consumedNotices: readonly Notice[] = [],
    winners: readonly Turn[] = []
  ): Effect.Effect<void> =>
    locked(
      session,
      Effect.gen(function* () {
        const state = yield* snapshot(session)
        const agents = copy(state.agents)
        let notices = consumedNotices.length === 0 ? state.notices : [...consumedNotices, ...state.notices]
        let changed = consumedNotices.length > 0
        for (const claim of claims) {
          if (
            winners.some(
              (winner) => winner.taskName === claim.taskName && winner.generation === claim.generation && winner.delivery === claim.delivery
            )
          ) {
            continue
          }
          if (typeof claim.delivery !== 'object') {
            continue
          }
          claim.delivery.state = 'abandoned'
          const current = agents.get(claim.taskName)
          if (!ownsWaitClaim(current, claim)) {
            continue
          }
          const previous = restoredDelivery(claim.delivery.previous)
          agents.set(current.taskName, { ...current, delivery: previous })
          if (previous === 'unclaimed' && current.state === 'settled' && current.background && current.result !== undefined) {
            notices = [
              ...notices,
              {
                id: ++noticeIdentifiers,
                kind: 'settlement',
                message: resultMessage(current.result),
                result: current.result,
                settledAt: current.settledAt ?? (yield* Clock.currentTimeMillis),
                taskName: current.taskName,
              },
            ]
          }
          changed = true
        }
        if (changed) {
          yield* Ref.set(session.state, { ...state, agents, notices })
          yield* Effect.forkIn(flushNotifications(session), session.scope)
        }
      })
    )
  const ownedClaimResults = (session: Session, claims: readonly Turn[], results: readonly AgentResult[]): Effect.Effect<readonly AgentResult[]> =>
    locked(
      session,
      snapshot(session).pipe(
        Effect.map((state) =>
          results.filter((_result, index) => {
            const claim = claims[index]
            return claim !== undefined && ownsWaitClaim(state.agents.get(claim.taskName), claim)
          })
        )
      )
    )
  const promoteCancelledForeground = (session: Session, claim: Turn): Effect.Effect<void> =>
    locked(
      session,
      Effect.gen(function* () {
        const state = yield* snapshot(session)
        const current = state.agents.get(claim.taskName)
        if (current === undefined || current.generation !== claim.generation || current.background) {
          return
        }
        const agents = copy(state.agents)
        if (current.state === 'settled' && current.result !== undefined) {
          if (current.delivery !== 'unclaimed') {
            agents.set(current.taskName, { ...current, background: true })
            yield* Ref.set(session.state, { ...state, agents })
            return
          }
          agents.set(current.taskName, {
            ...current,
            background: true,
            delivery: 'notice',
          })
          yield* Ref.set(session.state, {
            ...state,
            agents,
            notices: [
              ...state.notices,
              {
                id: ++noticeIdentifiers,
                kind: 'settlement',
                message: resultMessage(current.result),
                result: current.result,
                settledAt: current.settledAt ?? (yield* Clock.currentTimeMillis),
                taskName: current.taskName,
              },
            ],
          })
          yield* Effect.forkIn(flushNotifications(session), session.scope)
          return
        }
        agents.set(current.taskName, {
          ...current,
          background: true,
          delivery: current.delivery,
        })
        yield* Ref.set(session.state, { ...state, agents })
      })
    )
  const valid = (turn: Turn, frame: unknown): boolean => {
    if (
      !Value.Check(ChildProgressFrameSchema, frame) &&
      !Value.Check(ChildResultFrameSchema, frame) &&
      !Value.Check(ChildSteerAckFrameSchema, frame) &&
      !Value.Check(ChildCommandErrorFrameSchema, frame)
    ) {
      return false
    }
    const child = frame as DecodedChild
    return (
      child.agent_id === turn.agentId &&
      child.turn === turn.turn &&
      (child.type === 'steer_ack' || child.type === 'command_error' ? child.command_id === 'steer' : child.command_id === 'initial')
    )
  }
  const answerSteer = (session: Session, turn: Turn, response: SteeringAck | CommandError): Effect.Effect<void> =>
    Ref.getAndSet(turn.steerResponse, undefined).pipe(
      Effect.flatMap((waiting) =>
        waiting === undefined
          ? settle(
              session,
              turn,
              outcome(turn.taskName, 'failed', 'protocol_error', 'Worker sent an unexpected steering acknowledgement.', turn.turn),
              'protocol_error'
            )
          : Ref.set(turn.followUp, response.accepted ? 'used' : 'available').pipe(Effect.andThen(Deferred.succeed(waiting, response)))
      ),
      Effect.asVoid
    )
  const settleFrame = (session: Session, turn: Turn, frame: unknown): Effect.Effect<void> => {
    if (!valid(turn, frame)) {
      return settle(
        session,
        turn,
        outcome(turn.taskName, 'failed', 'protocol_error', 'Worker sent an invalid lifecycle frame.', turn.turn),
        'protocol_error'
      )
    }
    if (Value.Check(ChildProgressFrameSchema, frame)) {
      return touch(turn)
    }
    if (Value.Check(ChildSteerAckFrameSchema, frame)) {
      return touch(turn).pipe(
        Effect.andThen(
          answerSteer(session, turn, {
            accepted: true,
            status: 'running',
            task_name: turn.taskName,
            turn: turn.turn,
          })
        )
      )
    }
    if (Value.Check(ChildCommandErrorFrameSchema, frame)) {
      const response =
        frame.code === 'queue_rejected'
          ? answerSteer(session, turn, {
              accepted: false,
              error: { code: 'queue_rejected', message: frame.error },
              status: 'running',
              task_name: turn.taskName,
              turn: turn.turn,
            })
          : answerSteer(session, turn, {
              accepted: false,
              error: { code: 'turn_settled', message: frame.error },
              status: frame.status,
              task_name: turn.taskName,
              turn: turn.turn,
            })
      return touch(turn).pipe(Effect.andThen(response))
    }
    if (!Value.Check(ChildResultFrameSchema, frame)) {
      return Effect.void
    }
    if (frame.status === 'completed' && oversizedInlineResult(frame)) {
      return settle(
        session,
        turn,
        outcome(turn.taskName, 'failed', 'result_too_large', 'Worker result exceeds the inline limit.', turn.turn),
        'result'
      )
    }
    if (frame.status !== 'completed') {
      return touch(turn).pipe(
        Effect.andThen(
          settle(
            session,
            turn,
            {
              error: frame.error,
              status: frame.status,
              task_name: turn.taskName,
              turn: turn.turn,
            },
            'result'
          )
        )
      )
    }
    if ('conclusion' in frame) {
      return touch(turn).pipe(
        Effect.andThen(
          settle(
            session,
            turn,
            {
              conclusion: frame.conclusion,
              status: 'completed',
              task_name: turn.taskName,
              turn: turn.turn,
            },
            'result',
            { contextTokens: frame.context_tokens }
          )
        )
      )
    }
    if (frame.conclusion_bytes > MAX_ARTIFACT_BYTES) {
      return touch(turn).pipe(
        Effect.andThen(
          settle(session, turn, outcome(turn.taskName, 'failed', 'result_too_large', 'The full result exceeds 10 MiB.', turn.turn), 'result')
        )
      )
    }
    return touch(turn).pipe(
      Effect.andThen(store.readArtifact(turn.agentId, frame.conclusion_artifact, MAX_ARTIFACT_BYTES)),
      Effect.matchEffect({
        onFailure: (error) =>
          settle(
            session,
            turn,
            outcome(
              turn.taskName,
              'failed',
              error instanceof ArtifactTooLargeError ? 'result_too_large' : 'agent_failed',
              error instanceof ArtifactTooLargeError ? 'The full result exceeds 10 MiB.' : error.message
            ),
            'result'
          ),
        onSuccess: (content) => {
          if (content.byteLength > MAX_ARTIFACT_BYTES) {
            return settle(session, turn, outcome(turn.taskName, 'failed', 'result_too_large', 'The full result exceeds 10 MiB.', turn.turn), 'result')
          }
          if (content.byteLength !== frame.conclusion_bytes) {
            return settle(
              session,
              turn,
              outcome(turn.taskName, 'failed', 'agent_failed', 'Worker artifact byte count did not match.', turn.turn),
              'result'
            )
          }
          return store.writeFullResult(turn.agentId, content).pipe(
            Effect.matchEffect({
              onFailure: (error) => settle(session, turn, outcome(turn.taskName, 'failed', 'agent_failed', error.message), 'result'),
              onSuccess: (fullResultPath) =>
                settle(
                  session,
                  turn,
                  {
                    conclusion: frame.conclusion_preview,
                    full_result_path: fullResultPath,
                    status: 'completed',
                    task_name: turn.taskName,
                    truncated: true,
                    turn: turn.turn,
                  },
                  'result',
                  { contextTokens: frame.context_tokens }
                ),
            })
          )
        },
      })
    )
  }
  const stream = (session: Session, turn: Turn, frames: ChildDecoder, pending: readonly unknown[]): Effect.Effect<void> => {
    const next = (): Effect.Effect<void> =>
      turn.child.readStdout.pipe(
        Effect.matchEffect({
          onFailure: () => settle(session, turn, outcome(turn.taskName, 'failed', 'agent_failed', 'Worker stdout failed.', turn.turn), 'stdout'),
          onSuccess: (bytes) => {
            if (bytes === undefined) {
              try {
                frames.end()
              } catch {
                return settle(
                  session,
                  turn,
                  outcome(turn.taskName, 'failed', 'protocol_error', 'Worker stdout ended with an incomplete frame.', turn.turn),
                  'eof'
                )
              }
              return settle(
                session,
                turn,
                outcome(turn.taskName, 'failed', 'agent_failed', 'Worker stdout ended without a result.', turn.turn),
                'eof'
              )
            }
            const decoded = decodeChunk(frames, bytes)
            const followUp =
              decoded.error === undefined
                ? Effect.suspend(next)
                : (() => {
                    const code = oversizedFrame(decoded.error) ? 'frame_too_large' : 'protocol_error'
                    return settle(
                      session,
                      turn,
                      outcome(
                        turn.taskName,
                        'failed',
                        code,
                        code === 'frame_too_large' ? 'Worker frame exceeds the 1 MiB limit.' : 'Worker sent malformed JSONL.',
                        turn.turn
                      ),
                      code
                    )
                  })()
            return Effect.forEach(decoded.values, (frame) => settleFrame(session, turn, frame), { discard: true }).pipe(Effect.andThen(followUp))
          },
        })
      )
    return Effect.forEach(
      pending,
      (frame) =>
        frame instanceof ProtocolError
          ? settle(
              session,
              turn,
              outcome(turn.taskName, 'failed', oversizedFrame(frame) ? 'frame_too_large' : 'protocol_error', frame.message, turn.turn),
              oversizedFrame(frame) ? 'frame_too_large' : 'protocol_error'
            )
          : settleFrame(session, turn, frame),
      { discard: true }
    ).pipe(Effect.andThen(next))
  }
  const deadline = (session: Session, turn: Turn): Effect.Effect<void> => {
    const wait = (): Effect.Effect<void> =>
      Effect.all([Clock.currentTimeMillis, Clock.monotonicTimeNanos]).pipe(
        Effect.flatMap(([wall, monotonic]) => {
          if (wall >= turn.deadlineWall || monotonic >= turn.deadlineMonotonic) {
            return settle(
              session,
              turn,
              outcome(turn.taskName, 'failed', 'turn_timeout', 'The sub-agent exceeded its deadline.', turn.turn),
              'deadline'
            )
          }
          const remaining = Number((turn.deadlineMonotonic - monotonic) / 1_000_000n)
          return Effect.sleep(`${Math.max(1, remaining)} millis`).pipe(Effect.andThen(wait))
        })
      )
    return wait()
  }
  const supervise = (session: Session, turn: Turn): Effect.Effect<void> =>
    turn.child.wait.pipe(
      Effect.andThen(Effect.race(Deferred.await(turn.deferred).pipe(Effect.ignore), Effect.sleep('1 second'))),
      Effect.andThen(
        settle(session, turn, outcome(turn.taskName, 'failed', 'agent_failed', 'The worker exited without a result.', turn.turn), 'exit')
      ),
      Effect.andThen(releaseProcess(turn).pipe(Effect.ignore)),
      Effect.andThen(releaseSlot(session, turn))
    )
  const readReady = (
    child: RunningChild,
    agentId: string,
    turn: number,
    frames: ChildDecoder,
    pending: unknown[]
  ): Effect.Effect<string, PublicRefusalError> => {
    const next = (): Effect.Effect<string, PublicRefusalError> =>
      child.readStdout.pipe(
        Effect.mapError((error) => refusal('startup_failed', error.message, error)),
        Effect.flatMap((bytes) => {
          if (bytes === undefined) {
            return Effect.fail(refusal('startup_failed', 'Worker exited before readiness.'))
          }
          let sessionPath: string | undefined
          const decoded = decodeChunk(frames, bytes)
          for (const frame of decoded.values) {
            if (sessionPath === undefined && Value.Check(ChildReadyFrameSchema, frame)) {
              if (!correlatedInitial(frame, agentId, turn)) {
                return Effect.fail(refusal('startup_failed', 'Worker sent an invalid readiness frame.'))
              }
              sessionPath = frame.session_path
              continue
            }
            if (!correlatedLifecycle(frame, agentId, turn)) {
              if (sessionPath !== undefined) {
                pending.push(frame)
                continue
              }
              return Effect.fail(refusal('startup_failed', 'Worker sent an invalid readiness frame.'))
            }
            if (!validBeforeReady(frame, sessionPath)) {
              return Effect.fail(refusal('startup_failed', 'Worker sent an invalid readiness frame.'))
            }
            pending.push(frame)
          }
          if (sessionPath !== undefined && decoded.error instanceof ProtocolError) {
            pending.push(decoded.error)
            return Effect.succeed(sessionPath)
          }
          if (decoded.error !== undefined) {
            return oversizedFrame(decoded.error)
              ? Effect.fail(refusal('frame_too_large', 'Worker frame exceeds the 1 MiB limit.'))
              : Effect.fail(refusal('startup_failed', 'Worker sent an invalid readiness frame.'))
          }
          return sessionPath === undefined ? next() : Effect.succeed(sessionPath)
        })
      )
    return next()
  }
  const hasLiveOwner = (run: { readonly lease?: LaunchLease; readonly record?: SubagentRecord }): Effect.Effect<boolean, ProcessError> => {
    const owners = [run.lease?.owner, run.record?.status === 'running' ? run.record.owner : undefined].filter(
      (identity): identity is ProcessIdentity => identity !== undefined
    )
    return owners.length === 0
      ? Effect.succeed(true)
      : Effect.all(owners.map((owner) => process.isIdentityAlive(owner))).pipe(Effect.map((alive) => alive.some((value) => value)))
  }
  const reconcile = (
    agentId: string,
    run: { readonly lease?: LaunchLease; readonly record?: SubagentRecord }
  ): Effect.Effect<void, StoreError | ProcessError> =>
    hasLiveOwner(run).pipe(
      Effect.flatMap((liveOwner) =>
        liveOwner
          ? Effect.void
          : // oxlint-disable-next-line eslint/complexity -- reconciliation keeps every ownership outcome in one atomic recovery path
            Effect.gen(function* () {
              const identities = [
                ...(run.lease === undefined ? [] : [run.lease.identity]),
                ...(run.record?.status === 'running' ? [run.record.identity] : []),
              ].filter(
                (identity, index, all) => all.findIndex((other) => other.pid === identity.pid && other.birthMarker === identity.birthMarker) === index
              )
              const mismatch = identities.length > 1
              const stopped: TerminationResult[] = []
              for (const identity of identities) {
                stopped.push(yield* process.terminateVerified(identity))
              }
              if (mismatch || stopped.some((result) => result === 'exited' || result === 'mismatch' || result === 'signalled')) {
                yield* run.lease?.preserveRecord === true && run.record?.status !== 'running' ? store.removeLease(agentId) : store.delete(agentId)
                return
              }
              const [identity] = identities
              const source = run.record ?? run.lease
              if (identity !== undefined && source !== undefined) {
                yield* retainCleanup(agentId, {
                  identity,
                  preserveRecord: run.lease?.preserveRecord,
                  profile: run.record?.status === 'running' ? run.record.profile : undefined,
                  session: source.session,
                  taskName: source.taskName,
                })
              }
              return
            })
      )
    )
  const initialize = (): Effect.Effect<void, OrchestrationError> =>
    Effect.suspend(() => {
      if (initialized !== undefined) {
        return Deferred.await(initialized)
      }
      const gate = Deferred.makeUnsafe<void, OrchestrationError>()
      initialized = gate
      return Effect.gen(function* () {
        yield* store.initialize
        ownerIdentity = yield* process.currentIdentity.pipe(Effect.orElseSucceed(() => undefined))
        const [leases, records] = yield* Effect.all([store.listLeases, store.listRecords])
        const runs = new Map<string, { readonly lease?: LaunchLease; readonly record?: SubagentRecord }>()
        for (const { agentId, lease } of leases) {
          runs.set(agentId, { ...runs.get(agentId), lease })
        }
        for (const { agentId, record } of records) {
          runs.set(agentId, { ...runs.get(agentId), record })
        }
        for (const [agentId, run] of runs) {
          yield* reconcile(agentId, run)
        }
        yield* Clock.currentTimeMillis.pipe(Effect.flatMap((now) => store.prune(now)))
      }).pipe(
        Effect.mapError((error) => failure('initialize', 'host_failure', error)),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (exit._tag !== 'Success' && initialized === gate) {
              initialized = undefined
            }
          }).pipe(Effect.andThen(Deferred.done(gate, exit)))
        )
      )
    })
  const start = (
    session: Session,
    key: string,
    admission: AdmissionSnapshot,
    request: SpawnAgentInput,
    options: {
      readonly reservation: Reservation
      readonly resume?: {
        readonly sessionPath: string
        readonly turns: readonly AgentTurnRecord[]
      }
    }
  ): Effect.Effect<AgentResult | RunningAcceptance, OrchestrationError> => {
    const { reservation, resume } = options
    let admitted: Turn | undefined
    let committed = false
    const started = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const expectedTurn = resume === undefined ? 1 : resume.turns.length + 1
        const [dispatchWall, dispatchMonotonic] = yield* Effect.all([Clock.currentTimeMillis, Clock.monotonicTimeNanos])
        const deadlineWall = dispatchWall + TURN_DEADLINE_MILLIS
        const deadlineMonotonic = dispatchMonotonic + BigInt(TURN_DEADLINE_MILLIS) * 1_000_000n
        const task = yield* Effect.try({
          catch: () => refusal('frame_too_large', 'Worker frame exceeds the 1 MiB limit.'),
          try: () =>
            encodeFrame({
              agent_id: reservation.agentId,
              command_id: 'initial',
              message: request.message,
              turn: expectedTurn,
              type: 'task' as const,
            }),
        })
        const logPath = yield* store
          .createLog(reservation.agentId, expectedTurn)
          .pipe(Effect.mapError((error) => refusal('startup_failed', error.message)))
        const allocated = Effect.gen(function* () {
          const descriptor =
            resume === undefined
              ? yield* store.createSession(reservation.agentId).pipe(Effect.mapError((error) => refusal('startup_failed', error.message)))
              : {
                  runDirectory: bunPath.dirname(resume.sessionPath),
                  sessionPath: resume.sessionPath,
                }
          const config = yield* Effect.try({
            catch: () => refusal('frame_too_large', 'Worker frame exceeds the 1 MiB limit.'),
            try: () =>
              encodeFrame({
                agent_id: reservation.agentId,
                run_dir: descriptor.runDirectory,
                session:
                  resume === undefined
                    ? {
                        expected_dir: descriptor.runDirectory,
                        mode: 'create' as const,
                      }
                    : {
                        canonical_path: resume.sessionPath,
                        mode: 'open' as const,
                      },
                turn: expectedTurn,
                type: 'config' as const,
                version: 1 as const,
                worker: deriveWorkerConfig(reservation.profile, admission),
              }),
          })
          return { config, descriptor }
        }).pipe(
          Effect.onError(() =>
            (resume === undefined ? store.delete(reservation.agentId) : store.removeLog(reservation.agentId, logPath)).pipe(Effect.ignore)
          )
        )
        const { config, descriptor } = yield* allocated
        const child = yield* process
          .spawn({
            args: [WORKER_ENTRYPOINT],
            command: Bun.argv[0],
            cwd: admission.cwd,
            environment: deriveChildEnvironment(reservation.profile, admission, reservation.agentId, () => Bun.randomUUIDv7()),
            stderrPath: logPath,
          })
          .pipe(
            Effect.mapError((error) => refusal('startup_failed', error.message)),
            Effect.onError(() =>
              (resume === undefined ? store.delete(reservation.agentId) : store.removeLog(reservation.agentId, logPath)).pipe(Effect.ignore)
            )
          )
        const provisional: Provisional = {
          ...reservation,
          child,
          deleteArtifacts: resume === undefined,
          generation: session.generation,
          logPath,
          resourceReleased: Ref.makeUnsafe(false),
          session: key,
        }
        const cleanupUnregistered = (): Effect.Effect<void> =>
          process.terminateVerified(child.identity).pipe(
            Effect.ignore,
            Effect.andThen(child.isAlive.pipe(Effect.orElseSucceed(() => true))),
            Effect.flatMap((alive) =>
              alive
                ? handoff(reservation.agentId, {
                    child,
                    identity: child.identity,
                    logPath,
                    preserveRecord: resume !== undefined,
                    profile: reservation.profile,
                    release: releaseProvisional(provisional),
                    session: key,
                    taskName: reservation.taskName,
                  })
                : releaseProvisional(provisional).pipe(
                    Effect.ignore,
                    Effect.andThen(
                      (resume === undefined ? store.delete(reservation.agentId) : store.removeLease(reservation.agentId, child.identity)).pipe(
                        Effect.ignore
                      )
                    ),
                    Effect.andThen(store.removeLog(reservation.agentId, logPath).pipe(Effect.ignore))
                  )
            )
          )
        yield* registerProvisional(session, provisional).pipe(Effect.onError(cleanupUnregistered))
        const cleanupLaunch = (): Effect.Effect<boolean> =>
          Ref.get(cleanup).pipe(
            Effect.flatMap((items) =>
              items.has(cleanupKey(reservation.agentId, child.identity))
                ? Effect.succeed(true)
                : removeProvisional(session, reservation.slotId).pipe(
                    Effect.andThen(process.terminateVerified(child.identity)),
                    Effect.ignore,
                    Effect.andThen(child.isAlive.pipe(Effect.orElseSucceed(() => true))),
                    Effect.flatMap((alive) =>
                      alive
                        ? handoff(reservation.agentId, {
                            child,
                            identity: child.identity,
                            logPath,
                            preserveRecord: resume !== undefined,
                            profile: reservation.profile,
                            release: releaseProvisional(provisional),
                            session: key,
                            taskName: reservation.taskName,
                          }).pipe(Effect.as(true))
                        : releaseProvisional(provisional).pipe(
                            Effect.ignore,
                            Effect.andThen(
                              (resume === undefined
                                ? store.delete(reservation.agentId)
                                : store.removeLease(reservation.agentId, child.identity)
                              ).pipe(Effect.ignore)
                            ),
                            Effect.andThen(store.removeLog(reservation.agentId, logPath).pipe(Effect.ignore)),
                            Effect.as(false)
                          )
                    )
                  )
            )
          )
        const launched = Effect.gen(function* () {
          yield* store.createLease(reservation.agentId, {
            identity: child.identity,
            owner: ownerIdentity,
            preserveRecord: resume !== undefined,
            session: key,
            taskName: request.task_name,
          })
          yield* child.write(config)
          yield* child.write(task)
          const childFrames = decoder()
          const pendingFrames: unknown[] = []
          const path = yield* Effect.timeout(readReady(child, reservation.agentId, expectedTurn, childFrames, pendingFrames), '30 seconds').pipe(
            Effect.flatMap((value) =>
              value === undefined ? Effect.fail(refusal('startup_timeout', 'Worker did not become ready in time.')) : Effect.succeed(value)
            )
          )
          const checked = yield* validateWorkerSessionPath(
            resume === undefined
              ? { expectedDir: descriptor.runDirectory, mode: 'create', path }
              : {
                  expectedCanonicalPath: resume.sessionPath,
                  expectedDir: descriptor.runDirectory,
                  mode: 'open',
                  path,
                }
          ).pipe(Effect.mapError((error) => refusal('startup_failed', error.message)))
          const turn: Turn = {
            ...reservation,
            activity: Ref.makeUnsafe(0),
            background: request.run_in_background === true,
            child,
            deadlineMonotonic,
            deadlineWall,
            deferred: Deferred.makeUnsafe<AgentResult, PublicRefusalError>(),
            delivery: 'unclaimed',
            followUp: Ref.makeUnsafe<'available' | 'pending' | 'used'>(resume === undefined ? 'available' : 'used'),
            generation: session.generation,
            logPath,
            released: false,
            resourceReleased: Ref.makeUnsafe(false),
            sessionKey: key,
            sessionPath: checked.canonicalPath,
            settledAt: undefined,
            state: 'running',
            steerResponse: Ref.makeUnsafe<Deferred.Deferred<SteeringAck | CommandError> | undefined>(undefined),
            turn: expectedTurn,
            turns: resume?.turns ?? [],
            warningEnqueued: false,
          }
          yield* locked(
            session,
            Effect.uninterruptible(
              Effect.gen(function* () {
                const state = yield* snapshot(session)
                if (state.phase !== 'open' || session.generation !== turn.generation || !state.provisional.has(turn.slotId)) {
                  return yield* unavailable()
                }
                const running: SubagentRecord = {
                  identity: child.identity,
                  logPath,
                  owner: ownerIdentity,
                  profile: reservation.profile,
                  session: key,
                  sessionPath: checked.canonicalPath,
                  status: 'running',
                  taskName: request.task_name,
                  turns: turn.turns,
                }
                yield* store.replaceRecord(reservation.agentId, running).pipe(Effect.mapError((error) => refusal('startup_failed', error.message)))
                const agents = copy(state.agents)
                agents.set(request.task_name, turn)
                const provisionals = copy(state.provisional)
                provisionals.delete(reservation.slotId)
                const starting = copy(state.starting)
                starting.delete(reservation.slotId)
                yield* Ref.set(session.state, {
                  ...state,
                  agents,
                  provisional: provisionals,
                  starting,
                })
                committed = true
                admitted = turn
                yield* Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) =>
                    activityProjection.publishReady({
                      agentId: turn.agentId,
                      color: activityColor(turn.profile.key),
                      lastActivityAt: now,
                      name: turn.taskName,
                      profile: turn.profile.key,
                      sessionId: turn.sessionKey,
                      state: 'running',
                    })
                  )
                )
                yield* Effect.forkIn(stream(session, turn, childFrames, pendingFrames), session.scope)
                yield* Effect.forkIn(supervise(session, turn), session.scope)
                yield* Effect.forkIn(
                  inactivity(turn, (inactive) => warnInactive(session, inactive)),
                  session.scope
                )
                yield* Effect.forkIn(deadline(session, turn), session.scope)
                return turn
              })
            )
          )
          return {
            acceptance: {
              profile: reservation.profile.key,
              status: 'running' as const,
              task_name: request.task_name,
              turn: expectedTurn,
            },
            turn,
          }
        }).pipe(
          Effect.mapError((error) =>
            Schema.is(PublicRefusalError)(error) ? error : refusal('startup_failed', error instanceof Error ? error.message : String(error), error)
          )
        )
        const accepted = yield* Effect.onExit(restore(launched), (exit) =>
          exit._tag === 'Success' || committed
            ? Effect.void
            : cleanupLaunch().pipe(Effect.andThen(clearProvisionalStarting(session, reservation.slotId)))
        )
        if (request.run_in_background === true) {
          return accepted.acceptance
        }
        const delivered = yield* Ref.make(false)
        return yield* restore(
          Deferred.await(accepted.turn.deferred).pipe(
            Effect.tap(() => Ref.set(delivered, true)),
            Effect.ensuring(
              Effect.uninterruptible(
                Ref.get(delivered).pipe(
                  Effect.flatMap((didDeliver) => (didDeliver ? Effect.void : promoteCancelledForeground(session, accepted.turn)))
                )
              )
            )
          )
        )
      })
    )
    const releasing = started.pipe(Effect.onError(() => clearStarting(session, reservation.slotId)))
    return request.run_in_background === true
      ? releasing
      : releasing.pipe(Effect.onInterrupt(() => (admitted === undefined ? Effect.void : promoteCancelledForeground(session, admitted))))
  }
  const api: SubagentOrchestratorApi = {
    closeSession: (key) =>
      lifecycle.withPermits(1)(
        Effect.uninterruptible(
          active(key).pipe(
            Effect.flatMap((session) =>
              locked(
                session,
                Effect.gen(function* () {
                  const state = yield* snapshot(session)
                  if (state.phase !== 'open') {
                    return yield* unavailable()
                  }
                  yield* Ref.set(session.state, {
                    ...state,
                    phase: 'closing' as const,
                    provisional: new Map(),
                  })
                  return {
                    provisional: [...state.provisional.values()],
                    turns: [...state.agents.values()].filter((turn) => !turn.released),
                  }
                })
              ).pipe(
                Effect.flatMap(({ provisional, turns }) =>
                  Effect.forEach(
                    [...provisional, ...turns],
                    (item) =>
                      'deleteArtifacts' in item
                        ? process.terminateVerified(item.child.identity).pipe(
                            Effect.ignore,
                            Effect.andThen(item.child.isAlive.pipe(Effect.orElseSucceed(() => true))),
                            Effect.flatMap((alive) =>
                              alive
                                ? handoff(item.agentId, {
                                    child: item.child,
                                    identity: item.child.identity,
                                    logPath: item.logPath,
                                    preserveRecord: !item.deleteArtifacts,
                                    profile: item.profile,
                                    release: releaseProvisional(item),
                                    session: key,
                                    taskName: item.taskName,
                                  })
                                : releaseProvisional(item).pipe(
                                    Effect.ignore,
                                    Effect.andThen(
                                      (item.deleteArtifacts ? store.delete(item.agentId) : store.removeLease(item.agentId, item.child.identity)).pipe(
                                        Effect.ignore
                                      )
                                    ),
                                    Effect.andThen(store.removeLog(item.agentId, item.logPath).pipe(Effect.ignore)),
                                    Effect.andThen(clearProvisionalStarting(session, item.slotId))
                                  )
                            )
                          )
                        : Effect.succeed(item),
                    { concurrency: 'unbounded' }
                  ).pipe(
                    Effect.andThen(
                      Effect.forEach(
                        turns,
                        (turn) =>
                          settle(
                            session,
                            turn,
                            outcome(turn.taskName, 'interrupted', 'interrupted', 'The sub-agent was interrupted.', turn.turn),
                            'close'
                          ).pipe(
                            Effect.flatMap((claimed) =>
                              claimed
                                ? stop(turn, 'close').pipe(
                                    Effect.flatMap(({ errors, stopped }) => {
                                      const cleanupEffect =
                                        stopped === 'stillAlive' || stopped === 'unverifiable'
                                          ? handoffTurn(session, key, turn)
                                          : Effect.all([
                                              stopped === 'mismatch' && turn.turn === 1 ? store.delete(turn.agentId) : Effect.void,
                                              releaseProcess(turn),
                                              releaseSlot(session, turn),
                                            ]).pipe(Effect.asVoid)
                                      return cleanupEffect.pipe(
                                        Effect.flatMap(() =>
                                          errors.length === 0
                                            ? Effect.void
                                            : Effect.fail(failure('close_session', 'cleanup_incomplete', errors.map(String).join('; ')))
                                        )
                                      )
                                    })
                                  )
                                : Effect.void
                            ),
                            Effect.exit
                          ),
                        { concurrency: 'unbounded' }
                      )
                    )
                  )
                ),
                Effect.flatMap((attempts) =>
                  activityProjection.closeSession(key).pipe(
                    Effect.andThen(Scope.close(session.scope, Exit.void)),
                    Effect.exit,
                    Effect.andThen((scope) =>
                      locked(
                        session,
                        snapshot(session).pipe(
                          Effect.flatMap((state) =>
                            Ref.set(session.state, {
                              ...state,
                              phase: 'closed' as const,
                            })
                          )
                        )
                      ).pipe(
                        Effect.exit,
                        Effect.flatMap((closed) => {
                          if (sessions.get(key) === session) {
                            sessions.delete(key)
                          }
                          const failed = [...attempts, scope, closed].filter((cleanupAttempt) => cleanupAttempt._tag === 'Failure')
                          return failed.length === 0
                            ? Effect.void
                            : Effect.fail(
                                failure('close_session', 'cleanup_incomplete', failed.map((cleanupAttempt) => cleanupAttempt.toString()).join('; '))
                              )
                        })
                      )
                    )
                  )
                )
              )
            ),
            Effect.mapError((error) => (Schema.is(LifecycleError)(error) ? error : failure('close_session', 'session_not_open', error)))
          )
        )
      ),
    hasLiveChildren: (key) => {
      const session = sessions.get(key)
      if (session === undefined || Ref.getUnsafe(session.state).phase !== 'open') {
        return false
      }
      const state = Ref.getUnsafe(session.state)
      return state.starting.size > 0 || [...state.agents.values()].some((turn) => turn.state === 'running' || turn.state === 'settling')
    },
    initialize: initialize(),
    interrupt: (key, target): Effect.Effect<AgentResult | SettledInterruptNoop, OrchestrationError> =>
      Effect.uninterruptibleMask((restore) =>
        active(key).pipe(
          Effect.flatMap((session) =>
            locked(
              session,
              snapshot(session).pipe(
                Effect.flatMap((state) => {
                  if ([...state.starting.values()].some((reservation) => reservation.taskName === target)) {
                    return Effect.fail(refusal('not_ready', `Agent "${target}" is still starting.`))
                  }
                  const turn = state.agents.get(target)
                  if (turn === undefined) {
                    return Effect.fail(refusal('unknown_agent', `Unknown agent "${target}".`))
                  }
                  const notices = state.notices.filter((notice) => !(notice.kind === 'settlement' && notice.taskName === target))
                  const removedNotices = state.notices.filter((notice) => notice.kind === 'settlement' && notice.taskName === target)
                  const agents = copy(state.agents)
                  const claimed = {
                    ...turn,
                    delivery: { claim: ++deliveryClaims, kind: 'wait' as const, previous: turn.delivery, state: 'active' as const },
                  }
                  agents.set(target, claimed)
                  if (turn.result !== undefined) {
                    return Ref.set(session.state, {
                      ...state,
                      agents,
                      notices,
                    }).pipe(
                      Effect.as<InterruptPlan>({
                        notices: removedNotices,
                        turn: claimed,
                        value: {
                          interrupted: false,
                          status: turn.result.status,
                          task_name: target,
                          turn: turn.turn,
                        },
                      })
                    )
                  }
                  return Ref.set(session.state, {
                    ...state,
                    agents,
                    notices,
                  }).pipe(Effect.as<InterruptPlan>({ notices: removedNotices, turn: claimed }))
                })
              )
            ).pipe(
              Effect.flatMap(({ notices, turn, value }) =>
                Ref.make(false).pipe(
                  Effect.flatMap((completed) =>
                    (value === undefined
                      ? settle(
                          session,
                          turn,
                          outcome(target, 'interrupted', 'interrupted', 'The sub-agent was interrupted.', turn.turn),
                          'interrupt',
                          { stopAfter: false }
                        ).pipe(
                          Effect.flatMap((claimed) =>
                            claimed
                              ? stop(turn, 'interrupt').pipe(Effect.tap(({ stopped }) => completeStop(session, key, turn, stopped)))
                              : Effect.void
                          ),
                          Effect.andThen(restore(Deferred.await(turn.deferred))),
                          Effect.map((result): AgentResult | SettledInterruptNoop => result)
                        )
                      : restore(Effect.yieldNow.pipe(Effect.as<AgentResult | SettledInterruptNoop>(value)))
                    ).pipe(
                      Effect.tap(() => commitWaitClaims([turn]).pipe(Effect.andThen(Ref.set(completed, true)))),
                      Effect.ensuring(
                        Ref.get(completed).pipe(
                          Effect.flatMap((didComplete) => (didComplete ? Effect.void : restoreWaitClaims(session, [turn], notices)))
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      ),
    interruptAll: (key) =>
      active(key).pipe(
        Effect.flatMap((session) =>
          snapshot(session).pipe(
            Effect.flatMap((state) =>
              Effect.forEach(
                [...state.provisional.values()],
                (provisional) =>
                  removeProvisional(session, provisional.slotId).pipe(
                    Effect.andThen(process.terminateVerified(provisional.child.identity)),
                    Effect.ignore,
                    Effect.andThen(provisional.child.isAlive.pipe(Effect.orElseSucceed(() => true))),
                    Effect.flatMap((alive) =>
                      alive
                        ? handoff(provisional.agentId, {
                            child: provisional.child,
                            identity: provisional.child.identity,
                            logPath: provisional.logPath,
                            preserveRecord: !provisional.deleteArtifacts,
                            profile: provisional.profile,
                            release: releaseProvisional(provisional),
                            session: key,
                            taskName: provisional.taskName,
                          })
                        : releaseProvisional(provisional).pipe(
                            Effect.ignore,
                            Effect.andThen(
                              (provisional.deleteArtifacts
                                ? store.delete(provisional.agentId)
                                : store.removeLease(provisional.agentId, provisional.child.identity)
                              ).pipe(Effect.ignore)
                            ),
                            Effect.andThen(store.removeLog(provisional.agentId, provisional.logPath).pipe(Effect.ignore)),
                            Effect.andThen(clearProvisionalStarting(session, provisional.slotId))
                          )
                    )
                  ),
                { concurrency: 'unbounded', discard: true }
              ).pipe(
                Effect.andThen(
                  Effect.forEach(
                    [...state.agents.values()],
                    (turn) =>
                      turn.result === undefined
                        ? settle(
                            session,
                            turn,
                            outcome(turn.taskName, 'interrupted', 'interrupted', 'The sub-agent was interrupted.', turn.turn),
                            'interrupt_all'
                          ).pipe(
                            Effect.andThen(
                              locked(
                                session,
                                snapshot(session).pipe(
                                  Effect.flatMap((latest) =>
                                    Ref.set(session.state, {
                                      ...latest,
                                      notices: latest.notices.filter(
                                        (notice) => !(notice.kind === 'settlement' && notice.taskName === turn.taskName)
                                      ),
                                    })
                                  )
                                )
                              )
                            )
                          )
                        : Effect.void,
                    { discard: true }
                  )
                )
              )
            )
          )
        )
      ),
    list: (key) =>
      active(key).pipe(
        Effect.flatMap((session) =>
          snapshot(session).pipe(
            Effect.flatMap((state) =>
              Effect.forEach([...state.agents.values()], (turn) => {
                const { result } = turn
                if (result !== undefined) {
                  return Ref.get(turn.followUp).pipe(
                    Effect.map((allowance) => ({
                      current_turn: turn.turn,
                      follow_up_available: turn.generation === session.generation && result.status === 'completed' && allowance === 'available',
                      profile: turn.profile.key,
                      status: result.status,
                      task_name: turn.taskName,
                    }))
                  )
                }
                return store.readRecord(turn.agentId).pipe(
                  Effect.mapError((error) => refusal('agent_failed', error.message)),
                  Effect.flatMap((record) =>
                    record === undefined || record.session !== key
                      ? Effect.fail(refusal('unknown_agent', `Unknown agent "${turn.taskName}".`))
                      : Ref.get(turn.followUp).pipe(
                          Effect.map((allowance) => ({
                            current_turn: turn.turn,
                            follow_up_available:
                              turn.generation === session.generation &&
                              (record.status === 'running' || record.status === 'completed') &&
                              allowance === 'available',
                            profile: record.profile.key,
                            status: record.status,
                            task_name: record.taskName,
                          }))
                        )
                  )
                )
              })
            )
          )
        )
      ),
    openSession: (key) =>
      lifecycle.withPermits(1)(
        initialize().pipe(
          Effect.andThen(
            Effect.sync(() => {
              const old = sessions.get(key)
              if (old === undefined || Ref.getUnsafe(old.state).phase === 'closed') {
                sessions.set(key, {
                  generation: ++generations,
                  key,
                  mutex: Semaphore.makeUnsafe(1),
                  scope: Scope.makeUnsafe(),
                  state: Ref.makeUnsafe<Snapshot>({
                    agents: new Map(),
                    notices: [],
                    phase: 'open',
                    provisional: new Map(),
                    slots: new Map(),
                    starting: new Map(),
                  }),
                })
              }
              const session = sessions.get(key)
              return {
                created: old === undefined || Ref.getUnsafe(old.state).phase === 'closed',
                session,
              }
            }).pipe(
              Effect.flatMap(({ created, session }) =>
                session === undefined
                  ? Effect.die('Session creation failed.')
                  : store.listRecords.pipe(
                      Effect.mapError((error) => failure('open_session', 'host_failure', error)),
                      Effect.flatMap((records) =>
                        locked(
                          session,
                          Effect.gen(function* () {
                            const state = yield* snapshot(session)
                            const agents = copy(state.agents)
                            for (const { agentId, record } of records) {
                              if (record.session !== key || record.status === 'running' || agents.has(record.taskName)) {
                                continue
                              }
                              const result = record.turns.at(-1)?.result
                              if (result === undefined) {
                                continue
                              }
                              const deferred = Deferred.makeUnsafe<AgentResult, PublicRefusalError>()
                              yield* Deferred.succeed(deferred, result)
                              agents.set(record.taskName, {
                                activity: Ref.makeUnsafe(0),
                                agentId,
                                background: false,
                                child: {
                                  closeInput: Effect.void,
                                  identity: { birthMarker: 'hydrated', pid: 1 },
                                  isAlive: Effect.succeed(false),
                                  readStdout: Effect.never,
                                  release: Effect.void,
                                  wait: Effect.never,
                                  write: () => Effect.void,
                                },
                                deadlineMonotonic: 0n,
                                deadlineWall: 0,
                                deferred,
                                delivery: { claim: 0, kind: 'wait', previous: 'unclaimed', state: 'committed' },
                                followUp: Ref.makeUnsafe<'available' | 'pending' | 'used'>('used'),
                                generation: session.generation,
                                logPath: record.logPath,
                                profile: record.profile,
                                released: true,
                                resourceReleased: Ref.makeUnsafe(true),
                                result,
                                sessionKey: key,
                                sessionPath: record.sessionPath,
                                settledAt: record.settledAt,
                                slotId: `hydrated-${agentId}`,
                                state: 'settled',
                                steerResponse: Ref.makeUnsafe<Deferred.Deferred<SteeringAck | CommandError> | undefined>(undefined),
                                taskName: record.taskName,
                                turn: result.turn,
                                turns: record.turns,
                                warningEnqueued: false,
                              })
                            }
                            yield* Ref.set(session.state, { ...state, agents })
                          })
                        )
                      ),
                      Effect.onExit((exit) =>
                        exit._tag === 'Success' || !created || sessions.get(key) !== session
                          ? Effect.void
                          : Effect.uninterruptible(
                              Scope.close(session.scope, Exit.void).pipe(
                                Effect.andThen(
                                  Effect.sync(() => {
                                    if (sessions.get(key) === session) {
                                      sessions.delete(key)
                                    }
                                  })
                                )
                              )
                            )
                      ),
                      Effect.as(session.generation)
                    )
              )
            )
          ),
          Effect.mapError((error) => (Schema.is(LifecycleError)(error) ? error : failure('open_session', 'host_failure', error)))
        )
      ),
    read: (key, target) =>
      active(key).pipe(
        Effect.flatMap((session) =>
          findTurn(session, target).pipe(
            Effect.flatMap((turn) => {
              if (turn === undefined) {
                return Effect.fail(refusal('unknown_agent', `Unknown agent "${target}".`))
              }
              if (turn.result !== undefined) {
                return Effect.succeed({
                  profile: turn.profile.key,
                  status: turn.result.status,
                  task_name: turn.taskName,
                  turns: turn.turns.map((entry) => entry.result),
                })
              }
              return store.readRecord(turn.agentId).pipe(
                Effect.mapError((error) => refusal('agent_failed', error.message)),
                Effect.flatMap((record) =>
                  record === undefined || record.session !== key || record.taskName !== target
                    ? Effect.fail(refusal('unknown_agent', `Unknown agent "${target}".`))
                    : Effect.succeed({
                        profile: record.profile.key,
                        status: record.status,
                        task_name: record.taskName,
                        turns: record.turns.map((entry) => entry.result),
                      })
                )
              )
            })
          )
        )
      ),
    send: (key, _admission, target, message): Effect.Effect<SteeringAck | CommandError | AgentResult, OrchestrationError> =>
      active(key).pipe(
        Effect.flatMap((session) =>
          findTurn(session, target).pipe(
            Effect.flatMap((turn) => {
              if (turn === undefined) {
                return Effect.fail(refusal('unknown_agent', `Unknown agent "${target}".`))
              }
              if (turn.result !== undefined) {
                if (turn.result.status !== 'completed') {
                  return Effect.fail(refusal('not_resumable', 'Only completed agents can be resumed.'))
                }
                return resolver.resolve(turn.profile.key, _admission).pipe(
                  Effect.flatMap((resolved) => {
                    if (!resolved.ok) {
                      return Effect.fail(refusal(resolved.error.code, resolved.error.message))
                    }
                    return store.readRecord(turn.agentId).pipe(
                      Effect.mapError((error) => refusal('context_limit', error.message)),
                      Effect.flatMap((record) => {
                        const contextTokens = record?.status === 'running' ? undefined : record?.contextTokens
                        const projected =
                          contextTokens === undefined
                            ? undefined
                            : contextTokens + new TextEncoder().encode(message).byteLength + FOLLOW_UP_OUTPUT_RESERVE_TOKENS
                        return projected === undefined || projected >= resolved.profile.contextCeiling
                          ? Effect.fail(refusal('context_limit', 'The follow-up would reach the context limit.'))
                          : locked(
                              session,
                              Effect.gen(function* () {
                                if ((yield* Ref.get(turn.followUp)) !== 'available') {
                                  return yield* refusal('follow_up_used', 'The follow-up allowance has already been used.')
                                }
                                const state = yield* snapshot(session)
                                const retained = [...(yield* Ref.get(cleanup)).values()].filter((item) => item.session === session.key)
                                const reservations = [
                                  ...state.slots.values(),
                                  ...retained.flatMap((item) => (item.profile === undefined ? [] : [{ ...item, profile: item.profile }])),
                                ]
                                if (
                                  state.agents.get(target)?.generation !== turn.generation ||
                                  state.slots.size + retained.length >= 3 ||
                                  (resolved.profile.key === 'implementer' && reservations.some((item) => item.profile.key === 'implementer'))
                                ) {
                                  return yield* refusal('capacity_exceeded', 'Worker capacity is exhausted.')
                                }
                                const reservation: Reservation = {
                                  agentId: turn.agentId,
                                  profile: resolved.profile,
                                  slotId: `slot-${++slotIdentifiers}`,
                                  taskName: target,
                                }
                                yield* Ref.set(turn.followUp, 'pending')
                                yield* Ref.set(session.state, {
                                  ...state,
                                  slots: new Map(state.slots).set(reservation.slotId, reservation),
                                  starting: new Map(state.starting).set(reservation.slotId, reservation),
                                })
                                return reservation
                              })
                            )
                      }),
                      Effect.flatMap((reservation) =>
                        store.readRecord(turn.agentId).pipe(
                          Effect.mapError((error) => refusal('agent_failed', error.message)),
                          Effect.flatMap((record) =>
                            record === undefined || record.status !== 'completed' || record.session !== key
                              ? Effect.fail(refusal('not_resumable', 'The completed agent is no longer available.'))
                              : Effect.succeed(record)
                          ),
                          Effect.onExit((exit) => (Exit.isFailure(exit) ? clearStarting(session, reservation.slotId) : Effect.void)),
                          Effect.flatMap((record) =>
                            start(
                              session,
                              key,
                              _admission,
                              {
                                agent_type: resolved.profile.key,
                                message,
                                run_in_background: false,
                                task_name: target,
                              },
                              {
                                reservation,
                                resume: {
                                  sessionPath: record.sessionPath,
                                  turns: record.turns,
                                },
                              }
                            ).pipe(
                              Effect.flatMap((result) =>
                                result.status === 'running'
                                  ? Effect.die('Foreground resume cannot return a running acceptance.')
                                  : Effect.succeed(result)
                              )
                            )
                          )
                        )
                      ),
                      Effect.onError(() => Ref.set(turn.followUp, 'available'))
                    )
                  }),
                  Effect.map((result): SteeringAck | CommandError | AgentResult => result)
                )
              }
              const reserve = locked(
                session,
                Effect.gen(function* () {
                  const current = (yield* snapshot(session)).agents.get(target)
                  if (current !== turn || current.state !== 'running') {
                    return yield* refusal('follow_up_used', 'The follow-up allowance has already been used.')
                  }
                  const waiting = yield* Deferred.make<SteeringAck | CommandError>()
                  const reserved = yield* Ref.modify(turn.followUp, (allowance) =>
                    allowance === 'available' ? ([true, 'pending'] as const) : ([false, allowance] as const)
                  )
                  if (!reserved) {
                    return yield* refusal('follow_up_used', 'The follow-up allowance has already been used.')
                  }
                  yield* Ref.set(turn.steerResponse, waiting)
                  return waiting
                })
              )
              let frame: string
              try {
                frame = encodeFrame({
                  agent_id: turn.agentId,
                  command_id: 'steer',
                  message,
                  turn: turn.turn,
                  type: 'steer',
                })
              } catch {
                return Effect.fail(refusal('frame_too_large', 'Worker frame exceeds the 1 MiB limit.'))
              }
              return reserve.pipe(
                Effect.flatMap((waiting) =>
                  turn.child.write(frame).pipe(
                    Effect.catch((error) =>
                      Ref.set(turn.steerResponse, undefined).pipe(
                        Effect.andThen(Ref.set(turn.followUp, 'available')),
                        Effect.andThen(Effect.fail(refusal('agent_failed', error.message)))
                      )
                    ),
                    Effect.andThen(
                      Effect.race(
                        Deferred.await(waiting),
                        Deferred.await(turn.deferred).pipe(
                          Effect.map((result): CommandError | AgentResult =>
                            result.status === 'failed'
                              ? result
                              : {
                                  accepted: false,
                                  error: {
                                    code: 'turn_settled',
                                    message: 'The turn settled before steering was accepted.',
                                  },
                                  status: result.status,
                                  task_name: target,
                                  turn: turn.turn,
                                }
                          )
                        )
                      )
                    )
                  )
                )
              )
            })
          )
        )
      ),
    spawn: (key, admission, request) =>
      initialize().pipe(
        Effect.andThen(active(key)),
        Effect.flatMap((session) =>
          resolver.resolve(request.agent_type, admission).pipe(
            Effect.flatMap((resolved) => {
              if (!resolved.ok) {
                return Effect.fail(refusal(resolved.error.code, resolved.error.message))
              }
              return locked(
                session,
                Effect.gen(function* () {
                  const state = yield* snapshot(session)
                  if (state.phase !== 'open') {
                    return yield* unavailable()
                  }
                  const retained = [...(yield* Ref.get(cleanup)).values()].filter((item) => item.session === key)
                  if (
                    state.agents.has(request.task_name) ||
                    [...state.starting.values()].some((reservation) => reservation.taskName === request.task_name)
                  ) {
                    return yield* refusal('duplicate_task_name', `Task name "${request.task_name}" is already in use.`)
                  }
                  const reservations = [
                    ...state.slots.values(),
                    ...retained.flatMap((item) => (item.profile === undefined ? [] : [{ ...item, profile: item.profile }])),
                  ]
                  if (
                    state.slots.size + retained.length >= 3 ||
                    (resolved.profile.key === 'implementer' && reservations.some((item) => item.profile.key === 'implementer'))
                  ) {
                    return yield* refusal('capacity_exceeded', 'Worker capacity is exhausted.')
                  }
                  const agentId = `agent-${Bun.randomUUIDv7()}`
                  const reservation: Reservation = {
                    agentId,
                    profile: resolved.profile,
                    slotId: `slot-${++slotIdentifiers}`,
                    taskName: request.task_name,
                  }
                  const slots = copy(state.slots)
                  slots.set(reservation.slotId, reservation)
                  const starting = copy(state.starting)
                  starting.set(reservation.slotId, reservation)
                  yield* Ref.set(session.state, { ...state, slots, starting })
                  return reservation
                })
              ).pipe(
                Effect.flatMap((reservation) =>
                  start(session, key, admission, request, { reservation }).pipe(Effect.onError(() => clearStarting(session, reservation.slotId)))
                )
              )
            })
          )
        )
      ),
    waitAll: (key, targets) =>
      Effect.uninterruptibleMask((restore) =>
        active(key).pipe(
          Effect.flatMap((session) =>
            locked(
              session,
              snapshot(session).pipe(
                Effect.flatMap((state) => {
                  if (targets !== undefined) {
                    if (targets.length === 0) {
                      return Effect.fail(refusal('empty_targets', 'At least one target is required.'))
                    }
                    if (new Set(targets).size !== targets.length) {
                      return Effect.fail(refusal('duplicate_target', 'Targets must be unique.'))
                    }
                    const turns = knownTurns(state, targets)
                    return typeof turns === 'string'
                      ? Effect.fail(refusal('unknown_agent', `Unknown agent "${turns}".`))
                      : Effect.succeed({
                          notices: [] as readonly Notice[],
                          sort: false,
                          turns,
                        })
                  }
                  const notices = state.notices.filter((notice) => notice.kind === 'settlement')
                  const turns = [...state.agents.values()].filter(
                    (turn) => turn.background && turn.state === 'running' && turn.delivery === 'unclaimed'
                  )
                  if (notices.length === 0 && turns.length === 0) {
                    return Effect.fail(refusal('empty_targets', 'There are no eligible agents to wait for.'))
                  }
                  const ids = new Set(notices.map((notice) => notice.id))
                  const agents = copy(state.agents)
                  const claims = turns.map((turn) => ({
                    ...turn,
                    delivery: {
                      claim: ++deliveryClaims,
                      kind: 'wait' as const,
                      previous: turn.delivery,
                      state: 'active' as const,
                    },
                  }))
                  for (const claim of claims) {
                    agents.set(claim.taskName, claim)
                  }
                  return Ref.set(session.state, {
                    ...state,
                    agents,
                    notices: state.notices.filter((notice) => !ids.has(notice.id)),
                  }).pipe(Effect.as({ notices, sort: true, turns: claims }))
                })
              )
            ).pipe(
              Effect.flatMap(({ notices, sort, turns }) =>
                Ref.make(false).pipe(
                  Effect.flatMap((committed) =>
                    restore(Effect.all(turns.map((turn) => Deferred.await(turn.deferred)))).pipe(
                      Effect.flatMap((results) => {
                        if (!sort) {
                          return Effect.succeed({ claims: [] as readonly Turn[], results })
                        }
                        return ownedClaimResults(session, turns, results).pipe(
                          Effect.map((owned) => ({
                            claims: turns.filter((claim) => owned.some((result) => result.task_name === claim.taskName)),
                            results: [...notices.flatMap((notice) => (notice.result === undefined ? [] : [notice.result])), ...owned].toSorted(
                              (left, right) => left.task_name.localeCompare(right.task_name)
                            ),
                          }))
                        )
                      }),
                      Effect.flatMap(({ claims, results }) =>
                        sort
                          ? restoreWaitClaims(session, turns, [], claims).pipe(Effect.as({ claims, results }))
                          : Effect.succeed({ claims, results })
                      ),
                      Effect.tap(({ claims }) => commitWaitClaims(claims).pipe(Effect.andThen(Ref.set(committed, true)))),
                      Effect.map(({ results }) => results),
                      Effect.ensuring(
                        Ref.get(committed).pipe(
                          Effect.flatMap((didCommit) => (didCommit || !sort ? Effect.void : restoreWaitClaims(session, turns, notices)))
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      ),

    waitOne: (key, targets) =>
      Effect.uninterruptibleMask((restore) =>
        active(key).pipe(
          Effect.flatMap((session) =>
            locked(
              session,
              snapshot(session).pipe(
                Effect.flatMap((state) => {
                  if (targets !== undefined) {
                    if (targets.length === 0) {
                      return Effect.fail(refusal('empty_targets', 'At least one target is required.'))
                    }
                    if (new Set(targets).size !== targets.length) {
                      return Effect.fail(refusal('duplicate_target', 'Targets must be unique.'))
                    }
                    const turns = knownTurns(state, targets)
                    if (typeof turns === 'string') {
                      return Effect.fail(refusal('unknown_agent', `Unknown agent "${turns}".`))
                    }
                    const [settled] = turns
                      .filter((turn) => turn.result !== undefined)
                      .toSorted(
                        (left, right) => (left.settledAt ?? Infinity) - (right.settledAt ?? Infinity) || left.taskName.localeCompare(right.taskName)
                      )
                    return Effect.succeed<WaitOnePlan>({
                      notice: settled?.result,
                      turns: settled === undefined ? turns : [],
                    })
                  }
                  const notice = state.notices.find((candidate) => candidate.kind === 'settlement')
                  if (notice !== undefined) {
                    return Ref.set(session.state, {
                      ...state,
                      notices: state.notices.filter((candidate) => candidate.id !== notice.id),
                    }).pipe(
                      Effect.as<WaitOnePlan>({
                        consumedNotice: notice,
                        notice: notice.result,
                        turns: [],
                      })
                    )
                  }
                  const turns = [...state.agents.values()].filter(
                    (turn) => turn.background && turn.state === 'running' && turn.delivery === 'unclaimed'
                  )
                  if (turns.length === 0) {
                    return Effect.fail(refusal('empty_targets', 'There are no eligible agents to wait for.'))
                  }
                  const agents = copy(state.agents)
                  const claims = turns.map((turn) => ({
                    ...turn,
                    delivery: {
                      claim: ++deliveryClaims,
                      kind: 'wait' as const,
                      previous: turn.delivery,
                      state: 'active' as const,
                    },
                  }))
                  for (const claim of claims) {
                    agents.set(claim.taskName, claim)
                  }
                  return Ref.set(session.state, { ...state, agents }).pipe(Effect.as<WaitOnePlan>({ turns: claims }))
                })
              )
            ).pipe(
              Effect.flatMap(({ consumedNotice, notice, turns }) => {
                if (notice !== undefined) {
                  return Ref.make(false).pipe(
                    Effect.flatMap((committed) =>
                      restore(Effect.succeed(notice)).pipe(
                        Effect.tap(() => Ref.set(committed, true)),
                        Effect.ensuring(
                          Ref.get(committed).pipe(
                            Effect.flatMap((didCommit) =>
                              didCommit || consumedNotice === undefined ? Effect.void : restoreWaitClaims(session, [], [consumedNotice])
                            )
                          )
                        )
                      )
                    )
                  )
                }
                const wait = (remaining: readonly Turn[]): Effect.Effect<AgentResult, PublicRefusalError> => {
                  const [first, ...rest] = remaining.map((turn) => Deferred.await(turn.deferred).pipe(Effect.map((result) => ({ result, turn }))))
                  if (first === undefined) {
                    return Effect.fail(refusal('empty_targets', 'There are no eligible agents to wait for.'))
                  }
                  return rest
                    .reduce((winner, next) => Effect.race(winner, next), first)
                    .pipe(
                      Effect.flatMap(({ result, turn }) =>
                        locked(session, snapshot(session).pipe(Effect.map((state) => ownsWaitClaim(state.agents.get(turn.taskName), turn)))).pipe(
                          Effect.flatMap((owned) =>
                            targets !== undefined || owned
                              ? restoreWaitClaims(session, turns, [], [turn]).pipe(Effect.as(result))
                              : wait(remaining.filter((claim) => claim !== turn))
                          )
                        )
                      )
                    )
                }
                return Ref.make(false).pipe(
                  Effect.flatMap((committed) =>
                    restore(wait(turns)).pipe(
                      Effect.tap(() =>
                        (targets === undefined ? commitWaitClaims(turns) : Effect.void).pipe(Effect.andThen(Ref.set(committed, true)))
                      ),
                      Effect.ensuring(
                        Ref.get(committed).pipe(
                          Effect.flatMap((didCommit) => (didCommit || targets !== undefined ? Effect.void : restoreWaitClaims(session, turns)))
                        )
                      )
                    )
                  )
                )
              })
            )
          )
        )
      ),
  }
  const dispose = Effect.forEach([...sessions.keys()], (key) => api.closeSession(key).pipe(Effect.ignore), { discard: true }).pipe(Effect.asVoid)
  return { api, dispose }
}
export const SubagentOrchestratorLive: Layer.Layer<
  SubagentOrchestrator,
  never,
  AgentActivity | SubagentStore | ProfileResolver | ChildProcess | NotificationSink
> = Layer.effect(
  SubagentOrchestrator,
  Effect.acquireRelease(
    Effect.gen(function* () {
      const cleanup = yield* Ref.make<ReadonlyMap<string, Cleanup>>(new Map())
      return make({
        activity: yield* AgentActivity,
        cleanup,
        notifications: yield* NotificationSink,
        process: yield* ChildProcess,
        resolver: yield* ProfileResolver,
        store: yield* SubagentStore,
      })
    }),
    (made) => Effect.uninterruptible(made.dispose)
  ).pipe(Effect.map((made) => made.api))
)
