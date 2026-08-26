import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Ref, Scope } from 'effect'
import { TestClock } from 'effect/testing'

import {
  type AdmissionSnapshot,
  type PersistedResolvedProfile,
  type ProfileKey,
  type ProfileResolution,
  type SpawnAgentInput,
} from '@/features/sub_agents/model.js'
import { SubagentOrchestrator, SubagentOrchestratorLive, WORKER_ENTRYPOINT } from '@/features/sub_agents/orchestrator.js'
import { ChildProcess, ProcessError, type RunningChild, type SpawnRequest, type TerminationResult } from '@/features/sub_agents/process.js'
import {
  ArtifactTooLargeError,
  NotificationSink,
  ProfileResolver,
  StoreError,
  SubagentStore,
  type LaunchLease,
  type ProcessIdentity,
  type SubagentRecord,
  type SubagentStoreApi,
} from '@/features/sub_agents/store.js'
import { AgentActivity } from '@/shared/effect/app_services.js'
import { bunFileSystem, bunPath } from '@/shared/effect/bun_services.js'
import { type RunningAgent } from '@/shared/state/agent_activity.js'

const admission: AdmissionSnapshot = {
  agent_dir: '/agents',
  child_model_view: { authenticated_providers: ['provider'], models: [{ contextWindow: 1, model: 'model', provider: 'provider' }] },
  cwd: '/work',
  environment: {},
  project_trusted: true,
  registered_tools: [],
}
const request = (task_name: string, agent_type: ProfileKey = 'scout', run_in_background = true): SpawnAgentInput => ({
  agent_type,
  message: 'do it',
  run_in_background,
  task_name,
})
const ready = (child: ChildControl, agentId: string, sessionPath: string, turn = 1): Effect.Effect<void> =>
  child.emit(bytes({ agent_id: agentId, command_id: 'initial', session_path: sessionPath, turn, type: 'ready' }))
const completed = (child: ChildControl, agentId: string, conclusion = 'done', turn = 1, contextTokens = 100): Effect.Effect<void> =>
  child.emit(
    bytes({ agent_id: agentId, command_id: 'initial', conclusion, context_tokens: contextTokens, status: 'completed', turn, type: 'result' })
  )
const steerAck = (child: ChildControl, agentId: string, commandId = 'steer'): Effect.Effect<void> =>
  child.emit(bytes({ agent_id: agentId, command_id: commandId, turn: 1, type: 'steer_ack' }))

const profile = (key: ProfileKey): PersistedResolvedProfile => ({
  contextCeiling: 1,
  key,
  model: 'model',
  prompt: 'prompt',
  provider: 'provider',
  tools: [],
})
const bytes = (value: Readonly<Record<string, string | number>>): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`)
const frameAgentId = (frame: string | undefined): string | undefined =>
  frame === undefined ? undefined : /"agent_id":"(?<agentId>[^"]+)"/.exec(frame)?.groups?.agentId

interface ChildControl {
  readonly child: RunningChild
  readonly emit: (value: Uint8Array | undefined) => Effect.Effect<void>
  readonly exit: Effect.Effect<void>
  readonly failStdout: Effect.Effect<void>
  readonly writes: () => readonly string[]
}
interface HarnessOptions {
  readonly closeExits?: boolean
  readonly contextCeiling?: number
  readonly createLeaseFails?: boolean
  readonly createLogFails?: boolean
  readonly createSessionFails?: boolean
  readonly failResumeWriteOnce?: boolean
  readonly gateSpawnCompletion?: boolean
  readonly failResumeLog?: boolean
  readonly deleteFails?: boolean
  readonly gateReplaceRecord?: boolean
  readonly gateResolveAt?: number
  readonly gateTermination?: boolean
  readonly leases?: readonly { readonly agentId: string; readonly lease: LaunchLease }[]
  readonly gateNotifications?: boolean
  readonly liveOwners?: readonly ProcessIdentity[]
  readonly maxOutputTokens?: number
  readonly initializeFailures?: number
  readonly notificationFails?: boolean
  readonly profiles?: readonly ProfileKey[]
  readonly removeLeaseFails?: boolean
  readonly readArtifactError?: ArtifactTooLargeError | StoreError
  readonly records?: readonly { readonly agentId: string; readonly record: SubagentRecord }[]
  readonly replaceRecordFails?: boolean
  readonly replaceRecordFailures?: readonly number[]
  readonly replaceRecordPostCommitFailures?: readonly number[]
  readonly termination?: readonly TerminationResult[]
}
const harness = (root: string, options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const children: ChildControl[] = []
    const publishedActivity: RunningAgent[] = []
    const records: SubagentRecord[] = []
    const recordsByAgent = new Map<string, SubagentRecord>()
    const replaceGate = yield* Deferred.make<void>()
    const terminationGate = yield* Deferred.make<void>()
    const spawnCompletionGate = yield* Deferred.make<void>()
    const resolveGate = yield* Deferred.make<void>()
    let deletes = 0
    let logCreates = 0
    let logRemovals = 0
    let resumeWriteFailures = options.failResumeWriteOnce === true ? 1 : 0
    let forceCalls = 0
    let initializeFailures = options.initializeFailures ?? 0
    let initializes = 0
    let leaseCreates = 0
    let leaseRemovals = 0
    const notifications: (readonly string[])[] = []
    let availableProfiles = options.profiles ?? []
    const notificationGate = yield* Deferred.make<void>()
    let pruneCalls = 0
    let releases = 0
    let replaceRecordCalls = 0
    let resolveCalls = 0
    let spawnCalls = 0
    const spawnRequests: SpawnRequest[] = []
    const store: SubagentStoreApi = {
      artifactPath: (_agentId: string, name: string) => Effect.succeed(name),
      createLease: (_agentId: string, _lease: LaunchLease) =>
        Effect.sync(() => {
          leaseCreates += 1
        }).pipe(
          Effect.andThen(
            options.createLeaseFails === true
              ? Effect.fail(new StoreError({ cause: 'lease unavailable', message: 'lease unavailable' }))
              : Effect.void
          )
        ),
      createLog: (agentId: string, _turn: number) =>
        Effect.gen(function* () {
          logCreates += 1
          if (options.createLogFails === true || (options.failResumeLog === true && _turn === 2)) {
            return yield* new StoreError({ cause: 'log unavailable', message: 'log unavailable' })
          }
          return bunPath.join(root, `${agentId}-${_turn}-${logCreates}.log`)
        }),
      createSession: (_agentId: string) =>
        options.createSessionFails === true
          ? Effect.fail(new StoreError({ cause: 'session unavailable', message: 'session unavailable' }))
          : Effect.succeed({ runDirectory: root, sessionPath: bunPath.join(root, 'session.json') }),
      delete: (_agentId: string) =>
        Effect.sync(() => {
          deletes += 1
          recordsByAgent.delete(_agentId)
        }).pipe(
          Effect.andThen(
            options.deleteFails === true ? Effect.fail(new StoreError({ cause: 'delete unavailable', message: 'delete unavailable' })) : Effect.void
          )
        ),
      initialize: Effect.suspend(() => {
        initializes += 1
        if (initializeFailures === 0) {
          return Effect.void
        }
        initializeFailures -= 1
        return Effect.fail(new StoreError({ cause: 'initialize unavailable', message: 'initialize unavailable' }))
      }),
      listLeases: Effect.succeed(options.leases ?? []),
      listRecords: Effect.succeed(options.records ?? []),
      prune: (_now: number) =>
        Effect.sync(() => {
          pruneCalls += 1
        }),
      readArtifact: (_agentId: string, _name: string, _maxBytes: number) =>
        options.readArtifactError === undefined ? Effect.succeed(new Uint8Array()) : Effect.fail(options.readArtifactError),
      readRecord: (agentId: string) => Effect.sync(() => recordsByAgent.get(agentId)),
      removeLease: (_agentId: string) =>
        Effect.sync(() => {
          leaseRemovals += 1
        }).pipe(
          Effect.andThen(
            options.removeLeaseFails === true
              ? Effect.fail(new StoreError({ cause: 'lease unavailable', message: 'lease unavailable' }))
              : Effect.void
          )
        ),
      removeLog: (_agentId: string, _path: string) =>
        Effect.sync(() => {
          logRemovals += 1
        }),
      replaceRecord: (_agentId: string, record: SubagentRecord) =>
        (options.gateReplaceRecord === true ? Deferred.await(replaceGate) : Effect.void).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              replaceRecordCalls += 1
              const commit = Effect.sync(() => {
                records.push(record)
                recordsByAgent.set(_agentId, record)
              })
              if (options.replaceRecordFails === true || options.replaceRecordFailures?.includes(replaceRecordCalls) === true) {
                return Effect.fail(new StoreError({ cause: 'record unavailable', message: 'record unavailable' }))
              }
              return options.replaceRecordPostCommitFailures?.includes(replaceRecordCalls) === true
                ? commit.pipe(Effect.andThen(Effect.fail(new StoreError({ cause: 'lease unavailable', message: 'lease unavailable' }))))
                : commit
            })
          )
        ),
      writeFullResult: (_agentId: string, _content: Uint8Array) => Effect.succeed('result'),
    }
    const process = {
      currentIdentity: Effect.succeed({ birthMarker: 'parent-birth', pid: 99 }),
      interruptVerified: (_child: RunningChild, _interruptFrame: string) => Effect.suspend(() => Effect.void),
      isIdentityAlive: (identity: ProcessIdentity) =>
        Effect.succeed((options.liveOwners ?? []).some((owner) => owner.pid === identity.pid && owner.birthMarker === identity.birthMarker)),
      spawn: (spawnRequest: SpawnRequest) =>
        Effect.gen(function* () {
          spawnCalls += 1
          spawnRequests.push(spawnRequest)
          const alive = yield* Ref.make(true)
          const exited = yield* Deferred.make<void>()
          const stdout = yield* Queue.unbounded<Uint8Array | undefined | 'failure'>()
          const writes: string[] = []
          const child: RunningChild = {
            closeInput:
              options.closeExits === true
                ? Ref.set(alive, false).pipe(Effect.andThen(Deferred.succeed(exited, undefined)), Effect.asVoid)
                : Effect.void,
            identity: { birthMarker: `birth-${spawnCalls}`, pid: spawnCalls },
            isAlive: Ref.get(alive),
            readStdout: Queue.take(stdout).pipe(
              Effect.flatMap((value) =>
                value === 'failure' ? Effect.fail(new ProcessError({ cause: 'stdout failed', message: 'stdout failed' })) : Effect.succeed(value)
              )
            ),
            release: Effect.sync(() => {
              releases += 1
            }),
            wait: Deferred.await(exited).pipe(Effect.as(0)),
            write: (frame: string) =>
              Effect.sync(() => {
                if (spawnCalls > 1 && resumeWriteFailures > 0) {
                  resumeWriteFailures -= 1
                  throw new ProcessError({ cause: 'write unavailable', message: 'write unavailable' })
                }
                writes.push(frame)
              }),
          }
          children.push({
            child,
            emit: (value) => {
              if (value === undefined) {
                return Queue.offer(stdout, value)
              }
              const expected = writes.map(frameAgentId).find((agentId) => agentId !== undefined) ?? 'agent-1'
              const text = new TextDecoder().decode(value)
              return Queue.offer(stdout, new TextEncoder().encode(text.replaceAll(/"agent_id":"agent-\d+"/g, `"agent_id":"${expected}"`)))
            },
            exit: Ref.set(alive, false).pipe(Effect.andThen(Deferred.succeed(exited, undefined)), Effect.asVoid),
            failStdout: Queue.offer(stdout, 'failure'),
            writes: () => writes,
          })
          yield* options.gateSpawnCompletion === true ? Deferred.await(spawnCompletionGate) : Effect.void
          return child
        }),
      terminateVerified: (_identity: ProcessIdentity) =>
        (options.gateTermination === true ? Deferred.await(terminationGate) : Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              forceCalls += 1
              return options.termination?.[forceCalls - 1] ?? ('stillAlive' as const)
            })
          )
        ),
    }
    const resolver = {
      resolve: (key: string, _snapshot: AdmissionSnapshot) => {
        const resolved = availableProfiles.find((profileKey) => profileKey === key)
        const value: Effect.Effect<ProfileResolution> =
          resolved === undefined
            ? Effect.succeed({ error: { code: 'unknown_profile' as const, message: 'unknown' }, ok: false as const })
            : Effect.succeed(
                options.maxOutputTokens === undefined
                  ? { ok: true as const, profile: { ...profile(resolved), contextCeiling: options.contextCeiling ?? 1 } }
                  : {
                      maxOutputTokens: options.maxOutputTokens,
                      ok: true as const,
                      profile: { ...profile(resolved), contextCeiling: options.contextCeiling ?? 1 },
                    }
              )
        return Effect.sync(() => {
          resolveCalls += 1
          return options.gateResolveAt === resolveCalls
        }).pipe(Effect.flatMap((gate) => (gate ? Deferred.await(resolveGate).pipe(Effect.andThen(value)) : value)))
      },
    }
    yield* bunFileSystem.writeFileString(bunPath.join(root, 'session.json'), '{}')
    yield* bunFileSystem.chmod(bunPath.join(root, 'session.json'), 0o600)
    const dependencies = Layer.mergeAll(
      Layer.succeed(SubagentStore)(store),
      Layer.succeed(NotificationSink)({
        publish: (messages: readonly string[]) =>
          (options.gateNotifications === true ? Deferred.await(notificationGate) : Effect.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                notifications.push(messages)
              })
            ),
            Effect.andThen(options.notificationFails === true ? Effect.die('notification unavailable') : Effect.void)
          ),
      }),
      Layer.succeed(ProfileResolver)(resolver),
      Layer.succeed(ChildProcess)(process),
      Layer.succeed(AgentActivity)({
        list: () => publishedActivity,
        publish: (agents) =>
          Effect.sync(() => {
            publishedActivity.splice(0, publishedActivity.length, ...agents)
          }),
        subscribe: () => () => undefined,
      })
    )
    return {
      activity: () => publishedActivity,
      addProfile: (key: ProfileKey) => {
        availableProfiles = [...availableProfiles, key]
      },
      children,
      deletes: () => deletes,
      forceCalls: () => forceCalls,
      initializes: () => initializes,
      layer: SubagentOrchestratorLive.pipe(Layer.provide(dependencies)),
      leaseCreates: () => leaseCreates,
      leaseRemovals: () => leaseRemovals,
      logCreates: () => logCreates,
      logRemovals: () => logRemovals,
      notifications: () => notifications,
      pruneCalls: () => pruneCalls,
      records: () => records,
      releaseNotifications: Deferred.succeed(notificationGate, undefined).pipe(Effect.asVoid),
      releaseReplaceRecord: Deferred.succeed(replaceGate, undefined).pipe(Effect.asVoid),
      releaseResolve: Deferred.succeed(resolveGate, undefined).pipe(Effect.asVoid),
      releaseSpawnCompletion: Deferred.succeed(spawnCompletionGate, undefined).pipe(Effect.asVoid),
      releaseTermination: Deferred.succeed(terminationGate, undefined).pipe(Effect.asVoid),
      releases: () => releases,
      removeProfile: (key: ProfileKey) => {
        availableProfiles = availableProfiles.filter((profileKey) => profileKey !== key)
      },
      spawnCalls: () => spawnCalls,
      spawnRequests: () => spawnRequests,
    }
  })

describe('SubagentOrchestrator', () => {
  it.scoped('shares initialization and resolves cheap profile failures before a claim', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-' }).pipe(Effect.flatMap((path) => bunFileSystem.realPath(path)))
      const fake = yield* harness(root)
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* Effect.all([orchestrator.initialize, orchestrator.initialize], { concurrency: 'unbounded' })
          expect(fake.pruneCalls()).toBe(1)
          yield* orchestrator.openSession('one')
          const failed = yield* Effect.exit(orchestrator.spawn('one', admission, request('task')))
          expect(failed._tag).toBe('Failure')
          expect(fake.spawnCalls()).toBe(0)
        }),
        fake.layer
      )
    })
  )

  it.scoped('retries initialization after the owner fails', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-initialize-retry-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { initializeFailures: 1 })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          expect((yield* Effect.exit(orchestrator.initialize))._tag).toBe('Failure')
          yield* orchestrator.initialize
          expect(fake.initializes()).toBe(2)
          expect(fake.pruneCalls()).toBe(1)
        }),
        fake.layer
      )
    })
  )

  it.scoped('releases a pre-launch claim when setup fails', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-' }).pipe(Effect.flatMap((path) => bunFileSystem.realPath(path)))
      const fake = yield* harness(root, { createSessionFails: true, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('one')
          yield* Effect.exit(orchestrator.spawn('one', admission, request('same')))
          const second = yield* Effect.exit(orchestrator.spawn('one', admission, request('same')))
          expect(second._tag).toBe('Failure')
          if (second._tag === 'Failure') {
            expect(second.cause.toString()).not.toContain('duplicate_task_name')
          }
          expect(fake.deletes()).toBe(2)
          expect(fake.spawnCalls()).toBe(0)
        }),
        fake.layer
      )
    })
  )

  it.scoped('rejects an oversized task frame before creating fresh artifacts', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('one')
          const result = yield* Effect.exit(orchestrator.spawn('one', admission, { ...request('large'), message: 'x'.repeat(1024 * 1024) }))
          expect(result._tag).toBe('Failure')
          expect(fake.logCreates()).toBe(0)
          expect(fake.deletes()).toBe(0)
          expect(fake.spawnCalls()).toBe(0)
        }),
        fake.layer
      )
    })
  )

  it.scoped('commits no record before ready and enforces the virtual thirty-second startup bound', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-' }).pipe(Effect.flatMap((path) => bunFileSystem.realPath(path)))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('one')
          const fiber = yield* Effect.forkChild(orchestrator.spawn('one', admission, request('slow')))
          yield* TestClock.adjust('1 millis')
          expect(fake.records()).toHaveLength(0)
          yield* TestClock.adjust('30 seconds')
          const result = yield* Effect.exit(Fiber.join(fiber))
          expect(result._tag).toBe('Failure')
          expect(fake.records()).toHaveLength(0)
        }),
        fake.layer
      )
    })
  )

  it.scoped('publishes only ready current-session activity and removes it on settlement and close', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-activity-' })
        .pipe(Effect.flatMap((path) => bunFileSystem.realPath(path)))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('one')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('one', admission, request('visible')))
          yield* TestClock.adjust('1 millis')
          expect(fake.activity()).toEqual([])
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          expect(fake.activity()).toHaveLength(1)
          expect(fake.activity()[0]?.sessionId).toBe('one')
          yield* completed(fake.children[0], 'agent-1')
          yield* orchestrator.waitOne('one', ['visible'])
          expect(fake.activity()).toEqual([])
          yield* fake.children[0].exit
          yield* TestClock.adjust('1 millis')

          const again = yield* Effect.forkChild(orchestrator.spawn('one', admission, request('close-visible')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[1], 'agent-2', bunPath.join(root, 'session.json'))
          yield* Fiber.join(again)
          expect(fake.activity()).toHaveLength(1)
          yield* fake.children[1].exit
          yield* orchestrator.closeSession('one')
          expect(fake.activity()).toEqual([])
        }),
        fake.layer
      )
    })
  )

  it.scoped('reassembles split frames and settles malformed correlation as a protocol failure', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-' }).pipe(Effect.flatMap((path) => bunFileSystem.realPath(path)))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('one')
          const spawned = yield* Effect.forkChild(orchestrator.spawn('one', admission, request('good')))
          yield* TestClock.adjust('1 millis')
          const [good] = fake.children
          const goodAgentId = frameAgentId(good.writes()[0]) ?? 'missing'
          yield* good.emit(
            bytes({ agent_id: goodAgentId, command_id: 'initial', session_path: bunPath.join(root, 'session.json'), turn: 1, type: 'ready' })
          )
          yield* Fiber.join(spawned)
          const result = bytes({ agent_id: goodAgentId, command_id: 'initial', conclusion: 'done', status: 'completed', turn: 1, type: 'result' })
          yield* good.emit(result.slice(0, 12))
          yield* good.emit(result.slice(12))
          expect((yield* orchestrator.waitOne('one', ['good'])).status).toBe('completed')

          const badSpawn = yield* Effect.forkChild(orchestrator.spawn('one', admission, request('bad')))
          yield* TestClock.adjust('1 millis')
          const [, bad] = fake.children
          yield* bad.emit(
            bytes({ agent_id: 'agent-2', command_id: 'initial', session_path: bunPath.join(root, 'session.json'), turn: 1, type: 'ready' })
          )
          yield* Fiber.join(badSpawn)
          yield* bad.emit(bytes({ activity: 'agent_started', agent_id: 'other', command_id: 'initial', turn: 1, type: 'progress' }))
          const settled = yield* orchestrator.waitOne('one', ['bad'])
          expect(settled.status).toBe('failed')
          expect('error' in settled ? settled.error.code : '').toBe('protocol_error')
        }),
        fake.layer
      )
    })
  )

  it.scoped('rejects symlinked, non-regular, and escaping ready session paths', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-path-' })
        .pipe(Effect.flatMap((path) => bunFileSystem.realPath(path)))
      const outside = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-outside-' })
      const regular = bunPath.join(root, 'regular.json')
      const linked = bunPath.join(root, 'linked.json')
      const directory = bunPath.join(root, 'directory')
      const escaping = bunPath.join(outside, 'escaping.json')
      yield* bunFileSystem.writeFileString(regular, '{}')
      yield* bunFileSystem.writeFileString(escaping, '{}')
      yield* bunFileSystem.chmod(regular, 0o600)
      yield* bunFileSystem.chmod(escaping, 0o600)
      yield* bunFileSystem.symlink(regular, linked)
      yield* bunFileSystem.makeDirectory(directory)
      yield* bunFileSystem.chmod(directory, 0o700)
      for (const [index, path] of [linked, directory, escaping].entries()) {
        const fake = yield* harness(root, { profiles: ['scout'] })
        yield* Effect.provide(
          Effect.gen(function* () {
            const orchestrator = yield* SubagentOrchestrator
            yield* orchestrator.openSession(`path-${index}`)
            const spawning = yield* Effect.forkChild(orchestrator.spawn(`path-${index}`, admission, request(`path-${index}`)))
            yield* TestClock.adjust('1 millis')
            const [child] = fake.children
            yield* ready(child, 'agent-1', path)
            const result = yield* Effect.exit(Fiber.join(spawning))
            expect(result._tag).toBe('Failure')
            expect(fake.records()).toHaveLength(0)
          }),
          fake.layer
        )
      }
    })
  )

  it.scoped('settles stdout EOF and failures after readiness', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-stdout-' })
        .pipe(Effect.flatMap((path) => bunFileSystem.realPath(path)))
      for (const [index, fail] of [false, true].entries()) {
        const fake = yield* harness(root, { profiles: ['scout'] })
        yield* Effect.provide(
          Effect.gen(function* () {
            const orchestrator = yield* SubagentOrchestrator
            const session = `stdout-${index}`
            yield* orchestrator.openSession(session)
            const spawning = yield* Effect.forkChild(orchestrator.spawn(session, admission, request('worker')))
            yield* TestClock.adjust('1 millis')
            const [child] = fake.children
            yield* ready(child, 'agent-1', bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
            yield* fail ? child.failStdout : child.emit(undefined)
            yield* TestClock.adjust('1 millis')
            yield* TestClock.adjust('5 seconds')
            const settled = yield* orchestrator.waitOne(session, ['worker'])
            expect(settled.status).toBe('failed')
          }),
          fake.layer
        )
      }
    })
  )

  it.scoped('enforces capacity, implementer, and case-sensitive admission claims', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-admission-' })
        .pipe(Effect.flatMap((path) => bunFileSystem.realPath(path)))
      const fake = yield* harness(root, { profiles: ['implementer', 'scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('admission')
          for (const [index, name] of ['One', 'two', 'three'].entries()) {
            const spawning = yield* Effect.forkChild(orchestrator.spawn('admission', admission, request(name)))
            yield* TestClock.adjust('1 millis')
            yield* ready(fake.children[index], `agent-${index + 1}`, bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
          }
          const full = yield* Effect.exit(orchestrator.spawn('admission', admission, request('four')))
          expect(full._tag).toBe('Failure')

          yield* orchestrator.openSession('implementers')
          const first = yield* Effect.forkChild(orchestrator.spawn('implementers', admission, request('build', 'implementer')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[3], 'agent-4', bunPath.join(root, 'session.json'))
          yield* Fiber.join(first)
          const second = yield* Effect.exit(orchestrator.spawn('implementers', admission, request('build-more', 'implementer')))
          expect(second._tag).toBe('Failure')

          yield* orchestrator.openSession('names')
          const upper = yield* Effect.forkChild(orchestrator.spawn('names', admission, request('Same')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[4], 'agent-5', bunPath.join(root, 'session.json'))
          yield* Fiber.join(upper)
          const lower = yield* Effect.forkChild(orchestrator.spawn('names', admission, request('same')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[5], 'agent-6', bunPath.join(root, 'session.json'))
          yield* Fiber.join(lower)
          const duplicate = yield* Effect.exit(orchestrator.spawn('names', admission, request('Same')))
          expect(duplicate._tag).toBe('Failure')
        }),
        fake.layer
      )
    })
  )

  it.scoped('serializes concurrent capacity and implementer admission races at one claim', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-concurrent-admission-' })
        .pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['implementer', 'scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('capacity-race')
          const capacity = yield* Effect.forEach(['one', 'two', 'three', 'four'], (name) =>
            Effect.forkChild(orchestrator.spawn('capacity-race', admission, request(name)))
          )
          yield* TestClock.adjust('1 millis')
          expect(fake.children).toHaveLength(3)
          for (const [index, fiber] of capacity.entries()) {
            if (index < 3) {
              yield* ready(fake.children[index], `agent-${index + 1}`, bunPath.join(root, 'session.json'))
              yield* Fiber.join(fiber)
            } else {
              expect((yield* Fiber.join(fiber).pipe(Effect.exit))._tag).toBe('Failure')
            }
          }
          yield* orchestrator.openSession('implementer-race')
          const implementers = yield* Effect.forEach(['first', 'second'], (name) =>
            Effect.forkChild(orchestrator.spawn('implementer-race', admission, request(name, 'implementer')))
          )
          yield* TestClock.adjust('1 millis')
          expect(fake.children).toHaveLength(4)
          yield* ready(fake.children[3], 'agent-4', bunPath.join(root, 'session.json'))
          const outcomes = yield* Effect.all(implementers.map((fiber) => Fiber.join(fiber).pipe(Effect.exit)))
          expect(outcomes.filter((outcome) => outcome._tag === 'Success')).toHaveLength(1)
          expect(outcomes.filter((outcome) => outcome._tag === 'Failure')).toHaveLength(1)
        }),
        fake.layer
      )
    })
  )

  it.scoped('keeps inactive agents running and expires the dispatch deadline through the virtual clock', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-timers-' })
        .pipe(Effect.flatMap((path) => bunFileSystem.realPath(path)))
      for (const [index, duration] of [
        [0, '5 minutes'],
        [1, '30 minutes'],
      ] as const) {
        const fake = yield* harness(root, { profiles: ['scout'] })
        yield* Effect.provide(
          Effect.gen(function* () {
            const orchestrator = yield* SubagentOrchestrator
            const session = `timer-${index}`
            yield* orchestrator.openSession(session)
            const spawning = yield* Effect.forkChild(orchestrator.spawn(session, admission, request('worker')))
            yield* TestClock.adjust('1 millis')
            yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
            yield* TestClock.adjust(duration)
            if (index === 0) {
              expect((yield* orchestrator.list(session))[0]?.status).toBe('running')
              yield* fake.children[0].emit(
                bytes({ agent_id: 'agent-1', command_id: 'initial', conclusion: 'done', status: 'completed', turn: 1, type: 'result' })
              )
              expect((yield* orchestrator.waitOne(session, ['worker'])).status).toBe('completed')
            } else {
              const settled = yield* orchestrator.waitOne(session, ['worker'])
              expect('error' in settled ? settled.error.code : '').toBe('turn_timeout')
            }
          }),
          fake.layer
        )
      }
    })
  )

  it.scoped('uses five virtual seconds of cooperative grace before forced termination', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-' }).pipe(Effect.flatMap((path) => bunFileSystem.realPath(path)))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('one')
          const spawned = yield* Effect.forkChild(orchestrator.spawn('one', admission, request('stop')))
          yield* TestClock.adjust('1 millis')
          const [child] = fake.children
          yield* child.emit(
            bytes({ agent_id: 'agent-1', command_id: 'initial', session_path: bunPath.join(root, 'session.json'), turn: 1, type: 'ready' })
          )
          yield* Fiber.join(spawned)
          const interrupted = yield* Effect.forkChild(orchestrator.interrupt('one', 'stop'))
          yield* TestClock.adjust('1 millis')
          expect(fake.forceCalls()).toBe(0)
          yield* TestClock.adjust('5 seconds')
          yield* Fiber.join(interrupted)
          expect(fake.forceCalls()).toBe(1)
        }),
        fake.layer
      )
    })
  )

  it.scoped('retains pre-ready and cancelled workers until identity verification releases their leases', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-cleanup-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const outcomes: readonly TerminationResult[] = ['exited', 'mismatch']
      for (const [index, outcome] of outcomes.entries()) {
        const fake = yield* harness(root, { profiles: ['scout'], termination: ['stillAlive', outcome] })
        yield* Effect.provide(
          Effect.gen(function* () {
            const orchestrator = yield* SubagentOrchestrator
            const session = `cleanup-${index}`
            yield* orchestrator.openSession(session)
            const spawning = yield* Effect.forkChild(orchestrator.spawn(session, admission, request('worker')))
            yield* TestClock.adjust('1 millis')
            const [child] = fake.children
            yield* child.emit(undefined)
            yield* Fiber.join(spawning).pipe(Effect.exit)
            expect(fake.releases()).toBe(0)
            yield* child.exit
            yield* Effect.yieldNow
            expect(fake.leaseRemovals()).toBe(1)
            expect(fake.releases()).toBe(1)
          }),
          fake.layer
        )
      }
    })
  )

  it.scoped('keeps an unverifiable cleanup reservation across a replacement generation', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-retained-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'], termination: ['unverifiable'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('same')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('same', admission, request('old')))
          yield* TestClock.adjust('1 millis')
          const [old] = fake.children
          yield* old.emit(undefined)
          yield* Fiber.join(spawning).pipe(Effect.exit)
          yield* orchestrator.closeSession('same').pipe(Effect.exit)
          yield* orchestrator.openSession('same')
          for (const [index, name] of ['one', 'two'].entries()) {
            const next = yield* Effect.forkChild(orchestrator.spawn('same', admission, request(name)))
            yield* TestClock.adjust('1 millis')
            yield* ready(fake.children[index + 1], `agent-${index + 2}`, bunPath.join(root, 'session.json'))
            yield* Fiber.join(next)
          }
          const full = yield* Effect.exit(orchestrator.spawn('same', admission, request('three')))
          expect(full._tag).toBe('Failure')
          expect(fake.forceCalls()).toBe(1)
          expect(fake.releases()).toBe(0)
        }),
        fake.layer
      )
    })
  )

  it.scoped('settles storage failures as agent_failed and routine failures as durable values', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-settlement-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      for (const [index, replaceRecordFails] of [false, true].entries()) {
        const fake = yield* harness(root, { profiles: ['scout'], replaceRecordFails })
        yield* Effect.provide(
          Effect.gen(function* () {
            const orchestrator = yield* SubagentOrchestrator
            const session = `settlement-${index}`
            yield* orchestrator.openSession(session)
            const spawning = yield* Effect.forkChild(orchestrator.spawn(session, admission, request('worker')))
            yield* TestClock.adjust('1 millis')
            const [child] = fake.children
            if (replaceRecordFails) {
              yield* ready(child, 'agent-1', bunPath.join(root, 'session.json'))
              const failed = yield* Fiber.join(spawning).pipe(Effect.exit)
              expect(failed._tag).toBe('Failure')
            } else {
              yield* ready(child, 'agent-1', bunPath.join(root, 'session.json'))
              yield* Fiber.join(spawning)
              yield* child.failStdout
              const settled = yield* orchestrator.waitOne(session, ['worker'])
              expect(settled.status).toBe('failed')
              expect('error' in settled ? settled.error.code : '').toBe('agent_failed')
            }
          }),
          fake.layer
        )
      }
    })
  )

  it.scoped('persists a failed result when writing the original terminal result fails', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-settlement-fallback-' })
        .pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'], replaceRecordFailures: [2] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('settlement-fallback')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('settlement-fallback', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          const [child] = fake.children
          yield* ready(child, 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          yield* completed(child, 'agent-1')
          const settled = yield* orchestrator.waitOne('settlement-fallback', ['worker'])
          expect(settled.status).toBe('failed')
          expect('error' in settled ? settled.error.code : '').toBe('agent_failed')
          expect(fake.records().at(-1)?.status).toBe('failed')
          expect((yield* orchestrator.list('settlement-fallback'))[0]?.status).toBe('failed')
        }),
        fake.layer
      )
    })
  )

  it.scoped('preserves a committed terminal result when lease cleanup reports failure', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-settlement-committed-' })
        .pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'], replaceRecordPostCommitFailures: [2] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('settlement-committed')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('settlement-committed', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          const [child] = fake.children
          yield* ready(child, 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          yield* completed(child, 'agent-1', 'original')
          const settled = yield* orchestrator.waitOne('settlement-committed', ['worker'])
          expect(settled).toEqual({ conclusion: 'original', status: 'completed', task_name: 'worker', turn: 1 })
          expect(fake.records().at(-1)?.status).toBe('completed')
        }),
        fake.layer
      )
    })
  )

  it.scoped('does not retain a running agent when terminal persistence remains unavailable', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-settlement-unavailable-' })
        .pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { closeExits: true, profiles: ['scout'], replaceRecordFailures: [2, 3] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('settlement-unavailable')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('settlement-unavailable', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          const [child] = fake.children
          yield* ready(child, 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          yield* completed(child, 'agent-1')
          expect((yield* Effect.exit(orchestrator.waitOne('settlement-unavailable', ['worker'])))._tag).toBe('Failure')
          expect((yield* orchestrator.list('settlement-unavailable'))[0]?.status).toBe('failed')
          expect((yield* orchestrator.read('settlement-unavailable', 'worker')).status).toBe('failed')
          yield* orchestrator.closeSession('settlement-unavailable')
          yield* orchestrator.openSession('settlement-unavailable')
          expect(yield* orchestrator.list('settlement-unavailable')).toEqual([])
        }),
        fake.layer
      )
    })
  )

  it.scoped('classifies oversized worker frames before and after readiness', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-oversized-frame-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { closeExits: true, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('oversized')
          const beforeReady = yield* Effect.forkChild(orchestrator.spawn('oversized', admission, request('before-ready')))
          yield* TestClock.adjust('1 millis')
          yield* fake.children[0].emit(new Uint8Array(1024 * 1024 + 1))
          const startupCode = yield* Fiber.join(beforeReady).pipe(
            Effect.match({ onFailure: (error) => (error._tag === 'PublicRefusalError' ? error.code : 'lifecycle'), onSuccess: () => 'accepted' })
          )
          expect(startupCode).toBe('frame_too_large')

          const afterReady = yield* Effect.forkChild(orchestrator.spawn('oversized', admission, request('after-ready')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[1], 'agent-2', bunPath.join(root, 'session.json'))
          yield* Fiber.join(afterReady)
          yield* fake.children[1].emit(new Uint8Array(1024 * 1024 + 1))
          const settled = yield* orchestrator.waitOne('oversized', ['after-ready'])
          expect('error' in settled ? settled.error.code : '').toBe('frame_too_large')

          const coalesced = yield* Effect.forkChild(orchestrator.spawn('oversized', admission, request('coalesced')))
          yield* TestClock.adjust('1 millis')
          const readyFrame = bytes({
            agent_id: 'agent-3',
            command_id: 'initial',
            session_path: bunPath.join(root, 'session.json'),
            turn: 1,
            type: 'ready',
          })
          const combined = new Uint8Array(readyFrame.byteLength + 1024 * 1024 + 1)
          combined.set(readyFrame)
          yield* fake.children[2].emit(combined)
          yield* Fiber.join(coalesced)
          const coalescedResult = yield* orchestrator.waitOne('oversized', ['coalesced'])
          expect('error' in coalescedResult ? coalescedResult.error.code : '').toBe('frame_too_large')

          const invalid = yield* Effect.forkChild(orchestrator.spawn('oversized', admission, request('coalesced-invalid')))
          yield* TestClock.adjust('1 millis')
          const invalidReady = bytes({
            agent_id: 'agent-4',
            command_id: 'initial',
            session_path: bunPath.join(root, 'session.json'),
            turn: 1,
            type: 'ready',
          })
          const malformed = bytes({ agent_id: 'agent-4', command_id: 'initial', turn: 1, type: 'unknown' })
          const invalidCombined = new Uint8Array(invalidReady.byteLength + malformed.byteLength)
          invalidCombined.set(invalidReady)
          invalidCombined.set(malformed, invalidReady.byteLength)
          yield* fake.children[3].emit(invalidCombined)
          yield* Fiber.join(invalid)
          const invalidResult = yield* orchestrator.waitOne('oversized', ['coalesced-invalid'])
          expect('error' in invalidResult ? invalidResult.error.code : '').toBe('protocol_error')
        }),
        fake.layer
      )
    })
  )

  it.scoped('drains a delayed result before classifying a fast worker exit', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-fast-exit-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('fast-exit')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('fast-exit', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          const [child] = fake.children
          const sessionPath = bunPath.join(root, 'session.json')
          yield* ready(child, 'agent-1', sessionPath)
          yield* Fiber.join(spawning)
          yield* child.exit
          yield* Effect.yieldNow
          expect((yield* orchestrator.list('fast-exit'))[0]?.status).toBe('running')
          yield* completed(child, 'agent-1')
          expect((yield* orchestrator.waitOne('fast-exit', ['worker'])).status).toBe('completed')
        }),
        fake.layer
      )
    })
  )

  it.scoped('hands a still-live settled worker to cleanup while charging one capacity slot', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-settled-cleanup-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { contextCeiling: 10_000, profiles: ['scout'], termination: ['stillAlive'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('settled-cleanup')
          const source = yield* Effect.forkChild(orchestrator.spawn('settled-cleanup', admission, request('source')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(source)
          yield* completed(fake.children[0], 'agent-1')
          expect((yield* orchestrator.waitOne('settled-cleanup', ['source'])).status).toBe('completed')
          yield* TestClock.adjust('5 seconds')

          for (const [index, name] of ['one', 'two'].entries()) {
            const spawning = yield* Effect.forkChild(orchestrator.spawn('settled-cleanup', admission, request(name)))
            yield* TestClock.adjust('1 millis')
            yield* ready(fake.children[index + 1], `agent-${index + 2}`, bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
          }
          expect((yield* Effect.exit(orchestrator.spawn('settled-cleanup', admission, request('three'))))._tag).toBe('Failure')
          const resumed = yield* Effect.exit(orchestrator.send('settled-cleanup', admission, 'source', 'resume'))
          expect(resumed._tag).toBe('Failure')
          if (resumed._tag === 'Failure') {
            expect(resumed.cause.toString()).toContain('still cleaning up')
          }
          yield* fake.children[0].emit(undefined)
          yield* fake.children[0].exit
          yield* Effect.yieldNow
          expect(fake.releases()).toBe(1)
        }),
        fake.layer
      )
    })
  )

  it.scoped('hands off a child when session close races provisional registration', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-race-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { gateSpawnCompletion: true, profiles: ['scout'], termination: ['stillAlive'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('race')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('race', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          const closing = yield* Effect.forkChild(orchestrator.closeSession('race'))
          yield* Fiber.join(closing)
          yield* fake.releaseSpawnCompletion
          expect((yield* Fiber.join(spawning).pipe(Effect.exit))._tag).toBe('Failure')
          expect(fake.forceCalls()).toBe(1)
          expect(fake.leaseCreates()).toBe(1)
          yield* fake.children[0].exit
          yield* Effect.yieldNow
          expect(fake.releases()).toBe(1)
        }),
        fake.layer
      )
    })
  )

  it.scoped('supervises an unregistered child when durable handoff persistence fails', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-race-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, {
        createLeaseFails: true,
        gateSpawnCompletion: true,
        profiles: ['scout'],
        termination: ['stillAlive'],
      })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('race')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('race', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          yield* orchestrator.closeSession('race')
          yield* fake.releaseSpawnCompletion
          expect((yield* Fiber.join(spawning).pipe(Effect.exit))._tag).toBe('Failure')
          yield* fake.children[0].exit
          yield* Effect.yieldNow
          expect(fake.releases()).toBe(1)
        }),
        fake.layer
      )
    })
  )

  it.scoped('isolates readiness from a concurrent close and releases each claim once', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-race-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { gateReplaceRecord: true, profiles: ['scout'], termination: ['mismatch'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('race')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('race', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          const [child] = fake.children
          yield* ready(child, 'agent-1', bunPath.join(root, 'session.json'))
          const closing = yield* Effect.forkChild(orchestrator.closeSession('race'))
          yield* Effect.yieldNow
          yield* fake.releaseReplaceRecord
          expect((yield* Fiber.join(spawning).pipe(Effect.exit))._tag).toBe('Success')
          yield* TestClock.adjust('5 seconds')
          yield* Fiber.join(closing)
          expect(fake.releases()).toBe(1)
        }),
        fake.layer
      )
    })
  )

  it.scoped('closes live generations when the service layer is disposed', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-dispose-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { closeExits: true, profiles: ['scout'] })
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(fake.layer, scope)
      const orchestrator = Context.get(context, SubagentOrchestrator)
      yield* orchestrator.openSession('dispose')
      const spawning = yield* Effect.forkChild(orchestrator.spawn('dispose', admission, request('worker')))
      yield* TestClock.adjust('1 millis')
      yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
      yield* Fiber.join(spawning)
      yield* Scope.close(scope, Exit.void)
      expect(fake.children).toHaveLength(1)
      expect(fake.forceCalls()).toBe(0)
    })
  )

  it.scoped('gives session close five virtual seconds and releases a racing exit only once', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-close-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'], termination: ['signalled'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('close')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('close', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          const [child] = fake.children
          yield* ready(child, 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          const closing = yield* Effect.forkChild(orchestrator.closeSession('close'))
          yield* TestClock.adjust('1 millis')
          expect(fake.forceCalls()).toBe(0)
          yield* TestClock.adjust('5 seconds')
          yield* child.exit
          yield* Fiber.join(closing)
          expect(fake.forceCalls()).toBe(1)
          expect(fake.releases()).toBe(1)
        }),
        fake.layer
      )
    })
  )

  it.scoped('deletes all mismatch artifacts and leases a worker before cleanup handoff', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-mismatch-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      for (const [index, termination] of [['mismatch'] as const, ['stillAlive'] as const].entries()) {
        const fake = yield* harness(root, { profiles: ['scout'], termination })
        yield* Effect.provide(
          Effect.gen(function* () {
            const orchestrator = yield* SubagentOrchestrator
            const session = `mismatch-${index}`
            yield* orchestrator.openSession(session)
            const spawning = yield* Effect.forkChild(orchestrator.spawn(session, admission, request('worker')))
            yield* TestClock.adjust('1 millis')
            yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
            const closing = yield* Effect.forkChild(orchestrator.closeSession(session))
            yield* TestClock.adjust('5 seconds')
            const closed = yield* Fiber.join(closing).pipe(Effect.exit)
            if (termination[0] === 'mismatch') {
              expect(closed._tag).toBe('Success')
              expect(fake.deletes()).toBe(1)
            } else {
              expect(closed._tag).toBe('Success')
              expect(fake.leaseCreates()).toBe(2)
            }
          }),
          fake.layer
        )
      }
    })
  )

  it.scoped('deletes a resumed provisional mismatch and frees its predecessor task name', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-resumed-provisional-mismatch-' })
        .pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { contextCeiling: 10_000, profiles: ['scout'], termination: ['mismatch'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('resumed-provisional-mismatch')
          const initial = yield* Effect.forkChild(orchestrator.spawn('resumed-provisional-mismatch', admission, request('source', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* completed(fake.children[0], 'agent-1')
          yield* Fiber.join(initial)
          yield* fake.children[0].exit
          yield* Effect.yieldNow
          const resumed = yield* Effect.forkChild(orchestrator.send('resumed-provisional-mismatch', admission, 'source', 'next'))
          yield* TestClock.adjust('1 millis')
          yield* orchestrator.interruptAll('resumed-provisional-mismatch')
          yield* fake.children[1].emit(undefined)
          expect((yield* Fiber.join(resumed).pipe(Effect.exit))._tag).toBe('Failure')
          expect(yield* orchestrator.list('resumed-provisional-mismatch')).toEqual([])
          const replacement = yield* Effect.forkChild(orchestrator.spawn('resumed-provisional-mismatch', admission, request('source')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[2], 'agent-2', bunPath.join(root, 'session.json'))
          yield* Fiber.join(replacement)
          expect((yield* orchestrator.list('resumed-provisional-mismatch'))[0]?.status).toBe('running')
        }),
        fake.layer
      )
    })
  )

  it.scoped('deletes a resumed turn on identity mismatch without signalling it', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-resumed-mismatch-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { contextCeiling: 10_000, profiles: ['scout'], termination: ['mismatch'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('resumed-mismatch')
          const initial = yield* Effect.forkChild(orchestrator.spawn('resumed-mismatch', admission, request('source', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* completed(fake.children[0], 'agent-1')
          yield* Fiber.join(initial)
          yield* fake.children[0].exit
          yield* Effect.yieldNow
          const resumed = yield* Effect.forkChild(orchestrator.send('resumed-mismatch', admission, 'source', 'next'))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[1], 'agent-1', bunPath.join(root, 'session.json'), 2)
          const closing = yield* Effect.forkChild(orchestrator.closeSession('resumed-mismatch'))
          yield* TestClock.adjust('5 seconds')
          yield* Fiber.join(closing)
          yield* Fiber.join(resumed).pipe(Effect.exit)
          expect(fake.deletes()).toBe(1)
          expect(fake.forceCalls()).toBe(1)
          yield* orchestrator.openSession('fresh')
          const replacement = yield* Effect.forkChild(orchestrator.spawn('fresh', admission, request('source')))
          yield* TestClock.adjust('1 millis')
          expect(frameAgentId(fake.children[2].writes()[0])).not.toBe('agent-1')
          yield* ready(fake.children[2], frameAgentId(fake.children[2].writes()[0]) ?? 'missing', bunPath.join(root, 'session.json'))
          yield* completed(fake.children[2], frameAgentId(fake.children[2].writes()[0]) ?? 'missing')
          yield* Fiber.join(replacement)
        }),
        fake.layer
      )
    })
  )

  it.scoped('reconciles persisted runs before pruning and preserves unverifiable ownership', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-reconcile-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const identity = { birthMarker: 'orphan', pid: 91 }
      const record: SubagentRecord = {
        identity,
        logPath: 'orphan.log',
        owner: { birthMarker: 'dead-parent', pid: 90 },
        profile: profile('scout'),
        session: 'orphan',
        sessionPath: 'orphan.json',
        status: 'running',
        taskName: 'orphan',
        turns: [],
      }
      const fake = yield* harness(root, { profiles: ['scout'], records: [{ agentId: 'orphan', record }], termination: ['unverifiable'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.initialize
          expect(fake.forceCalls()).toBe(1)
          expect(fake.deletes()).toBe(0)
          expect(fake.pruneCalls()).toBe(1)
          yield* orchestrator.openSession('orphan')
          for (const [index, name] of ['one', 'two'].entries()) {
            const spawning = yield* Effect.forkChild(orchestrator.spawn('orphan', admission, request(name)))
            yield* Effect.yieldNow
            yield* TestClock.adjust('1 millis')
            yield* ready(fake.children[index], `agent-${index + 1}`, bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
          }
          expect((yield* Effect.exit(orchestrator.spawn('orphan', admission, request('three'))))._tag).toBe('Failure')
        }),
        fake.layer
      )
    })
  )

  it.scoped('does not terminate a child retained by a live owner and leaves legacy ownership fail-safe', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-owner-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const owner = { birthMarker: 'live-parent', pid: 77 }
      const running = (identity: ProcessIdentity, ownerIdentity?: ProcessIdentity): SubagentRecord => {
        const record = {
          identity,
          logPath: 'child.log',
          profile: profile('scout'),
          session: 'owner',
          sessionPath: 'child.json',
          status: 'running' as const,
          taskName: 'child',
          turns: [],
        }
        return ownerIdentity === undefined ? record : { ...record, owner: ownerIdentity }
      }
      const fake = yield* harness(root, {
        liveOwners: [owner],
        records: [
          { agentId: 'live-owner', record: running({ birthMarker: 'child-live', pid: 78 }, owner) },
          { agentId: 'legacy', record: running({ birthMarker: 'child-legacy', pid: 79 }) },
        ],
      })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.initialize
          expect(fake.forceCalls()).toBe(0)
          expect(fake.deletes()).toBe(0)
        }),
        fake.layer
      )
    })
  )

  it.scoped('reaps live orphans and deletes exited, mismatched, record-only, and lease-only artifact sets', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-reap-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const live = { birthMarker: 'live', pid: 11 }
      const exited = { birthMarker: 'exited', pid: 12 }
      const leaseOnly = { birthMarker: 'lease', pid: 13 }
      const mismatchLease = { birthMarker: 'lease-mismatch', pid: 14 }
      const mismatchRecord = { birthMarker: 'record-mismatch', pid: 15 }
      const deadOwner = { birthMarker: 'dead-parent', pid: 90 }
      const running = (identity: { readonly birthMarker: string; readonly pid: number }, taskName: string): SubagentRecord => ({
        identity,
        logPath: `${taskName}.log`,
        owner: deadOwner,
        profile: profile('scout'),
        session: 'reap',
        sessionPath: `${taskName}.json`,
        status: 'running',
        taskName,
        turns: [],
      })
      const fake = yield* harness(root, {
        leases: [
          { agentId: 'live', lease: { identity: live, owner: deadOwner, session: 'reap', taskName: 'live' } },
          { agentId: 'lease-only', lease: { identity: leaseOnly, owner: deadOwner, session: 'reap', taskName: 'lease-only' } },
          { agentId: 'mismatch', lease: { identity: mismatchLease, owner: deadOwner, session: 'reap', taskName: 'mismatch' } },
        ],
        records: [
          { agentId: 'live', record: running(live, 'live') },
          { agentId: 'record-only', record: running(exited, 'record-only') },
          { agentId: 'mismatch', record: running(mismatchRecord, 'mismatch') },
        ],
        termination: ['signalled', 'exited', 'exited', 'mismatch', 'mismatch'],
      })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.initialize
          expect(fake.forceCalls()).toBe(3)
          expect(fake.deletes()).toBe(4)
          expect(fake.pruneCalls()).toBe(1)
        }),
        fake.layer
      )
    })
  )

  it.scoped('uses a real absolute worker entrypoint and classifies oversized artifacts', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-worker-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const tooLarge = new ArtifactTooLargeError({ maxBytes: 10 * 1024 * 1024, message: 'artifact too large' })
      const fake = yield* harness(root, { profiles: ['scout'], readArtifactError: tooLarge })
      yield* Effect.provide(
        Effect.gen(function* () {
          expect(yield* Effect.promise(() => Bun.file(WORKER_ENTRYPOINT).exists())).toBe(true)
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('worker')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('worker', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          const [spawnRequest] = fake.spawnRequests()
          expect([spawnRequest.command, ...spawnRequest.args]).toEqual([Bun.argv[0], WORKER_ENTRYPOINT])
          const [child] = fake.children
          yield* ready(child, 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          yield* child.emit(
            bytes({
              agent_id: 'agent-1',
              command_id: 'initial',
              conclusion_artifact: 'result.txt',
              conclusion_bytes: 50_001,
              conclusion_preview: 'preview',
              status: 'completed',
              turn: 1,
              type: 'result',
            })
          )
          const settled = yield* orchestrator.waitOne('worker', ['worker'])
          expect('error' in settled ? settled.error.code : '').toBe('result_too_large')
        }),
        fake.layer
      )
    })
  )

  it.scoped('reads durable settlements repeatedly, lists them, and preserves explicit wait order', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-reads-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('reads')
          for (const [index, name] of ['first', 'second'].entries()) {
            const spawning = yield* Effect.forkChild(orchestrator.spawn('reads', admission, request(name)))
            yield* TestClock.adjust('1 millis')
            yield* ready(fake.children[index], `agent-${index + 1}`, bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
          }
          yield* fake.children[0].emit(
            bytes({ agent_id: 'agent-1', command_id: 'initial', conclusion: 'one', status: 'completed', turn: 1, type: 'result' })
          )
          yield* fake.children[1].emit(
            bytes({ agent_id: 'agent-2', command_id: 'initial', conclusion: 'two', status: 'completed', turn: 1, type: 'result' })
          )
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          const firstRead = yield* orchestrator.read('reads', 'first')
          const secondRead = yield* orchestrator.read('reads', 'first')
          expect(firstRead).toEqual(secondRead)
          expect(firstRead.turns).toHaveLength(1)
          expect((yield* orchestrator.list('reads')).map((entry) => entry.status)).toEqual(['completed', 'completed'])
          const firstWait = yield* orchestrator.waitAll('reads', ['second', 'first'])
          const secondWait = yield* orchestrator.waitAll('reads', ['second', 'first'])
          expect(firstWait.map((result) => result.task_name)).toEqual(['second', 'first'])
          expect(secondWait).toEqual(firstWait)
        }),
        fake.layer
      )
    })
  )

  it.scoped('validates explicit wait targets atomically and rejects empty omitted snapshots', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-wait-validation-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('validation')
          expect((yield* Effect.exit(orchestrator.waitOne('validation')))._tag).toBe('Failure')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('validation', admission, request('known')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          const duplicate = yield* Effect.exit(orchestrator.waitAll('validation', ['known', 'known']))
          const unknown = yield* Effect.exit(orchestrator.waitAll('validation', ['known', 'missing']))
          expect(duplicate._tag).toBe('Failure')
          expect(unknown._tag).toBe('Failure')
          yield* fake.children[0].emit(
            bytes({ agent_id: 'agent-1', command_id: 'initial', conclusion: 'done', status: 'completed', turn: 1, type: 'result' })
          )
          expect((yield* orchestrator.waitOne('validation', ['known'])).status).toBe('completed')
        }),
        fake.layer
      )
    })
  )

  it.scoped('snapshots omitted waits and orders omitted wait_all results by task name', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-omitted-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('omitted')
          for (const [index, name] of ['zulu', 'alpha'].entries()) {
            const spawning = yield* Effect.forkChild(orchestrator.spawn('omitted', admission, request(name)))
            yield* TestClock.adjust('1 millis')
            yield* ready(fake.children[index], `agent-${index + 1}`, bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
          }
          const waiting = yield* Effect.forkChild(orchestrator.waitAll('omitted'))
          yield* Effect.yieldNow
          yield* fake.children[0].emit(
            bytes({ agent_id: 'agent-1', command_id: 'initial', conclusion: 'z', status: 'completed', turn: 1, type: 'result' })
          )
          yield* fake.children[1].emit(
            bytes({ agent_id: 'agent-2', command_id: 'initial', conclusion: 'a', status: 'completed', turn: 1, type: 'result' })
          )
          expect((yield* Fiber.join(waiting)).map((result) => result.task_name)).toEqual(['alpha', 'zulu'])
        }),
        fake.layer
      )
    })
  )

  it.scoped('does not add work created after an omitted wait begins to its snapshot', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-snapshot-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('snapshot')
          const first = yield* Effect.forkChild(orchestrator.spawn('snapshot', admission, request('first')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(first)
          const waiting = yield* Effect.forkChild(orchestrator.waitOne('snapshot'))
          yield* Effect.yieldNow
          const later = yield* Effect.forkChild(orchestrator.spawn('snapshot', admission, request('later')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[1], 'agent-2', bunPath.join(root, 'session.json'))
          yield* Fiber.join(later)
          yield* fake.children[1].emit(
            bytes({ agent_id: 'agent-2', command_id: 'initial', conclusion: 'later', status: 'completed', turn: 1, type: 'result' })
          )
          yield* fake.children[0].emit(
            bytes({ agent_id: 'agent-1', command_id: 'initial', conclusion: 'first', status: 'completed', turn: 1, type: 'result' })
          )
          expect((yield* Fiber.join(waiting)).task_name).toBe('first')
        }),
        fake.layer
      )
    })
  )

  it.scoped('restores cancelled omitted waitOne claims', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-cancelled-wait-one-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('cancelled-wait-one')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('cancelled-wait-one', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          const cancelled = yield* Effect.forkChild(orchestrator.waitOne('cancelled-wait-one'))
          yield* Effect.yieldNow
          yield* Fiber.interrupt(cancelled)
          const replacement = yield* Effect.forkChild(orchestrator.waitOne('cancelled-wait-one'))
          yield* completed(fake.children[0], 'agent-1')
          expect((yield* Fiber.join(replacement)).task_name).toBe('worker')
        }),
        fake.layer
      )
    })
  )

  it.scoped('restores cancelled omitted waitAll claims', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-cancelled-wait-all-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('cancelled-wait-all')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('cancelled-wait-all', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          const cancelled = yield* Effect.forkChild(orchestrator.waitAll('cancelled-wait-all'))
          yield* Effect.yieldNow
          yield* Fiber.interrupt(cancelled)
          const replacement = yield* Effect.forkChild(orchestrator.waitAll('cancelled-wait-all'))
          yield* completed(fake.children[0], 'agent-1')
          expect((yield* Fiber.join(replacement)).map((result) => result.task_name)).toEqual(['worker'])
        }),
        fake.layer
      )
    })
  )

  it.scoped('delivers an interrupt result only once when an omitted wait has claimed it', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-interrupt-wait-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'], termination: ['stillAlive'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('interrupt-wait')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('interrupt-wait', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          const waiting = yield* Effect.forkChild(orchestrator.waitOne('interrupt-wait'))
          yield* Effect.yieldNow
          const interrupting = yield* Effect.forkChild(orchestrator.interrupt('interrupt-wait', 'worker'))
          yield* TestClock.adjust('5 seconds')
          expect('error' in (yield* Fiber.join(interrupting))).toBe(true)
          expect((yield* Effect.exit(Fiber.join(waiting)))._tag).toBe('Failure')
        }),
        fake.layer
      )
    })
  )

  it.scoped('does not restore an abandoned omitted wait claim when an interrupt is cancelled', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-abandoned-interrupt-wait-' })
        .pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'], termination: ['stillAlive'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('abandoned-interrupt-wait')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('abandoned-interrupt-wait', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          const waiting = yield* Effect.forkChild(orchestrator.waitOne('abandoned-interrupt-wait'))
          yield* Effect.yieldNow
          const interrupting = yield* Effect.forkChild(orchestrator.interrupt('abandoned-interrupt-wait', 'worker'))
          yield* Effect.yieldNow
          expect((yield* Effect.exit(Fiber.join(waiting)))._tag).toBe('Failure')
          const cancelling = yield* Effect.forkChild(Fiber.interrupt(interrupting))
          yield* TestClock.adjust('5 seconds')
          yield* Fiber.join(cancelling)
          const result = yield* orchestrator.waitOne('abandoned-interrupt-wait')
          expect('error' in result ? result.error.code : '').toBe('interrupted')
        }),
        fake.layer
      )
    })
  )

  it.scoped('restores an interrupted claim after interrupt cancellation during grace', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-cancelled-interrupt-' })
        .pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'], termination: ['stillAlive'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('cancelled-interrupt')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('cancelled-interrupt', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          const interrupting = yield* Effect.forkChild(orchestrator.interrupt('cancelled-interrupt', 'worker'))
          yield* Effect.yieldNow
          const cancelling = yield* Effect.forkChild(Fiber.interrupt(interrupting))
          yield* TestClock.adjust('5 seconds')
          yield* Fiber.join(cancelling)
          const replacement = yield* orchestrator.waitOne('cancelled-interrupt')
          expect('error' in replacement ? replacement.error.code : '').toBe('interrupted')
        }),
        fake.layer
      )
    })
  )

  it.scoped('does not duplicate an already-notified settlement when a settled interrupt is cancelled', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-cancelled-notified-interrupt-' })
        .pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('cancelled-notified-interrupt')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('cancelled-notified-interrupt', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          yield* completed(fake.children[0], 'agent-1')
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(fake.notifications()).toHaveLength(1)
          const interrupting = yield* Effect.forkChild(orchestrator.interrupt('cancelled-notified-interrupt', 'worker'))
          yield* Effect.yieldNow
          yield* Fiber.interrupt(interrupting)
          yield* Effect.yieldNow
          expect(fake.notifications()).toHaveLength(1)
        }),
        fake.layer
      )
    })
  )

  it.scoped('restores losing omitted waitOne claims for later notification', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-wait-one-claims-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('claims')
          for (const [index, name] of ['first', 'second'].entries()) {
            const spawning = yield* Effect.forkChild(orchestrator.spawn('claims', admission, request(name)))
            yield* TestClock.adjust('1 millis')
            yield* ready(fake.children[index], `agent-${index + 1}`, bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
          }
          const waiting = yield* Effect.forkChild(orchestrator.waitOne('claims'))
          yield* Effect.yieldNow
          yield* completed(fake.children[0], 'agent-1', 'winner')
          expect((yield* Fiber.join(waiting)).task_name).toBe('first')
          yield* completed(fake.children[1], 'agent-2', 'loser')
          expect((yield* orchestrator.waitOne('claims', ['second'])).status).toBe('completed')
          yield* Effect.yieldNow
          expect(fake.notifications().flat().join('\n')).toContain('Sub-agent second completed: loser')
        }),
        fake.layer
      )
    })
  )

  it.scoped('chooses the earliest settled explicit waitOne target', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-wait-one-order-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('order')
          for (const [index, name] of ['zulu', 'alpha'].entries()) {
            const spawning = yield* Effect.forkChild(orchestrator.spawn('order', admission, request(name)))
            yield* TestClock.adjust('1 millis')
            yield* ready(fake.children[index], `agent-${index + 1}`, bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
          }
          yield* completed(fake.children[0], 'agent-1', 'first')
          yield* TestClock.adjust('1 millis')
          yield* completed(fake.children[1], 'agent-2', 'second')
          expect((yield* orchestrator.waitOne('order', ['alpha', 'zulu'])).task_name).toBe('zulu')
        }),
        fake.layer
      )
    })
  )

  it.scoped('emits the one-shot injection-only inactivity warning without settling the turn', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-warning-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('warning')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('warning', admission, request('quiet')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          yield* Effect.yieldNow
          yield* TestClock.adjust('5 minutes')
          yield* TestClock.adjust('1 millis')
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect((yield* orchestrator.list('warning'))[0]?.status).toBe('running')
          expect(fake.notifications()).toHaveLength(1)
          expect(fake.notifications()[0]?.[0]).toBe('Sub-agent quiet has produced no verified progress for 5 minutes; it is still running.')
          yield* TestClock.adjust('5 minutes')
          expect(fake.notifications()).toHaveLength(1)
          const waiting = yield* Effect.forkChild(orchestrator.waitOne('warning'))
          yield* Effect.yieldNow
          yield* fake.children[0].emit(
            bytes({ agent_id: 'agent-1', command_id: 'initial', conclusion: 'done', status: 'completed', turn: 1, type: 'result' })
          )
          expect((yield* Fiber.join(waiting)).status).toBe('completed')
        }),
        fake.layer
      )
    })
  )

  it.scoped('atomically reserves the one running-turn follow-up', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-concurrent-steer-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { contextCeiling: 10_000, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('concurrent-steer')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('concurrent-steer', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          const [child] = fake.children
          yield* ready(child, 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          const sends = yield* Effect.forkChild(
            Effect.all(
              Array.from({ length: 20 }, (_value, index) =>
                Effect.exit(orchestrator.send('concurrent-steer', admission, 'worker', `message-${index}`))
              ),
              { concurrency: 'unbounded' }
            )
          )
          yield* Effect.yieldNow
          expect(child.writes().filter((frame) => frame.includes('"type":"steer"'))).toHaveLength(1)
          yield* steerAck(child, 'agent-1')
          const results = yield* Fiber.join(sends)
          expect(results.filter(Exit.isSuccess)).toHaveLength(1)
          expect(results.filter(Exit.isFailure)).toHaveLength(19)
        }),
        fake.layer
      )
    })
  )

  it.scoped('bounds notification batches and does not replay consumed notices after a session restart', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-notices-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { closeExits: true, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('notices')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('notices', admission, request('large')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(spawning)
          yield* fake.children[0].emit(
            bytes({
              agent_id: 'agent-1',
              command_id: 'initial',
              conclusion: Array.from({ length: 2100 }, () => 'x'.repeat(30)).join('\n'),
              status: 'completed',
              turn: 1,
              type: 'result',
            })
          )
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          const [batch] = fake.notifications()
          const joined = batch?.join('\n') ?? ''
          expect(new TextEncoder().encode(joined).byteLength).toBeLessThanOrEqual(50 * 1024)
          expect(joined.split('\n').length).toBeLessThanOrEqual(2000)
          yield* orchestrator.closeSession('notices').pipe(Effect.exit)
          yield* orchestrator.openSession('notices')
          expect((yield* Effect.exit(orchestrator.waitOne('notices')))._tag).toBe('Failure')
        }),
        fake.layer
      )
    })
  )

  it.scoped('correlates one lifetime steering allowance without stealing delivery', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-steer-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { contextCeiling: 10_000, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('steer')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('steer', admission, request('foreground', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Effect.yieldNow
          expect((yield* orchestrator.list('steer'))[0]?.follow_up_available).toBe(true)
          const sending = yield* Effect.forkChild(orchestrator.send('steer', admission, 'foreground', 'first'))
          yield* Effect.yieldNow
          yield* steerAck(fake.children[0], 'agent-1')
          const acknowledged = yield* Fiber.join(sending)
          expect('accepted' in acknowledged && acknowledged.accepted).toBe(true)
          expect((yield* Effect.exit(orchestrator.send('steer', admission, 'foreground', 'second')))._tag).toBe('Failure')
          yield* completed(fake.children[0], 'agent-1')
          expect((yield* Fiber.join(spawning)).status).toBe('completed')
          yield* fake.children[0].exit
          yield* Effect.yieldNow

          const queued = yield* Effect.forkChild(orchestrator.spawn('steer', admission, request('queued')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[1], 'agent-2', bunPath.join(root, 'session.json'))
          yield* Fiber.join(queued)
          const rejected = yield* Effect.forkChild(orchestrator.send('steer', admission, 'queued', 'first'))
          yield* Effect.yieldNow
          yield* fake.children[1].emit(
            bytes({
              agent_id: 'agent-2',
              code: 'queue_rejected',
              command_id: 'steer',
              error: 'busy',
              status: 'running',
              turn: 1,
              type: 'command_error',
            })
          )
          const queueRejected = yield* Fiber.join(rejected)
          expect('accepted' in queueRejected && queueRejected.accepted).toBe(false)
          const retried = yield* Effect.forkChild(orchestrator.send('steer', admission, 'queued', 'second'))
          yield* Effect.yieldNow
          yield* steerAck(fake.children[1], 'agent-2')
          const retriedResult = yield* Fiber.join(retried)
          expect('accepted' in retriedResult && retriedResult.accepted).toBe(true)

          const malformed = yield* Effect.forkChild(orchestrator.spawn('steer', admission, request('malformed')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[2], 'agent-3', bunPath.join(root, 'session.json'))
          yield* Fiber.join(malformed)
          const mismatch = yield* Effect.forkChild(orchestrator.send('steer', admission, 'malformed', 'first'))
          yield* Effect.yieldNow
          yield* steerAck(fake.children[2], 'agent-3', 'wrong')
          const mismatchResult = yield* Fiber.join(mismatch)
          expect('error' in mismatchResult ? mismatchResult.error.code : '').toBe('protocol_error')
          yield* fake.children[2].exit
          yield* Effect.yieldNow

          const resultFirst = yield* Effect.forkChild(orchestrator.spawn('steer', admission, request('result-first')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[3], 'agent-4', bunPath.join(root, 'session.json'))
          yield* Fiber.join(resultFirst)
          const racing = yield* Effect.forkChild(orchestrator.send('steer', admission, 'result-first', 'first'))
          yield* Effect.yieldNow
          yield* completed(fake.children[3], 'agent-4')
          const loser = yield* Fiber.join(racing)
          expect('error' in loser ? loser.error.code : '').toBe('turn_settled')
          yield* fake.children[3].exit
          const resumed = yield* Effect.forkChild(orchestrator.send('steer', admission, 'result-first', 'second'))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[4], 'agent-4', bunPath.join(root, 'session.json'), 2)
          yield* completed(fake.children[4], 'agent-4', 'again', 2)
          expect((yield* Fiber.join(resumed)).turn).toBe(2)
        }),
        fake.layer
      )
    })
  )

  it.scoped('refuses resume at the exact projected context ceiling', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-resume-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { contextCeiling: 8193, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('resume')
          const initial = yield* Effect.forkChild(orchestrator.spawn('resume', admission, request('done', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* completed(fake.children[0], 'agent-1')
          yield* Fiber.join(initial)
          yield* fake.children[0].exit
          const equality = yield* Effect.exit(orchestrator.send('resume', admission, 'done', 'x'.repeat(4)))
          expect(equality._tag).toBe('Failure')
          if (equality._tag === 'Failure') {
            expect(equality.cause.toString()).toContain('context limit')
          }

          expect((yield* Effect.exit(orchestrator.send('resume', admission, 'done', 'next')))._tag).toBe('Failure')
        }),
        fake.layer
      )
    })
  )

  it.scoped('refuses resume when the resolved model reserves more output than the fallback', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-reserve-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { contextCeiling: 8300, maxOutputTokens: 16_384, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('reserve')
          const initial = yield* Effect.forkChild(orchestrator.spawn('reserve', admission, request('done', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* completed(fake.children[0], 'agent-1')
          yield* Fiber.join(initial)
          yield* fake.children[0].exit
          const refused = yield* Effect.exit(orchestrator.send('reserve', admission, 'done', 'x'.repeat(4)))
          expect(refused._tag).toBe('Failure')
          if (refused._tag === 'Failure') {
            expect(refused.cause.toString()).toContain('context limit')
          }
        }),
        fake.layer
      )
    })
  )

  it.scoped('admits resumes using token estimates and the resolved model output limit', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-estimate-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { contextCeiling: 1200, maxOutputTokens: 1024, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('estimate')
          const initial = yield* Effect.forkChild(orchestrator.spawn('estimate', admission, request('done', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* completed(fake.children[0], 'agent-1')
          yield* Fiber.join(initial)
          yield* fake.children[0].exit
          const resumed = yield* Effect.forkChild(orchestrator.send('estimate', admission, 'done', 'é'.repeat(60)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[1], 'agent-1', bunPath.join(root, 'session.json'), 2)
          yield* completed(fake.children[1], 'agent-1', 'again', 2)
          expect((yield* Fiber.join(resumed)).turn).toBe(2)
        }),
        fake.layer
      )
    })
  )

  it.scoped('re-resolves resumes and validates open-mode readiness and its timeout', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-open-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { contextCeiling: 10_000, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('open')
          const source = yield* Effect.forkChild(orchestrator.spawn('open', admission, request('source', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* completed(fake.children[0], 'agent-1')
          yield* Fiber.join(source)
          yield* fake.children[0].exit
          fake.removeProfile('scout')
          const removed = yield* Effect.exit(orchestrator.send('open', admission, 'source', 'next'))
          expect(removed._tag).toBe('Failure')
          if (removed._tag === 'Failure') {
            expect(removed.cause.toString()).toContain('unknown')
          }
          fake.addProfile('scout')
          const alternate = bunPath.join(root, 'alternate.json')
          yield* bunFileSystem.writeFileString(alternate, '{}')
          yield* bunFileSystem.chmod(alternate, 0o600)
          const mismatch = yield* Effect.forkChild(orchestrator.send('open', admission, 'source', 'next'))
          yield* TestClock.adjust('1 millis')
          const config = fake.children[1].writes()[0] ?? ''
          expect(config).toContain(`"canonical_path":"${bunPath.join(root, 'session.json')}"`)
          expect(config).toContain('"mode":"open"')
          yield* ready(fake.children[1], 'agent-1', alternate, 2)
          expect((yield* Effect.exit(Fiber.join(mismatch)))._tag).toBe('Failure')
          yield* fake.children[1].exit
          yield* Effect.yieldNow
          const resumed = yield* Effect.forkChild(orchestrator.send('open', admission, 'source', 'next'))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[2], 'agent-1', bunPath.join(root, 'session.json'), 2)
          yield* completed(fake.children[2], 'agent-1', 'again', 2)
          expect((yield* Fiber.join(resumed)).turn).toBe(2)

          const timeoutSource = yield* Effect.forkChild(orchestrator.spawn('open', admission, request('timeout', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[3], 'agent-2', bunPath.join(root, 'session.json'))
          yield* completed(fake.children[3], 'agent-2')
          yield* Fiber.join(timeoutSource)
          yield* fake.children[3].exit
          const timingOut = yield* Effect.forkChild(orchestrator.send('open', admission, 'timeout', 'next'))
          yield* TestClock.adjust('30 seconds')
          expect((yield* Effect.exit(Fiber.join(timingOut)))._tag).toBe('Failure')
        }),
        fake.layer
      )
    })
  )

  it.scoped('panic interrupts a launch reserved after its snapshot would otherwise escape', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-panic-starting-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { gateSpawnCompletion: true, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('panic-starting')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('panic-starting', admission, request('reserved')))
          yield* TestClock.adjust('1 millis')
          expect(fake.children).toHaveLength(1)
          yield* orchestrator.interruptAll('panic-starting')
          yield* fake.releaseSpawnCompletion
          expect((yield* Fiber.join(spawning).pipe(Effect.exit))._tag).toBe('Failure')
          expect(yield* orchestrator.list('panic-starting')).toEqual([])
          expect(fake.records()).toHaveLength(0)
        }),
        fake.layer
      )
    })
  )

  it.scoped('reports not_ready while a completed agent resume is provisional', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-resume-starting-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { contextCeiling: 10_000, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('resume-starting')
          const source = yield* Effect.forkChild(orchestrator.spawn('resume-starting', admission, request('source', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* completed(fake.children[0], 'agent-1')
          yield* Fiber.join(source)
          yield* fake.children[0].exit

          const resumed = yield* Effect.forkChild(orchestrator.send('resume-starting', admission, 'source', 'next'))
          yield* TestClock.adjust('1 millis')
          const interrupted = yield* Effect.exit(orchestrator.interrupt('resume-starting', 'source'))
          expect(interrupted._tag).toBe('Failure')
          if (interrupted._tag === 'Failure') {
            expect(interrupted.cause.toString()).toContain('still starting')
          }
          yield* ready(fake.children[1], 'agent-1', bunPath.join(root, 'session.json'), 2)
          yield* completed(fake.children[1], 'agent-1', 'again', 2)
          expect((yield* Fiber.join(resumed)).status).toBe('completed')
        }),
        fake.layer
      )
    })
  )

  it.scoped('interrupts durably, retains live capacity, and preserves unrelated panic notices', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-interrupt-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { gateNotifications: true, profiles: ['scout'], termination: ['stillAlive', 'stillAlive'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('interrupt')
          for (const [index, task] of ['one', 'two', 'three'].entries()) {
            const spawning = yield* Effect.forkChild(orchestrator.spawn('interrupt', admission, request(task)))
            yield* TestClock.adjust('1 millis')
            yield* ready(fake.children[index], `agent-${index + 1}`, bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
          }
          const stopping = yield* Effect.forkChild(orchestrator.interrupt('interrupt', 'one'))
          yield* TestClock.adjust('1 millis')
          yield* TestClock.adjust('5 seconds')
          const interrupted = yield* Fiber.join(stopping)
          expect('error' in interrupted ? interrupted.error.code : '').toBe('interrupted')
          expect((yield* Effect.exit(orchestrator.spawn('interrupt', admission, request('four'))))._tag).toBe('Failure')
          yield* fake.children[0].exit
          yield* Effect.yieldNow
          expect('interrupted' in (yield* orchestrator.interrupt('interrupt', 'one'))).toBe(true)

          yield* completed(fake.children[1], 'agent-2', 'survives')
          yield* Effect.yieldNow
          const panic = yield* Effect.forkChild(orchestrator.interruptAll('interrupt'))
          yield* TestClock.adjust('5 seconds')
          yield* Fiber.join(panic)
          yield* fake.releaseNotifications
          yield* Effect.yieldNow
          expect(fake.notifications().flat().join('\n')).toContain('Sub-agent two completed: survives')
        }),
        fake.layer
      )
    })
  )

  it.scoped('does not let a mismatched deadline settle a same-name replacement', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-mismatched-deadline-' })
        .pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'], termination: ['mismatch'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('mismatched-deadline')
          const initial = yield* Effect.forkChild(orchestrator.spawn('mismatched-deadline', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(initial)
          const interrupting = yield* Effect.forkChild(orchestrator.interrupt('mismatched-deadline', 'worker'))
          yield* TestClock.adjust('5 seconds')
          yield* Fiber.join(interrupting)
          const replacement = yield* Effect.forkChild(orchestrator.spawn('mismatched-deadline', admission, request('worker')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[1], 'agent-2', bunPath.join(root, 'session.json'))
          yield* Fiber.join(replacement)
          yield* TestClock.adjust(1_795_000)
          expect((yield* orchestrator.list('mismatched-deadline'))[0]?.status).toBe('running')
        }),
        fake.layer
      )
    })
  )

  it.scoped('ignores late old-generation frames and exit after replacement', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-late-generation-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'], termination: ['stillAlive'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('generation')
          const oldSpawning = yield* Effect.forkChild(orchestrator.spawn('generation', admission, request('old')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Fiber.join(oldSpawning)
          const closing = yield* Effect.forkChild(orchestrator.closeSession('generation'))
          yield* TestClock.adjust('5 seconds')
          yield* Fiber.join(closing)
          yield* orchestrator.openSession('generation')
          const newSpawning = yield* Effect.forkChild(orchestrator.spawn('generation', admission, request('new')))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[1], 'agent-2', bunPath.join(root, 'session.json'))
          yield* Fiber.join(newSpawning)
          const before = fake.records().filter((record) => record.status !== 'running').length
          yield* completed(fake.children[0], 'agent-1', 'late')
          yield* fake.children[0].exit
          yield* Effect.yieldNow
          expect((yield* orchestrator.list('generation')).map((entry) => entry.task_name)).toEqual(['new'])
          expect(fake.activity()).toHaveLength(1)
          expect(fake.records().filter((record) => record.status !== 'running')).toHaveLength(before)
          for (const [index, name] of ['two', 'three'].entries()) {
            const spawning = yield* Effect.forkChild(orchestrator.spawn('generation', admission, request(name)))
            yield* TestClock.adjust('1 millis')
            yield* ready(fake.children[index + 2], `agent-${index + 3}`, bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
          }
          expect((yield* Effect.exit(orchestrator.spawn('generation', admission, request('four'))))._tag).toBe('Failure')
        }),
        fake.layer
      )
    })
  )

  it.scoped('refuses failed and interrupted source turns independently before resume admission', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-not-resumable-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      for (const status of ['failed', 'interrupted'] as const) {
        const fake = yield* harness(root, { profiles: ['scout'] })
        yield* Effect.provide(
          Effect.gen(function* () {
            const orchestrator = yield* SubagentOrchestrator
            yield* orchestrator.openSession(status)
            const spawning = yield* Effect.forkChild(orchestrator.spawn(status, admission, request('source')))
            yield* TestClock.adjust('1 millis')
            yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
            const frame =
              status === 'failed'
                ? '{"agent_id":"agent-1","command_id":"initial","error":{"code":"agent_failed","message":"failed"},"status":"failed","turn":1,"type":"result"}\n'
                : '{"agent_id":"agent-1","command_id":"initial","error":{"code":"interrupted","message":"interrupted"},"status":"interrupted","turn":1,"type":"result"}\n'
            yield* fake.children[0].emit(new TextEncoder().encode(frame))
            yield* Effect.yieldNow
            const code = yield* orchestrator
              .send(status, admission, 'source', 'again')
              .pipe(
                Effect.match({ onFailure: (error) => (error._tag === 'PublicRefusalError' ? error.code : 'lifecycle'), onSuccess: () => 'accepted' })
              )
            expect(code).toBe('not_resumable')
          }),
          fake.layer
        )
      }
    })
  )

  it.scoped('refuses a captured resume after a same-name replacement commits', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-resume-replacement-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { contextCeiling: 100_000, gateResolveAt: 2, profiles: ['scout'], termination: ['mismatch'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('resume-replacement')
          const initial = yield* Effect.forkChild(orchestrator.spawn('resume-replacement', admission, request('source', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* completed(fake.children[0], 'agent-1')
          yield* Fiber.join(initial)
          yield* fake.children[0].exit
          yield* Effect.yieldNow

          const captured = yield* Effect.forkChild(orchestrator.send('resume-replacement', admission, 'source', 'first'))
          yield* TestClock.adjust('1 millis')
          const replacing = yield* Effect.forkChild(orchestrator.send('resume-replacement', admission, 'source', 'second'))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[1], 'agent-1', bunPath.join(root, 'session.json'), 2)
          yield* completed(fake.children[1], 'agent-1', 'second', 2)
          expect((yield* Fiber.join(replacing)).turn).toBe(2)

          yield* fake.releaseResolve
          const code = yield* Fiber.join(captured).pipe(
            Effect.match({ onFailure: (error) => (error._tag === 'PublicRefusalError' ? error.code : 'lifecycle'), onSuccess: () => 'accepted' })
          )
          expect(code).toBe('not_resumable')
        }),
        fake.layer
      )
    })
  )

  it.scoped('returns unknown_agent for a stale-generation resume target after replacement', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-stale-resume-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { closeExits: true, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('replacement')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('replacement', admission, request('source', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* completed(fake.children[0], 'agent-1')
          yield* Fiber.join(spawning)
          yield* orchestrator.closeSession('replacement')
          yield* orchestrator.openSession('replacement')
          const code = yield* orchestrator
            .send('replacement', admission, 'source', 'again')
            .pipe(
              Effect.match({ onFailure: (error) => (error._tag === 'PublicRefusalError' ? error.code : 'lifecycle'), onSuccess: () => 'accepted' })
            )
          expect(code).toBe('unknown_agent')
        }),
        fake.layer
      )
    })
  )

  it.scoped('makes a cancelled foreground result notification-eligible', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem
        .makeTempDirectory({ prefix: 'orchestrator-cancelled-foreground-' })
        .pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('foreground-notice')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('foreground-notice', admission, request('worker', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Effect.yieldNow
          yield* Fiber.interrupt(spawning)
          yield* completed(fake.children[0], 'agent-1', 'after cancellation')
          expect((yield* orchestrator.waitOne('foreground-notice', ['worker'])).status).toBe('completed')
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(fake.notifications().flat().join('\n')).toContain('Sub-agent worker completed: after cancellation')
        }),
        fake.layer
      )
    })
  )

  it.scoped('hands an explicitly cancelled admitted caller to cleanup without releasing its live slot twice', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-cancelled-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { profiles: ['scout'], termination: ['stillAlive'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('cancelled')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('cancelled', admission, request('foreground', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* Effect.yieldNow
          yield* Fiber.interrupt(spawning)
          expect((yield* orchestrator.list('cancelled'))[0]?.status).toBe('running')
          const closing = yield* Effect.forkChild(orchestrator.closeSession('cancelled'))
          yield* TestClock.adjust('5 seconds')
          const closed = yield* Fiber.join(closing).pipe(Effect.exit)
          expect(closed._tag).toBe('Success')
          expect(fake.leaseCreates()).toBe(2)
          expect(fake.releases()).toBe(0)
          yield* fake.children[0].exit
          yield* Effect.yieldNow
          expect(fake.leaseRemovals()).toBe(1)
          expect(fake.releases()).toBe(1)
        }),
        fake.layer
      )
    })
  )

  it.scoped('uses UUID agent IDs without colliding with retained names and closes hydrated settlements without cleanup', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-retained-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const settled: SubagentRecord = {
        logPath: 'old.log',
        profile: profile('scout'),
        session: 'retained',
        sessionPath: bunPath.join(root, 'session.json'),
        settledAt: 1,
        status: 'completed',
        taskName: 'old',
        turns: [{ profile: profile('scout'), result: { conclusion: 'old', status: 'completed', task_name: 'old', turn: 1 } }],
      }
      const fake = yield* harness(root, { profiles: ['scout'], records: [{ agentId: 'agent-1', record: settled }] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('retained')
          yield* orchestrator.closeSession('retained')
          expect(fake.forceCalls()).toBe(0)
          expect(fake.deletes()).toBe(0)
          yield* orchestrator.openSession('fresh')
          const spawning = yield* Effect.forkChild(orchestrator.spawn('fresh', admission, request('fresh')))
          yield* TestClock.adjust('1 millis')
          const agentId = frameAgentId(fake.children[0].writes()[0])
          expect(agentId).toBeDefined()
          expect(agentId).not.toBe('agent-1')
          yield* ready(fake.children[0], agentId ?? 'missing', bunPath.join(root, 'session.json'))
          yield* completed(fake.children[0], agentId ?? 'missing')
          yield* Fiber.join(spawning)
        }),
        fake.layer
      )
    })
  )

  it.scoped('fails closed when session usage is unavailable and admits conservatively measured usage', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-context-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const unavailable = yield* harness(root, { contextCeiling: 10_000, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('context')
          const initial = yield* Effect.forkChild(orchestrator.spawn('context', admission, request('done', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(unavailable.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* unavailable.children[0].emit(
            bytes({ agent_id: 'agent-1', command_id: 'initial', conclusion: 'done', status: 'completed', turn: 1, type: 'result' })
          )
          yield* Fiber.join(initial)
          expect((yield* Effect.exit(orchestrator.send('context', admission, 'done', 'next')))._tag).toBe('Failure')
        }),
        unavailable.layer
      )
      const measured = yield* harness(root, { contextCeiling: 9000, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('measured')
          const initial = yield* Effect.forkChild(orchestrator.spawn('measured', admission, request('done', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(measured.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* completed(measured.children[0], 'agent-1')
          yield* measured.children[0].exit
          yield* Fiber.join(initial)
          const resumed = yield* Effect.forkChild(orchestrator.send('measured', admission, 'done', 'next'))
          yield* TestClock.adjust('1 millis')
          yield* ready(measured.children[1], 'agent-1', bunPath.join(root, 'session.json'), 2)
          yield* Effect.yieldNow
          const [running] = yield* orchestrator.list('measured')
          expect(running?.current_turn).toBe(2)
          expect(running?.follow_up_available).toBe(false)
          yield* completed(measured.children[1], 'agent-1', 'again', 2)
          expect((yield* Fiber.join(resumed)).turn).toBe(2)
        }),
        measured.layer
      )
    })
  )

  it.scoped('releases failed resume startup capacity and restores its follow-up allowance', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-resume-release-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      const fake = yield* harness(root, { contextCeiling: 10_000, failResumeWriteOnce: true, profiles: ['scout'] })
      yield* Effect.provide(
        Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.openSession('resume-release')
          const initial = yield* Effect.forkChild(orchestrator.spawn('resume-release', admission, request('done', 'scout', false)))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[0], 'agent-1', bunPath.join(root, 'session.json'))
          yield* completed(fake.children[0], 'agent-1')
          yield* fake.children[0].exit
          yield* Fiber.join(initial)
          yield* Effect.yieldNow
          expect((yield* Effect.exit(orchestrator.send('resume-release', admission, 'done', 'next')))._tag).toBe('Failure')
          const [entry] = yield* orchestrator.list('resume-release')
          expect(entry?.follow_up_available).toBe(true)
          const blocked = yield* Effect.exit(orchestrator.send('resume-release', admission, 'done', 'next'))
          expect(blocked._tag).toBe('Failure')
          if (blocked._tag === 'Failure') {
            expect(blocked.cause.toString()).toContain('still cleaning up')
          }
          yield* fake.children[1].exit
          yield* Effect.yieldNow
          const retried = yield* Effect.forkChild(orchestrator.send('resume-release', admission, 'done', 'next'))
          yield* TestClock.adjust('1 millis')
          yield* ready(fake.children[2], 'agent-1', bunPath.join(root, 'session.json'), 2)
          yield* completed(fake.children[2], 'agent-1', 'again', 2)
          expect((yield* Fiber.join(retried)).turn).toBe(2)
          expect(fake.logRemovals()).toBe(1)
        }),
        fake.layer
      )
    })
  )

  it.scoped('has one durable winner when results race inactivity and deadline supervision', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'orchestrator-winners-' }).pipe(Effect.flatMap(bunFileSystem.realPath))
      for (const [index] of ['5 minutes', '30 minutes'].entries()) {
        const fake = yield* harness(root, { profiles: ['scout'] })
        yield* Effect.provide(
          Effect.gen(function* () {
            const orchestrator = yield* SubagentOrchestrator
            const session = `winner-${index}`
            yield* orchestrator.openSession(session)
            const spawning = yield* Effect.forkChild(orchestrator.spawn(session, admission, request('worker')))
            yield* TestClock.adjust('1 millis')
            const [child] = fake.children
            yield* ready(child, 'agent-1', bunPath.join(root, 'session.json'))
            yield* Fiber.join(spawning)
            yield* Effect.all([
              TestClock.adjust(index === 0 ? '5 minutes' : '30 minutes'),
              child.emit(bytes({ agent_id: 'agent-1', command_id: 'initial', conclusion: 'done', status: 'completed', turn: 1, type: 'result' })),
            ])
            const settled = yield* orchestrator.waitOne(session, ['worker'])
            expect(['completed', 'failed']).toContain(settled.status)
            expect(fake.records().filter((record) => record.status !== 'running')).toHaveLength(1)
          }),
          fake.layer
        )
      }
    })
  )
})
