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
  type ProfileResolverApi,
  type StoreError,
  type SubagentRecord,
  type SubagentStoreApi,
} from './store.js'

type SessionKey = string
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
  readonly openSession: (session: SessionKey) => Effect.Effect<void, OrchestrationError>
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
}
export class SubagentOrchestrator extends Context.Service<SubagentOrchestrator, SubagentOrchestratorApi>()(
  'pi-extensions/features/sub_agents/orchestrator/SubagentOrchestrator'
) {}

type Phase = 'closed' | 'open' | 'opening' | 'closing'
type TurnState = 'running' | 'settling' | 'settled'
interface Reservation {
  readonly agentId: string
  readonly profile: PersistedResolvedProfile
  readonly taskName: string
}
interface Turn extends Reservation {
  readonly activity: Ref.Ref<number>
  readonly child: RunningChild
  readonly background: boolean
  readonly deferred: Deferred.Deferred<AgentResult, PublicRefusalError>
  readonly deadlineMonotonic: bigint
  readonly deadlineWall: number
  readonly followUp: Ref.Ref<'available' | 'pending' | 'used'>
  readonly generation: number
  readonly logPath: string
  readonly sessionKey: string
  readonly sessionPath: string
  readonly state: TurnState
  readonly steerResponse: Ref.Ref<Deferred.Deferred<SteeringAck | CommandError> | undefined>
  readonly result?: AgentResult
  readonly warningEnqueued: boolean
  readonly turn: number
  readonly turns: readonly AgentTurnRecord[]
  readonly released: boolean
  readonly resourceReleased: Ref.Ref<boolean>
}
interface Notice {
  readonly id: number
  readonly kind: 'settlement' | 'warning'
  readonly message: string
  readonly result?: AgentResult
  readonly settledAt: number
  readonly taskName: string
}
interface Snapshot {
  readonly agents: ReadonlyMap<string, Turn>
  readonly notices: readonly Notice[]
  readonly phase: Phase
  readonly slots: ReadonlyMap<string, Reservation>
  readonly starting: ReadonlySet<string>
}
interface Session {
  readonly generation: number
  readonly mutex: Semaphore.Semaphore
  readonly scope: Scope.Closeable
  readonly state: Ref.Ref<Snapshot>
}
interface Cleanup {
  readonly child?: RunningChild
  readonly identity: ProcessIdentity
  readonly profile?: PersistedResolvedProfile
  readonly session: SessionKey
  readonly taskName: string
}
interface ChildDecoder {
  readonly end: () => void
  readonly push: (chunk: Uint8Array) => unknown[]
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
  readonly turn: Turn
  readonly value?: SettledInterruptNoop
}

const refusal = (code: ToolErrorCode, message: string, cause?: unknown): PublicRefusalError =>
  PublicRefusalError.make(cause === undefined ? { code, message } : { cause, code, message })
const unavailable = (): PublicRefusalError => refusal('session_unavailable', 'The session is not open.')
const failure = (operation: LifecycleError['operation'], reason: LifecycleError['reason'], error: unknown): LifecycleError =>
  LifecycleError.make({ cause: error, message: error instanceof Error ? error.message : String(error), operation, reason })
export const WORKER_ENTRYPOINT = Bun.fileURLToPath(new URL('worker.ts', import.meta.url))
const TURN_DEADLINE_MILLIS = 30 * 60 * 1000
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
const correlatedInitial = (frame: DecodedChild, agentId: string): boolean =>
  frame.agent_id === agentId && frame.turn === 1 && frame.command_id === 'initial'
const childLifecycleFrame = (frame: unknown): frame is DecodedChild =>
  Value.Check(ChildProgressFrameSchema, frame) ||
  Value.Check(ChildResultFrameSchema, frame) ||
  Value.Check(ChildSteerAckFrameSchema, frame) ||
  Value.Check(ChildCommandErrorFrameSchema, frame)
const outcome = (taskName: string, status: 'failed' | 'interrupted', code: ToolErrorCode, message: string): AgentResult => ({
  error: { code, message },
  status,
  task_name: taskName,
  turn: 1,
})
const copy = <Key, Value>(map: ReadonlyMap<Key, Value>): Map<Key, Value> => new Map(map)
const attempt = <Value, Error>(effect: Effect.Effect<Value, Error>) =>
  effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) => Effect.succeed({ error, ok: false as const }))
  )
const releaseProcess = (turn: Turn): Effect.Effect<void, ProcessError> =>
  Ref.modify(turn.resourceReleased, (released): readonly [boolean, boolean] => [released, true]).pipe(
    Effect.flatMap((released) => (released ? Effect.void : turn.child.release))
  )
const locked = <Value, Error>(session: Session, effect: Effect.Effect<Value, Error>): Effect.Effect<Value, Error> =>
  session.mutex.withPermits(1)(effect)
const snapshot = (session: Session): Effect.Effect<Snapshot> => Ref.get(session.state)
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
  let initialized: Deferred.Deferred<void, OrchestrationError> | undefined
  let identifiers = 0
  let generations = 0
  let noticeIdentifiers = 0
  const publishReady = (turn: Turn, lastActivityAt: number): Effect.Effect<void> =>
    activity.publish([
      ...activity.list().filter((agent) => agent.agentId !== turn.agentId),
      {
        agentId: turn.agentId,
        color: activityColor(turn.profile.key),
        lastActivityAt,
        name: turn.taskName,
        profile: turn.profile.key,
        sessionId: turn.sessionKey,
        state: 'running',
      },
    ])
  const removeActivity = (agentId: string): Effect.Effect<void> => activity.publish(activity.list().filter((agent) => agent.agentId !== agentId))
  const closeActivity = (sessionId: string): Effect.Effect<void> => activity.publish(activity.list().filter((agent) => agent.sessionId !== sessionId))
  const touch = (turn: Turn): Effect.Effect<void> =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((lastActivityAt) =>
        Ref.update(turn.activity, (value) => value + 1).pipe(
          Effect.andThen(activity.publish(activity.list().map((agent) => (agent.agentId === turn.agentId ? { ...agent, lastActivityAt } : agent))))
        )
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
    store
      .createLease(agentId, { identity: item.identity, session: item.session, taskName: item.taskName })
      .pipe(Effect.andThen(Ref.update(cleanup, (items) => new Map(items).set(agentId, item))), Effect.asVoid)
  const releaseCleanup = (agentId: string, item: Cleanup, removeArtifacts = false) =>
    (item.child === undefined ? Effect.void : item.child.release).pipe(
      Effect.andThen(removeArtifacts ? store.delete(agentId) : store.removeLease(agentId)),
      Effect.andThen(
        Ref.update(cleanup, (items) => {
          const next = new Map(items)
          next.delete(agentId)
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
  const handoff = (agentId: string, item: Cleanup): Effect.Effect<void> =>
    retainCleanup(agentId, item).pipe(Effect.andThen(Effect.forkDetach(superviseCleanup(agentId, item))), Effect.asVoid, Effect.orDie)
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
                return Ref.set(session.state, { ...state, notices: state.notices.filter((notice) => !ids.has(notice.id)) }).pipe(Effect.as(claimed))
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
                  Effect.andThen(notifications.publish([...claimed.map((notice) => notice.message), notificationDirections]).pipe(Effect.ignore)),
                  Effect.ensuring(
                    Ref.get(invoked).pipe(
                      Effect.flatMap((didInvoke) =>
                        didInvoke
                          ? Effect.void
                          : locked(
                              session,
                              snapshot(session).pipe(
                                Effect.flatMap((state) => Ref.set(session.state, { ...state, notices: [...claimed, ...state.notices] }))
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
        Effect.flatMap((state) => Ref.set(session.state, { ...state, notices: [...state.notices, { ...notice, id: ++noticeIdentifiers }] }))
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
  const clearStarting = (session: Session, taskName: string): Effect.Effect<void> =>
    locked(
      session,
      snapshot(session).pipe(
        Effect.flatMap((state) => {
          const starting = new Set(state.starting)
          starting.delete(taskName)
          const slots = new Map([...state.slots].filter(([, reservation]) => reservation.taskName !== taskName))
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
        slots.delete(turn.agentId)
        yield* Ref.set(session.state, { ...state, agents, slots })
      })
    )
  const stop = (turn: Turn, commandId: string): Effect.Effect<StopResult> => {
    let frame: string
    try {
      frame = encodeFrame({ agent_id: turn.agentId, command_id: commandId, turn: turn.turn, type: 'interrupt' })
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
      return { errors: attempts.flatMap((result) => (result.ok ? [] : [result.error])), stopped }
    })
  }
  const settle = (session: Session, token: Turn, value: AgentResult, commandId: string, stopAfter = true): Effect.Effect<void> =>
    locked(
      session,
      Effect.gen(function* () {
        const state = yield* snapshot(session)
        const current = state.agents.get(token.taskName)
        if (current === undefined || current.generation !== token.generation || current.state !== 'running') {
          return
        }
        const agents = copy(state.agents)
        agents.set(token.taskName, { ...current, state: 'settling' })
        yield* Ref.set(session.state, { ...state, agents })
        const settledAt = yield* Clock.currentTimeMillis
        const written = yield* Effect.result(
          store.replaceRecord(current.agentId, {
            logPath: current.logPath,
            profile: current.profile,
            session: current.sessionKey,
            sessionPath: current.sessionPath,
            settledAt,
            status: value.status,
            taskName: current.taskName,
            turns: [...current.turns, { profile: current.profile, result: value }],
          })
        )
        const after = yield* snapshot(session)
        const latest = after.agents.get(token.taskName)
        if (latest === undefined || latest.generation !== token.generation) {
          return
        }
        if (written._tag === 'Failure') {
          const failedAgents = copy(after.agents)
          failedAgents.set(token.taskName, { ...latest, state: 'running' })
          yield* Ref.set(session.state, { ...after, agents: failedAgents })
          yield* Deferred.fail(latest.deferred, refusal('agent_failed', String(written.failure)))
          return
        }
        const settledAgents = copy(after.agents)
        const settled = { ...latest, result: value, state: 'settled' as const, turns: [...latest.turns, { profile: latest.profile, result: value }] }
        settledAgents.set(token.taskName, settled)
        const notices = latest.background
          ? [
              ...after.notices,
              {
                id: ++noticeIdentifiers,
                kind: 'settlement' as const,
                message: resultMessage(value),
                result: value,
                settledAt,
                taskName: latest.taskName,
              },
            ]
          : after.notices
        yield* Ref.set(session.state, { ...after, agents: settledAgents, notices })
        yield* removeActivity(latest.agentId)
        yield* Deferred.succeed(settled.deferred, value)
        if (latest.background) {
          yield* Effect.forkIn(flushNotifications(session), session.scope)
        }
      })
    ).pipe(stopAfter && commandId !== 'close' ? Effect.ensuring(stop(token, commandId).pipe(Effect.asVoid)) : Effect.asVoid, Effect.asVoid)
  const completeStop = (session: Session, key: string, turn: Turn, stopped: StopResult['stopped']): Effect.Effect<void> => {
    if (stopped === 'exited') {
      return Effect.all([releaseProcess(turn).pipe(Effect.ignore), releaseSlot(session, turn)]).pipe(Effect.asVoid)
    }
    if (stopped === 'mismatch') {
      return Effect.all([store.delete(turn.agentId).pipe(Effect.ignore), releaseProcess(turn).pipe(Effect.ignore), releaseSlot(session, turn)]).pipe(
        Effect.asVoid
      )
    }
    return handoff(turn.agentId, {
      child: turn.child,
      identity: turn.child.identity,
      profile: turn.profile,
      session: key,
      taskName: turn.taskName,
    }).pipe(Effect.ignore)
  }
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
              outcome(turn.taskName, 'failed', 'protocol_error', 'Worker sent an unexpected steering acknowledgement.'),
              'protocol_error'
            )
          : Ref.set(turn.followUp, response.accepted ? 'used' : 'available').pipe(Effect.andThen(Deferred.succeed(waiting, response)))
      ),
      Effect.asVoid
    )
  const settleFrame = (session: Session, turn: Turn, frame: unknown): Effect.Effect<void> => {
    if (!valid(turn, frame)) {
      return settle(session, turn, outcome(turn.taskName, 'failed', 'protocol_error', 'Worker sent an invalid lifecycle frame.'), 'protocol_error')
    }
    if (Value.Check(ChildProgressFrameSchema, frame)) {
      return touch(turn)
    }
    if (Value.Check(ChildSteerAckFrameSchema, frame)) {
      return touch(turn).pipe(
        Effect.andThen(answerSteer(session, turn, { accepted: true, status: 'running', task_name: turn.taskName, turn: turn.turn }))
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
    if (frame.status !== 'completed') {
      return touch(turn).pipe(
        Effect.andThen(
          Ref.getAndSet(turn.steerResponse, undefined).pipe(
            Effect.tap((waiting) =>
              waiting === undefined
                ? Effect.void
                : Ref.set(turn.followUp, 'available').pipe(
                    Effect.andThen(
                      Deferred.succeed(waiting, {
                        accepted: false,
                        error: { code: 'turn_settled', message: 'The turn settled before steering was accepted.' },
                        status: frame.status,
                        task_name: turn.taskName,
                        turn: turn.turn,
                      })
                    )
                  )
            ),
            Effect.andThen(settle(session, turn, { error: frame.error, status: frame.status, task_name: turn.taskName, turn: turn.turn }, 'result'))
          )
        )
      )
    }
    if ('conclusion' in frame) {
      return touch(turn).pipe(
        Effect.andThen(
          Ref.getAndSet(turn.steerResponse, undefined).pipe(
            Effect.tap((waiting) => (waiting === undefined ? Effect.void : Ref.set(turn.followUp, 'available'))),
            Effect.andThen(
              settle(session, turn, { conclusion: frame.conclusion, status: 'completed', task_name: turn.taskName, turn: turn.turn }, 'result')
            )
          )
        )
      )
    }
    if (frame.conclusion_bytes > MAX_ARTIFACT_BYTES) {
      return touch(turn).pipe(
        Effect.andThen(settle(session, turn, outcome(turn.taskName, 'failed', 'result_too_large', 'The full result exceeds 10 MiB.'), 'result'))
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
            return settle(session, turn, outcome(turn.taskName, 'failed', 'result_too_large', 'The full result exceeds 10 MiB.'), 'result')
          }
          if (content.byteLength !== frame.conclusion_bytes) {
            return settle(session, turn, outcome(turn.taskName, 'failed', 'agent_failed', 'Worker artifact byte count did not match.'), 'result')
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
                  'result'
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
          onFailure: () => settle(session, turn, outcome(turn.taskName, 'failed', 'agent_failed', 'Worker stdout failed.'), 'stdout'),
          onSuccess: (bytes) => {
            if (bytes === undefined) {
              try {
                frames.end()
              } catch {
                return settle(
                  session,
                  turn,
                  outcome(turn.taskName, 'failed', 'protocol_error', 'Worker stdout ended with an incomplete frame.'),
                  'eof'
                )
              }
              return settle(session, turn, outcome(turn.taskName, 'failed', 'agent_failed', 'Worker stdout ended without a result.'), 'eof')
            }
            try {
              return Effect.forEach(frames.push(bytes), (frame) => settleFrame(session, turn, frame), { discard: true }).pipe(Effect.andThen(next))
            } catch {
              return settle(session, turn, outcome(turn.taskName, 'failed', 'protocol_error', 'Worker sent malformed JSONL.'), 'protocol_error')
            }
          },
        })
      )
    return Effect.forEach(pending, (frame) => settleFrame(session, turn, frame), { discard: true }).pipe(Effect.andThen(next))
  }
  const deadline = (session: Session, turn: Turn): Effect.Effect<void> => {
    const wait = (): Effect.Effect<void> =>
      Effect.all([Clock.currentTimeMillis, Clock.monotonicTimeNanos]).pipe(
        Effect.flatMap(([wall, monotonic]) => {
          if (wall >= turn.deadlineWall || monotonic >= turn.deadlineMonotonic) {
            return settle(session, turn, outcome(turn.taskName, 'failed', 'turn_timeout', 'The sub-agent exceeded its deadline.'), 'deadline')
          }
          const remaining = Number((turn.deadlineMonotonic - monotonic) / 1_000_000n)
          return Effect.sleep(`${Math.max(1, remaining)} millis`).pipe(Effect.andThen(wait))
        })
      )
    return wait()
  }
  const supervise = (session: Session, turn: Turn): Effect.Effect<void> =>
    turn.child.wait.pipe(
      Effect.andThen(settle(session, turn, outcome(turn.taskName, 'failed', 'agent_failed', 'The worker exited without a result.'), 'exit')),
      Effect.andThen(releaseProcess(turn).pipe(Effect.ignore)),
      Effect.andThen(releaseSlot(session, turn))
    )
  const readReady = (child: RunningChild, agentId: string, frames: ChildDecoder, pending: unknown[]): Effect.Effect<string, PublicRefusalError> => {
    const next = (): Effect.Effect<string, PublicRefusalError> =>
      child.readStdout.pipe(
        Effect.mapError((error) => refusal('startup_failed', error.message, error)),
        Effect.flatMap((bytes) => {
          if (bytes === undefined) {
            return Effect.fail(refusal('startup_failed', 'Worker exited before readiness.'))
          }
          try {
            let sessionPath: string | undefined
            for (const frame of frames.push(bytes)) {
              if (sessionPath === undefined && Value.Check(ChildReadyFrameSchema, frame)) {
                if (!correlatedInitial(frame, agentId)) {
                  return Effect.fail(refusal('protocol_error', 'Worker sent an invalid readiness frame.'))
                }
                sessionPath = frame.session_path
                continue
              }
              if (!childLifecycleFrame(frame)) {
                return Effect.fail(refusal('protocol_error', 'Worker sent an invalid readiness frame.'))
              }
              if (!correlatedInitial(frame, agentId)) {
                return Effect.fail(refusal('protocol_error', 'Worker sent an invalid readiness frame.'))
              }
              if (sessionPath === undefined && !Value.Check(ChildProgressFrameSchema, frame)) {
                return Effect.fail(refusal('protocol_error', 'Worker sent an invalid readiness frame.'))
              }
              pending.push(frame)
            }
            return sessionPath === undefined ? next() : Effect.succeed(sessionPath)
          } catch {
            return Effect.fail(refusal('protocol_error', 'Worker sent an invalid readiness frame.'))
          }
        })
      )
    return next()
  }
  const reconcile = (
    agentId: string,
    run: { readonly lease?: LaunchLease; readonly record?: SubagentRecord }
  ): Effect.Effect<void, StoreError | ProcessError> =>
    Effect.gen(function* () {
      const identities = [
        ...(run.lease === undefined ? [] : [run.lease.identity]),
        ...(run.record?.status === 'running' ? [run.record.identity] : []),
      ].filter((identity, index, all) => all.findIndex((other) => other.pid === identity.pid && other.birthMarker === identity.birthMarker) === index)
      const mismatch = identities.length > 1
      const stopped: TerminationResult[] = []
      for (const identity of identities) {
        stopped.push(yield* process.terminateVerified(identity))
      }
      if (mismatch || run.record?.status !== 'running' || stopped.some((result) => result === 'exited' || result === 'mismatch')) {
        yield* store.delete(agentId)
        return
      }
      const [identity] = identities
      const source = run.record ?? run.lease
      if (identity !== undefined && source !== undefined) {
        yield* retainCleanup(agentId, {
          identity,
          profile: run.record?.status === 'running' ? run.record.profile : undefined,
          session: source.session,
          taskName: source.taskName,
        })
      }
      return
    })
  const initialize = (): Effect.Effect<void, OrchestrationError> =>
    Effect.suspend(() => {
      if (initialized !== undefined) {
        return Deferred.await(initialized)
      }
      const gate = Deferred.makeUnsafe<void, OrchestrationError>()
      initialized = gate
      return Effect.gen(function* () {
        yield* store.initialize
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
        Effect.onExit((exit) => Deferred.done(gate, exit))
      )
    })
  const start = (
    session: Session,
    key: string,
    admission: AdmissionSnapshot,
    request: SpawnAgentInput,
    options: { readonly reservation: Reservation; readonly resume?: { readonly sessionPath: string; readonly turns: readonly AgentTurnRecord[] } }
  ): Effect.Effect<AgentResult | RunningAcceptance, OrchestrationError> => {
    const { reservation, resume } = options
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const [dispatchWall, dispatchMonotonic] = yield* Effect.all([Clock.currentTimeMillis, Clock.monotonicTimeNanos])
        const deadlineWall = dispatchWall + TURN_DEADLINE_MILLIS
        const deadlineMonotonic = dispatchMonotonic + BigInt(TURN_DEADLINE_MILLIS) * 1_000_000n
        const logPath = yield* store.createLog(reservation.agentId).pipe(Effect.mapError((error) => refusal('startup_failed', error.message)))
        const descriptor =
          resume === undefined
            ? yield* store.createSession(reservation.agentId).pipe(Effect.mapError((error) => refusal('startup_failed', error.message)))
            : { runDirectory: bunPath.dirname(resume.sessionPath), sessionPath: resume.sessionPath }
        const frames = yield* Effect.try({
          catch: () => refusal('frame_too_large', 'Worker frame exceeds the 1 MiB limit.'),
          try: () => ({
            config: encodeFrame({
              agent_id: reservation.agentId,
              run_dir: descriptor.runDirectory,
              session:
                resume === undefined
                  ? { expected_dir: descriptor.runDirectory, mode: 'create' as const }
                  : { canonical_path: resume.sessionPath, mode: 'open' as const },
              turn: resume === undefined ? 1 : resume.turns.length + 1,
              type: 'config' as const,
              version: 1 as const,
              worker: deriveWorkerConfig(reservation.profile, admission),
            }),
            task: encodeFrame({
              agent_id: reservation.agentId,
              command_id: 'initial',
              message: request.message,
              turn: resume === undefined ? 1 : resume.turns.length + 1,
              type: 'task' as const,
            }),
          }),
        })
        const child = yield* process
          .spawn({
            args: [WORKER_ENTRYPOINT],
            command: Bun.argv[0],
            cwd: admission.cwd,
            environment: deriveChildEnvironment(reservation.profile, admission, reservation.agentId, () => Bun.randomUUIDv7()),
            stderrPath: logPath,
          })
          .pipe(Effect.mapError((error) => refusal('startup_failed', error.message)))
        const cleanupLaunch = (): Effect.Effect<void> =>
          process.terminateVerified(child.identity).pipe(
            Effect.ignore,
            Effect.andThen(child.isAlive.pipe(Effect.orElseSucceed(() => true))),
            Effect.flatMap((alive) =>
              alive
                ? handoff(reservation.agentId, {
                    child,
                    identity: child.identity,
                    profile: reservation.profile,
                    session: key,
                    taskName: reservation.taskName,
                  })
                : child.release.pipe(
                    Effect.ignore,
                    Effect.andThen(
                      releaseSlot(session, {
                        ...reservation,
                        activity: Ref.makeUnsafe(0),
                        background: request.run_in_background === true,
                        child,
                        deadlineMonotonic,
                        deadlineWall,
                        deferred: Deferred.makeUnsafe(),
                        followUp: Ref.makeUnsafe<'available' | 'pending' | 'used'>('available'),
                        generation: session.generation,
                        logPath,
                        released: false,
                        resourceReleased: Ref.makeUnsafe(false),
                        sessionKey: key,
                        sessionPath: descriptor.sessionPath,
                        state: 'running',
                        steerResponse: Ref.makeUnsafe<Deferred.Deferred<SteeringAck | CommandError> | undefined>(undefined),
                        turn: 1,
                        turns: [],
                        warningEnqueued: false,
                      })
                    )
                  )
            )
          )
        const launched = Effect.gen(function* () {
          yield* store.createLease(reservation.agentId, { identity: child.identity, session: key, taskName: request.task_name })
          yield* child.write(frames.config)
          yield* child.write(frames.task)
          const childFrames = decoder()
          const pendingFrames: unknown[] = []
          const path = yield* Effect.timeout(readReady(child, reservation.agentId, childFrames, pendingFrames), '30 seconds').pipe(
            Effect.flatMap((value) =>
              value === undefined ? Effect.fail(refusal('startup_timeout', 'Worker did not become ready in time.')) : Effect.succeed(value)
            )
          )
          const checked = yield* validateWorkerSessionPath(
            resume === undefined
              ? { expectedDir: descriptor.runDirectory, mode: 'create', path }
              : { expectedCanonicalPath: resume.sessionPath, expectedDir: descriptor.runDirectory, mode: 'open', path }
          ).pipe(Effect.mapError((error) => refusal('startup_failed', error.message)))
          const turn: Turn = {
            ...reservation,
            activity: Ref.makeUnsafe(0),
            background: request.run_in_background === true,
            child,
            deadlineMonotonic,
            deadlineWall,
            deferred: Deferred.makeUnsafe<AgentResult, PublicRefusalError>(),
            followUp: Ref.makeUnsafe<'available' | 'pending' | 'used'>(resume === undefined ? 'available' : 'used'),
            generation: session.generation,
            logPath,
            released: false,
            resourceReleased: Ref.makeUnsafe(false),
            sessionKey: key,
            sessionPath: checked.canonicalPath,
            state: 'running',
            steerResponse: Ref.makeUnsafe<Deferred.Deferred<SteeringAck | CommandError> | undefined>(undefined),
            turn: resume === undefined ? 1 : resume.turns.length + 1,
            turns: resume?.turns ?? [],
            warningEnqueued: false,
          }
          yield* locked(
            session,
            Effect.uninterruptible(
              Effect.gen(function* () {
                const state = yield* snapshot(session)
                if (state.phase !== 'open' || session.generation !== turn.generation) {
                  return yield* unavailable()
                }
                const running: SubagentRecord = {
                  identity: child.identity,
                  logPath,
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
                const starting = new Set(state.starting)
                starting.delete(request.task_name)
                yield* Ref.set(session.state, { ...state, agents, starting })
                yield* Clock.currentTimeMillis.pipe(Effect.flatMap((now) => publishReady(turn, now)))
                yield* Effect.forkIn(supervise(session, turn), session.scope)
                yield* Effect.forkIn(stream(session, turn, childFrames, pendingFrames), session.scope)
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
              turn: resume === undefined ? 1 : resume.turns.length + 1,
            },
            turn,
          }
        }).pipe(
          Effect.mapError((error) =>
            Schema.is(PublicRefusalError)(error) ? error : refusal('startup_failed', error instanceof Error ? error.message : String(error), error)
          )
        )
        const accepted = yield* Effect.onError(restore(launched), () => cleanupLaunch().pipe(Effect.ignore))
        return request.run_in_background === true ? accepted.acceptance : yield* restore(Deferred.await(accepted.turn.deferred))
      })
    )
  }
  const api: SubagentOrchestratorApi = {
    closeSession: (key) =>
      active(key).pipe(
        Effect.flatMap((session) =>
          locked(
            session,
            Effect.gen(function* () {
              const state = yield* snapshot(session)
              if (state.phase !== 'open') {
                return yield* unavailable()
              }
              yield* Ref.set(session.state, { ...state, phase: 'closing' as const })
              return [...state.agents.values()]
            })
          ).pipe(
            Effect.flatMap((turns) =>
              Effect.forEach(
                turns,
                (turn) =>
                  settle(session, turn, outcome(turn.taskName, 'interrupted', 'interrupted', 'The sub-agent was interrupted.'), 'close').pipe(
                    Effect.andThen(stop(turn, 'close')),
                    Effect.flatMap(({ errors, stopped }) => {
                      if (stopped === 'stillAlive' || stopped === 'unverifiable') {
                        return handoff(turn.agentId, {
                          child: turn.child,
                          identity: turn.child.identity,
                          profile: turn.profile,
                          session: key,
                          taskName: turn.taskName,
                        }).pipe(
                          Effect.flatMap(() =>
                            errors.length === 0
                              ? Effect.void
                              : Effect.fail(failure('close_session', 'cleanup_incomplete', errors.map(String).join('; ')))
                          )
                        )
                      }
                      return Effect.all([
                        stopped === 'mismatch' ? store.delete(turn.agentId) : Effect.void,
                        releaseProcess(turn),
                        releaseSlot(session, turn),
                      ]).pipe(
                        Effect.flatMap(() =>
                          errors.length === 0
                            ? Effect.void
                            : Effect.fail(failure('close_session', 'cleanup_incomplete', errors.map(String).join('; ')))
                        )
                      )
                    }),
                    Effect.exit
                  ),
                { concurrency: 'unbounded' }
              )
            ),
            Effect.flatMap((attempts) =>
              closeActivity(key).pipe(
                Effect.andThen(Scope.close(session.scope, Exit.void)),
                Effect.exit,
                Effect.andThen((scope) =>
                  locked(
                    session,
                    snapshot(session).pipe(Effect.flatMap((state) => Ref.set(session.state, { ...state, phase: 'closed' as const })))
                  ).pipe(
                    Effect.exit,
                    Effect.flatMap((closed) => {
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
      ),
    initialize: initialize(),
    interrupt: (key, target): Effect.Effect<AgentResult | SettledInterruptNoop, OrchestrationError> =>
      active(key).pipe(
        Effect.flatMap((session) =>
          locked(
            session,
            snapshot(session).pipe(
              Effect.flatMap((state) => {
                const turn = state.agents.get(target)
                if (turn === undefined) {
                  return state.starting.has(target)
                    ? Effect.fail(refusal('not_ready', `Agent "${target}" is still starting.`))
                    : Effect.fail(refusal('unknown_agent', `Unknown agent "${target}".`))
                }
                if (turn.result !== undefined) {
                  return Effect.succeed<InterruptPlan>({
                    turn,
                    value: { interrupted: false, status: turn.result.status, task_name: target, turn: turn.turn },
                  })
                }
                return Effect.succeed<InterruptPlan>({ turn })
              })
            )
          ).pipe(
            Effect.flatMap(({ turn, value }) => {
              if (value !== undefined) {
                return Effect.succeed<AgentResult | SettledInterruptNoop>(value)
              }
              return settle(session, turn, outcome(target, 'interrupted', 'interrupted', 'The sub-agent was interrupted.'), 'interrupt', false).pipe(
                Effect.andThen(stop(turn, 'interrupt')),
                Effect.tap(({ stopped }) => completeStop(session, key, turn, stopped)),
                Effect.andThen(Deferred.await(turn.deferred)),
                Effect.map((result): AgentResult | SettledInterruptNoop => result)
              )
            })
          )
        )
      ),
    interruptAll: (key) =>
      active(key).pipe(
        Effect.flatMap((session) =>
          snapshot(session).pipe(
            Effect.flatMap((state) =>
              Effect.forEach(
                [...state.agents.values()],
                (turn) =>
                  turn.result === undefined
                    ? settle(
                        session,
                        turn,
                        outcome(turn.taskName, 'interrupted', 'interrupted', 'The sub-agent was interrupted.'),
                        'interrupt_all'
                      ).pipe(
                        Effect.andThen(
                          locked(
                            session,
                            snapshot(session).pipe(
                              Effect.flatMap((latest) =>
                                Ref.set(session.state, {
                                  ...latest,
                                  notices: latest.notices.filter((notice) => !(notice.kind === 'settlement' && notice.taskName === turn.taskName)),
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
      ),
    list: (key) =>
      active(key).pipe(
        Effect.flatMap((session) =>
          snapshot(session).pipe(
            Effect.flatMap((state) =>
              Effect.forEach([...state.agents.values()], (turn) =>
                store.readRecord(turn.agentId).pipe(
                  Effect.mapError((error) => refusal('agent_failed', error.message)),
                  Effect.flatMap((record) =>
                    record === undefined || record.session !== key
                      ? Effect.fail(refusal('unknown_agent', `Unknown agent "${turn.taskName}".`))
                      : Effect.succeed({
                          current_turn: record.turns.at(-1)?.result.turn ?? turn.turn,
                          follow_up_available: false,
                          profile: record.profile.key,
                          status: record.status,
                          task_name: record.taskName,
                        })
                  )
                )
              )
            )
          )
        )
      ),
    openSession: (key) =>
      initialize().pipe(
        Effect.andThen(
          Effect.sync(() => {
            const old = sessions.get(key)
            if (old === undefined || Ref.getUnsafe(old.state).phase === 'closed') {
              sessions.set(key, {
                generation: ++generations,
                mutex: Semaphore.makeUnsafe(1),
                scope: Scope.makeUnsafe(),
                state: Ref.makeUnsafe<Snapshot>({ agents: new Map(), notices: [], phase: 'open', slots: new Map(), starting: new Set() }),
              })
            }
          })
        ),
        Effect.mapError((error) => (Schema.is(LifecycleError)(error) ? error : failure('open_session', 'host_failure', error)))
      ),
    read: (key, target) =>
      active(key).pipe(
        Effect.flatMap((session) =>
          findTurn(session, target).pipe(
            Effect.flatMap((turn) =>
              turn === undefined
                ? Effect.fail(refusal('unknown_agent', `Unknown agent "${target}".`))
                : store.readRecord(turn.agentId).pipe(
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
            )
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
                    const projected = Math.ceil(new TextEncoder().encode(message).byteLength / 4) + 8192
                    if (projected >= resolved.profile.contextCeiling) {
                      return Effect.fail(refusal('context_limit', 'The follow-up would reach the context limit.'))
                    }
                    return locked(
                      session,
                      Effect.gen(function* () {
                        if ((yield* Ref.get(turn.followUp)) !== 'available') {
                          return yield* refusal('follow_up_used', 'The follow-up allowance has already been used.')
                        }
                        const state = yield* snapshot(session)
                        if (state.agents.get(target)?.generation !== turn.generation || state.slots.size >= 3) {
                          return yield* refusal('capacity_exceeded', 'Worker capacity is exhausted.')
                        }
                        const reservation: Reservation = { agentId: turn.agentId, profile: resolved.profile, taskName: target }
                        yield* Ref.set(turn.followUp, 'pending')
                        yield* Ref.set(session.state, { ...state, slots: new Map(state.slots).set(turn.agentId, reservation) })
                        return reservation
                      })
                    ).pipe(
                      Effect.flatMap((reservation) =>
                        store.readRecord(turn.agentId).pipe(
                          Effect.mapError((error) => refusal('agent_failed', error.message)),
                          Effect.flatMap((record) =>
                            record === undefined || record.status !== 'completed' || record.session !== key
                              ? Effect.fail(refusal('not_resumable', 'The completed agent is no longer available.'))
                              : start(
                                  session,
                                  key,
                                  _admission,
                                  { agent_type: resolved.profile.key, message, run_in_background: false, task_name: target },
                                  { reservation, resume: { sessionPath: record.sessionPath, turns: record.turns } }
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
              const reserve = Effect.gen(function* () {
                const allowance = yield* Ref.get(turn.followUp)
                if (allowance !== 'available') {
                  return yield* refusal('follow_up_used', 'The follow-up allowance has already been used.')
                }
                const waiting = yield* Deferred.make<SteeringAck | CommandError>()
                yield* Ref.set(turn.followUp, 'pending')
                yield* Ref.set(turn.steerResponse, waiting)
                return waiting
              })
              let frame: string
              try {
                frame = encodeFrame({ agent_id: turn.agentId, command_id: 'steer', message, turn: turn.turn, type: 'steer' })
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
                                  error: { code: 'turn_settled', message: 'The turn settled before steering was accepted.' },
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
                  if (state.agents.has(request.task_name)) {
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
                  const reservation: Reservation = { agentId: `agent-${++identifiers}`, profile: resolved.profile, taskName: request.task_name }
                  const slots = copy(state.slots)
                  slots.set(reservation.agentId, reservation)
                  const starting = new Set(state.starting)
                  starting.add(request.task_name)
                  yield* Ref.set(session.state, { ...state, slots, starting })
                  return reservation
                })
              ).pipe(
                Effect.flatMap((reservation) => start(session, key, admission, request, { reservation })),
                Effect.onError(() => clearStarting(session, request.task_name))
              )
            })
          )
        )
      ),
    waitAll: (key, targets) =>
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
                    : Effect.succeed({ notices: [] as readonly Notice[], sort: false, turns })
                }
                const notices = state.notices.filter((notice) => notice.kind === 'settlement')
                const turns = [...state.agents.values()].filter((turn) => turn.background && turn.state === 'running')
                if (notices.length === 0 && turns.length === 0) {
                  return Effect.fail(refusal('empty_targets', 'There are no eligible agents to wait for.'))
                }
                const ids = new Set(notices.map((notice) => notice.id))
                return Ref.set(session.state, { ...state, notices: state.notices.filter((notice) => !ids.has(notice.id)) }).pipe(
                  Effect.as({ notices, sort: true, turns })
                )
              })
            )
          ).pipe(
            Effect.flatMap(({ notices, sort, turns }) =>
              Effect.all(turns.map((turn) => Deferred.await(turn.deferred))).pipe(
                Effect.map((results) => [...notices.flatMap((notice) => (notice.result === undefined ? [] : [notice.result])), ...results]),
                Effect.map((results) => (sort ? results.toSorted((left, right) => left.task_name.localeCompare(right.task_name)) : results))
              )
            )
          )
        )
      ),
    waitOne: (key, targets) =>
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
                    : Effect.succeed<{ readonly notice: Notice | undefined; readonly turns: readonly Turn[] }>({ notice: undefined, turns })
                }
                const notice = state.notices.find((candidate) => candidate.kind === 'settlement')
                if (notice !== undefined) {
                  return Ref.set(session.state, { ...state, notices: state.notices.filter((candidate) => candidate.id !== notice.id) }).pipe(
                    Effect.as<{ readonly notice: Notice | undefined; readonly turns: readonly Turn[] }>({
                      notice,
                      turns: [] as readonly Turn[],
                    })
                  )
                }
                const turns = [...state.agents.values()].filter((turn) => turn.background && turn.state === 'running')
                return turns.length === 0
                  ? Effect.fail(refusal('empty_targets', 'There are no eligible agents to wait for.'))
                  : Effect.succeed<{ readonly notice: Notice | undefined; readonly turns: readonly Turn[] }>({ notice: undefined, turns })
              })
            )
          ).pipe(
            Effect.flatMap(({ notice, turns }) => {
              if (notice?.result !== undefined) {
                return Effect.succeed(notice.result)
              }
              const [first, ...rest] = turns.map((turn) => Deferred.await(turn.deferred))
              return first === undefined
                ? Effect.fail(refusal('empty_targets', 'There are no eligible agents to wait for.'))
                : rest.reduce((winner, waiting) => Effect.race(winner, waiting), first)
            })
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
