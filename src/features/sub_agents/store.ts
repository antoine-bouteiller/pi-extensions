import os from 'node:os'

import { Context, Data, Effect, Layer } from 'effect'
import { Type } from 'typebox'
import { Value } from 'typebox/value'

import {
  createPrivateFile,
  ensurePrivateDirectory,
  readHostDirectoryEntries,
  readOwnerOnlyFile,
  removeHeldFileIfUnchanged,
  removeHostPath,
  withHeldFile,
  writePrivateFile,
} from '#shared/effect/bun_host_file_system'
import { bunFileSystem, bunPath } from '#shared/effect/bun_services'

import {
  AgentResultSchema,
  type AdmissionSnapshot,
  type AgentResult,
  type PersistedResolvedProfile,
  PersistedResolvedProfileSchema,
  type ProfileResolution,
} from './model.js'

export interface ProcessIdentity {
  readonly birthMarker: string
  readonly pid: number
}
export interface AgentTurnRecord {
  readonly profile: PersistedResolvedProfile
  readonly result: AgentResult
}
export interface LaunchLease {
  readonly identity: ProcessIdentity
  readonly owner?: ProcessIdentity
  readonly preserveRecord?: boolean
  readonly session: string
  readonly taskName: string
}
interface PrivateRunDescriptor {
  readonly runDirectory: string
  readonly sessionPath: string
}
export type SubagentRecord =
  | {
      readonly identity: ProcessIdentity
      readonly owner?: ProcessIdentity
      readonly logPath: string
      readonly profile: PersistedResolvedProfile
      readonly session: string
      readonly sessionPath: string
      readonly status: 'running'
      readonly taskName: string
      readonly turns: readonly AgentTurnRecord[]
    }
  | {
      readonly contextTokens?: number
      readonly logPath: string
      readonly profile: PersistedResolvedProfile
      readonly session: string
      readonly sessionPath: string
      readonly settledAt: number
      readonly status: 'completed' | 'failed' | 'interrupted'
      readonly taskName: string
      readonly turns: readonly AgentTurnRecord[]
    }

export class StoreError extends Data.TaggedError('SubagentStoreError')<{ readonly cause: unknown; readonly message: string }> {}
export class ArtifactTooLargeError extends Data.TaggedError('SubagentArtifactTooLargeError')<{
  readonly maxBytes: number
  readonly message: string
}> {}
export interface ProfileResolverApi {
  readonly resolve: (key: string, snapshot: AdmissionSnapshot) => Effect.Effect<ProfileResolution>
}
export class ProfileResolver extends Context.Service<ProfileResolver, ProfileResolverApi>()(
  'pi-extensions/features/sub_agents/store/ProfileResolver'
) {}
export interface NotificationToken {
  readonly generation: number
  readonly session: string
}
export interface NotificationSinkApi {
  readonly publish: (messages: readonly string[], token: NotificationToken) => Effect.Effect<void>
}
export class NotificationSink extends Context.Service<NotificationSink, NotificationSinkApi>()(
  'pi-extensions/features/sub_agents/store/NotificationSink'
) {}

export interface SubagentStoreApi {
  readonly artifactPath: (agentId: string, name: string) => Effect.Effect<string, StoreError>
  readonly createLease: (agentId: string, lease: LaunchLease) => Effect.Effect<void, StoreError>
  readonly createLog: (agentId: string, turn: number) => Effect.Effect<string, StoreError>
  readonly createSession: (agentId: string) => Effect.Effect<PrivateRunDescriptor, StoreError>
  readonly delete: (agentId: string) => Effect.Effect<void, StoreError>
  readonly initialize: Effect.Effect<void, StoreError>
  readonly listLeases: Effect.Effect<readonly { readonly agentId: string; readonly lease: LaunchLease }[], StoreError>
  readonly listRecords: Effect.Effect<readonly { readonly agentId: string; readonly record: SubagentRecord }[], StoreError>
  readonly readArtifact: (agentId: string, name: string, maxBytes: number) => Effect.Effect<Uint8Array, ArtifactTooLargeError | StoreError>
  readonly prune: (now: number) => Effect.Effect<void, StoreError>
  readonly readRecord: (agentId: string) => Effect.Effect<SubagentRecord | undefined, StoreError>
  readonly removeLease: (agentId: string, identity?: ProcessIdentity) => Effect.Effect<void, StoreError>
  readonly removeLog: (agentId: string, path: string) => Effect.Effect<void, StoreError>
  readonly replaceRecord: (agentId: string, record: SubagentRecord) => Effect.Effect<void, StoreError>
  readonly writeFullResult: (agentId: string, content: Uint8Array) => Effect.Effect<string, StoreError>
}
export class SubagentStore extends Context.Service<SubagentStore, SubagentStoreApi>()('pi-extensions/features/sub_agents/store/SubagentStore') {}
export interface SubagentStoreConfig {
  readonly tempDirectory?: string
  readonly username?: string
}

const ProcessIdentitySchema = Type.Object(
  { birthMarker: Type.String({ minLength: 1 }), pid: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false }
)
const StoredTurnSchema = Type.Object({ profile: PersistedResolvedProfileSchema, result: AgentResultSchema }, { additionalProperties: false })
const LeaseSchema = Type.Object(
  {
    identity: ProcessIdentitySchema,
    owner: Type.Optional(ProcessIdentitySchema),
    preserveRecord: Type.Optional(Type.Boolean()),
    session: Type.String(),
    taskName: Type.String(),
  },
  { additionalProperties: false }
)
const RunningRecordSchema = Type.Object(
  {
    identity: ProcessIdentitySchema,
    logPath: Type.String(),
    owner: Type.Optional(ProcessIdentitySchema),
    profile: PersistedResolvedProfileSchema,
    session: Type.String(),
    sessionPath: Type.String(),
    status: Type.Literal('running'),
    taskName: Type.String(),
    turns: Type.Array(StoredTurnSchema),
  },
  { additionalProperties: false }
)
const SettledRecordSchema = Type.Object(
  {
    contextTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    logPath: Type.String(),
    profile: PersistedResolvedProfileSchema,
    session: Type.String(),
    sessionPath: Type.String(),
    settledAt: Type.Number(),
    status: Type.Union([Type.Literal('completed'), Type.Literal('failed'), Type.Literal('interrupted')]),
    taskName: Type.String(),
    turns: Type.Array(StoredTurnSchema),
  },
  { additionalProperties: false }
)
const SubagentRecordSchema = Type.Union([RunningRecordSchema, SettledRecordSchema])
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const fail = (cause: unknown): StoreError => new StoreError({ cause, message: cause instanceof Error ? cause.message : String(cause) })
const isArtifactTooLarge = (error: { readonly cause?: unknown }): boolean =>
  error.cause instanceof Error && /^Artifact is larger than \d+ bytes$/.test(error.cause.message)
const isSafeName = (name: string): boolean => /^[A-Za-z0-9_.-]{1,128}$/.test(name) && name !== '.' && name !== '..'
const parse = (content: Uint8Array): unknown => Bun.JSONC.parse(new TextDecoder().decode(content))
const decodeLease = (content: Uint8Array): LaunchLease | undefined => {
  try {
    const value = parse(content)
    return Value.Check(LeaseSchema, value) ? value : undefined
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined
    }
    throw error
  }
}
const decodeRecord = (content: Uint8Array): SubagentRecord | undefined => {
  try {
    const value = parse(content)
    return Value.Check(SubagentRecordSchema, value) ? value : undefined
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined
    }
    throw error
  }
}
const encode = (value: unknown): string => JSON.stringify(value)

const makeStore = (config: SubagentStoreConfig): SubagentStoreApi => {
  const temporaryDirectory = config.tempDirectory ?? Bun.env.PI_SUBAGENT_TEMP_DIR ?? os.tmpdir()
  const username = config.username ?? os.userInfo().username
  const privateRoot = bunPath.join(temporaryDirectory, 'pi-codex-subagents', username)
  const root = bunPath.join(privateRoot, 'runs')
  const agentDirectory = (agentId: string): string => {
    if (!isSafeName(agentId)) {
      throw new Error('Unsafe agent identifier')
    }
    return bunPath.join(root, agentId)
  }
  const file = (agentId: string, name: string): string => {
    if (!isSafeName(name)) {
      throw new Error('Unsafe artifact name')
    }
    return bunPath.join(agentDirectory(agentId), name)
  }
  const readValue = <Value>(
    agentId: string,
    name: string,
    decode: (content: Uint8Array) => Value | undefined
  ): Effect.Effect<Value | undefined, StoreError> =>
    readOwnerOnlyFile({ maxBytes: MAX_ARTIFACT_BYTES, path: file(agentId, name), root: agentDirectory(agentId) }).pipe(
      Effect.map((read) => decode(read.bytes)),
      Effect.catch((error) =>
        error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'ENOENT'
          ? Effect.void.pipe(Effect.as(undefined))
          : Effect.fail(fail(error))
      )
    )
  const list = (): Effect.Effect<readonly string[], StoreError> =>
    readHostDirectoryEntries(root).pipe(
      Effect.map((entries) => entries.filter((entry) => entry.isDirectory && isSafeName(entry.name)).map((entry) => entry.name)),
      Effect.catch((error) =>
        error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'ENOENT' ? Effect.succeed([]) : Effect.fail(fail(error))
      )
    )
  const removeAgent = (agentId: string): Effect.Effect<void, StoreError> => removeHostPath(agentDirectory(agentId), true).pipe(Effect.mapError(fail))
  const create = (agentId: string, name: string): Effect.Effect<string, StoreError> =>
    Effect.gen(function* () {
      const directory = agentDirectory(agentId)
      const target = file(agentId, name)
      yield* ensurePrivateDirectory(directory)
      yield* createPrivateFile(target)
      return target
    }).pipe(Effect.mapError(fail))
  const createSession = (agentId: string): Effect.Effect<PrivateRunDescriptor, StoreError> =>
    Effect.gen(function* () {
      const sessionPath = yield* create(agentId, 'session.json')
      const runDirectory = yield* bunFileSystem.realPath(agentDirectory(agentId))
      const canonicalSessionPath = yield* bunFileSystem.realPath(sessionPath)
      return { runDirectory, sessionPath: canonicalSessionPath }
    }).pipe(Effect.mapError(fail))
  return {
    artifactPath: (agentId, name) => Effect.try({ catch: fail, try: () => file(agentId, name) }),
    createLease: (agentId, lease) =>
      Value.Check(LeaseSchema, lease)
        ? Effect.gen(function* () {
            yield* ensurePrivateDirectory(agentDirectory(agentId))
            yield* writePrivateFile(file(agentId, 'launch.lease'), encode(lease))
          }).pipe(Effect.mapError(fail))
        : Effect.fail(fail(new Error('Invalid lease'))),
    createLog: (agentId, turn) =>
      Number.isSafeInteger(turn) && turn > 0
        ? create(agentId, `stderr-${turn}-${Bun.randomUUIDv7()}.log`)
        : Effect.fail(fail(new Error('Invalid turn'))),
    createSession,
    delete: removeAgent,
    initialize: Effect.gen(function* () {
      yield* ensurePrivateDirectory(bunPath.join(temporaryDirectory, 'pi-codex-subagents'))
      yield* ensurePrivateDirectory(privateRoot)
      yield* ensurePrivateDirectory(root)
    }).pipe(Effect.mapError(fail)),
    listLeases: Effect.gen(function* () {
      const result: { agentId: string; lease: LaunchLease }[] = []
      for (const agentId of yield* list()) {
        const lease = yield* readValue(agentId, 'launch.lease', decodeLease)
        if (lease !== undefined) {
          result.push({ agentId, lease })
        }
      }
      return result
    }),
    listRecords: Effect.gen(function* () {
      const result: { agentId: string; record: SubagentRecord }[] = []
      for (const agentId of yield* list()) {
        const record = yield* readValue(agentId, 'record.json', decodeRecord)
        if (record !== undefined) {
          result.push({ agentId, record })
        }
      }
      return result
    }),
    prune: (now) =>
      Effect.gen(function* () {
        for (const agentId of yield* list()) {
          const record = yield* readValue(agentId, 'record.json', decodeRecord)
          if (record === undefined) {
            const lease = yield* readValue(agentId, 'launch.lease', decodeLease)
            if (lease === undefined) {
              yield* removeAgent(agentId)
            }
          } else if (record.status !== 'running' && now - record.settledAt >= RETENTION_MS) {
            const lease = yield* readValue(agentId, 'launch.lease', decodeLease)
            if (lease === undefined) {
              yield* removeAgent(agentId)
            }
          }
        }
      }),
    readArtifact: (agentId, name, maxBytes) => {
      const cappedMaxBytes = Math.min(maxBytes, MAX_ARTIFACT_BYTES)
      return readOwnerOnlyFile({ maxBytes: cappedMaxBytes, path: file(agentId, name), root: agentDirectory(agentId) }).pipe(
        Effect.map((result) => result.bytes),
        Effect.mapError((error) =>
          isArtifactTooLarge(error)
            ? new ArtifactTooLargeError({ maxBytes: cappedMaxBytes, message: `Artifact exceeds ${cappedMaxBytes} bytes` })
            : fail(error)
        )
      )
    },
    readRecord: (agentId) => readValue(agentId, 'record.json', decodeRecord),
    removeLease: (agentId, identity) => {
      const path = file(agentId, 'launch.lease')
      if (identity === undefined) {
        return removeHostPath(path).pipe(Effect.mapError(fail))
      }
      return withHeldFile(path, (handle) =>
        removeHeldFileIfUnchanged({
          contentMatches: (content) => {
            const lease = decodeLease(new TextEncoder().encode(content))
            return lease?.identity.pid === identity.pid && lease.identity.birthMarker === identity.birthMarker
          },
          handle,
          path,
        })
      ).pipe(
        Effect.catchIf(
          (error) => error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'ENOENT',
          () => Effect.succeed(false)
        ),
        Effect.mapError(fail),
        Effect.asVoid
      )
    },
    removeLog: (agentId, path) => {
      const directory = agentDirectory(agentId)
      const name = bunPath.basename(path)
      return bunPath.dirname(path) === directory && /^stderr-[1-9][0-9]*-[A-Za-z0-9-]+\.log$/.test(name)
        ? removeHostPath(path).pipe(Effect.mapError(fail))
        : Effect.fail(fail(new Error('Invalid log path')))
    },
    replaceRecord: (agentId, record) =>
      Effect.gen(function* () {
        yield* ensurePrivateDirectory(agentDirectory(agentId))
        yield* writePrivateFile(file(agentId, 'record.json'), encode(record))
        yield* removeHostPath(file(agentId, 'launch.lease'))
      }).pipe(Effect.mapError(fail)),
    writeFullResult: (agentId, content) =>
      content.byteLength > MAX_ARTIFACT_BYTES
        ? Effect.fail(fail(new Error('Full result exceeds 10 MiB')))
        : Effect.gen(function* () {
            const target = file(agentId, 'full-result.txt')
            yield* ensurePrivateDirectory(agentDirectory(agentId))
            yield* writePrivateFile(target, content)
            return target
          }).pipe(Effect.mapError(fail)),
  }
}
export const makeSubagentStoreLive = (config: SubagentStoreConfig = {}): Layer.Layer<SubagentStore> => Layer.succeed(SubagentStore)(makeStore(config))
export const SubagentStoreLive: Layer.Layer<SubagentStore> = makeSubagentStoreLive()
