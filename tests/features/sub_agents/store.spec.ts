import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect, Fiber, Result } from 'effect'

import { ArtifactTooLargeError, makeSubagentStoreLive, SubagentStore, type SubagentRecord } from '@/features/sub_agents/store.js'
import { hostFilePermissions } from '@/shared/effect/bun_host_file_system.js'
import { bunFileSystem, bunPath } from '@/shared/effect/bun_services.js'

const profile = { contextCeiling: 1, key: 'scout' as const, model: 'model', prompt: 'prompt', provider: 'provider', tools: [] }
const record = (settledAt?: number): SubagentRecord => {
  if (settledAt === undefined) {
    return {
      identity: { birthMarker: 'birth', pid: 1 },
      logPath: 'log.txt',
      profile,
      session: 'session',
      sessionPath: 'session.json',
      status: 'running',
      taskName: 'task',
      turns: [],
    }
  }
  return { logPath: 'log.txt', profile, session: 'session', sessionPath: 'session.json', settledAt, status: 'completed', taskName: 'task', turns: [] }
}

describe('SubagentStore', () => {
  it.live('creates owner-only directories and artifacts, atomically replaces records, and retains live records', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'subagent-store-' })
      yield* Effect.provide(
        Effect.gen(function* () {
          const store = yield* SubagentStore
          yield* store.initialize
          yield* store.createLease('agent', { identity: { birthMarker: 'birth', pid: 1 }, session: 'session', taskName: 'task' })
          const log = yield* store.createLog('agent')
          const session = yield* store.createSession('agent')
          const result = yield* store.writeFullResult('agent', new TextEncoder().encode('result'))
          yield* store.replaceRecord('agent', record(1))
          yield* store.replaceRecord('agent', record(2))
          const run = bunPath.join(root, 'pi-codex-subagents', 'owner', 'runs', 'agent')
          expect(session.runDirectory).toBe(yield* bunFileSystem.realPath(run))
          expect(session.sessionPath).toBe(yield* bunFileSystem.realPath(bunPath.join(run, 'session.json')))
          for (const target of [run, log, result, session.sessionPath, bunPath.join(run, 'record.json')]) {
            const stat = yield* hostFilePermissions(target)
            expect(stat.mode).toBe(target === run ? 0o700 : 0o600)
          }
          expect(Result.isFailure(yield* Effect.result(hostFilePermissions(bunPath.join(run, 'launch.lease'))))).toBe(true)
          const stored = yield* store.readRecord('agent')
          expect(stored?.status === 'running' ? undefined : stored?.settledAt).toBe(2)
          yield* store.replaceRecord('live', record())
          yield* store.prune(2 + 7 * 24 * 60 * 60 * 1000)
          expect(yield* store.readRecord('agent')).toBeUndefined()
          expect((yield* store.readRecord('live'))?.status).toBe('running')
        }),
        makeSubagentStoreLive({ tempDirectory: root, username: 'owner' })
      )
    })
  )

  it.live('lets concurrent readers observe only complete record replacements', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'subagent-atomic-' })
      yield* Effect.provide(
        Effect.gen(function* () {
          const store = yield* SubagentStore
          yield* store.initialize
          yield* store.replaceRecord('agent', record(0))
          const replacements = Array.from({ length: 40 }, (value, index) => {
            void value
            return record(index + 1)
          })
          const writer = Effect.gen(function* () {
            for (const replacement of replacements) {
              yield* store.replaceRecord('agent', replacement)
              yield* Effect.yieldNow
            }
          })
          const reader = Effect.gen(function* () {
            for (const replacement of replacements) {
              void replacement
              const value = yield* store.readRecord('agent')
              expect(value?.status).toBe('completed')
              expect(value?.turns).toEqual([])
              yield* Effect.yieldNow
            }
          })
          const writing = yield* Effect.forkDetach(writer)
          yield* reader
          yield* Fiber.join(writing)
        }),
        makeSubagentStoreLive({ tempDirectory: root, username: 'owner' })
      )
    })
  )

  it.live('cleans malformed settled artifacts but never prunes a live record', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'subagent-retention-' })
      yield* Effect.provide(
        Effect.gen(function* () {
          const store = yield* SubagentStore
          yield* store.initialize
          yield* store.replaceRecord('live', record())
          yield* store.replaceRecord('boundary', record(7 * 24 * 60 * 60 * 1000))
          const malformed = bunPath.join(root, 'pi-codex-subagents', 'owner', 'runs', 'malformed')
          yield* bunFileSystem.makeDirectory(malformed)
          yield* bunFileSystem.writeFileString(bunPath.join(malformed, 'record.json'), '{bad')
          yield* bunFileSystem.chmod(bunPath.join(malformed, 'record.json'), 0o600)
          yield* store.prune(14 * 24 * 60 * 60 * 1000)
          expect((yield* store.readRecord('live'))?.status).toBe('running')
          expect(yield* store.readRecord('boundary')).toBeUndefined()
          expect(Result.isFailure(yield* Effect.result(hostFilePermissions(malformed)))).toBe(true)
        }),
        makeSubagentStoreLive({ tempDirectory: root, username: 'owner' })
      )
    })
  )

  it.live('enumerates artifacts without deleting counterparts and preserves provisional leases while pruning', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'subagent-enumeration-' })
      yield* Effect.provide(
        Effect.gen(function* () {
          const store = yield* SubagentStore
          yield* store.initialize
          yield* store.replaceRecord('record-only', record(1))
          yield* store.createLease('lease-only', { identity: { birthMarker: 'birth', pid: 1 }, session: 'session', taskName: 'task' })
          expect((yield* store.listLeases).map(({ agentId }) => agentId)).toEqual(['lease-only'])
          expect((yield* store.readRecord('record-only'))?.status).toBe('completed')
          expect((yield* store.listRecords).map(({ agentId }) => agentId)).toEqual(['record-only'])
          expect((yield* store.listLeases).map(({ agentId }) => agentId)).toEqual(['lease-only'])
          yield* store.prune(1 + 7 * 24 * 60 * 60 * 1000)
          expect((yield* store.listLeases).map(({ agentId }) => agentId)).toEqual(['lease-only'])
          expect(yield* store.readRecord('record-only')).toBeUndefined()
        }),
        makeSubagentStoreLive({ tempDirectory: root, username: 'owner' })
      )
    })
  )

  it.live('reports physically oversized artifacts without returning an oversized copy', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'subagent-oversize-' })
      yield* Effect.provide(
        Effect.gen(function* () {
          const store = yield* SubagentStore
          yield* store.initialize
          yield* store.createLease('agent', { identity: { birthMarker: 'birth', pid: 1 }, session: 'session', taskName: 'task' })
          const artifact = yield* store.artifactPath('agent', 'oversized.txt')
          yield* bunFileSystem.writeFile(artifact, new Uint8Array(10 * 1024 * 1024 + 1))
          yield* bunFileSystem.chmod(artifact, 0o600)
          const outcome = yield* Effect.result(store.readArtifact('agent', 'oversized.txt', 10 * 1024 * 1024))
          expect(Result.isFailure(outcome)).toBe(true)
          if (Result.isFailure(outcome) && outcome.failure instanceof ArtifactTooLargeError) {
            expect(outcome.failure.maxBytes).toBe(10 * 1024 * 1024)
          } else {
            expect(false).toBe(true)
          }
        }),
        makeSubagentStoreLive({ tempDirectory: root, username: 'owner' })
      )
    })
  )

  it.live('rejects insecure records and bounded full results', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'subagent-security-' })
      yield* Effect.provide(
        Effect.gen(function* () {
          const store = yield* SubagentStore
          yield* store.initialize
          yield* store.replaceRecord('agent', record(1))
          const target = yield* store.artifactPath('agent', 'record.json')
          yield* bunFileSystem.chmod(target, 0o644)
          expect(Result.isFailure(yield* Effect.result(store.readRecord('agent')))).toBe(true)
          expect(Result.isFailure(yield* Effect.result(store.writeFullResult('agent', new Uint8Array(10 * 1024 * 1024 + 1))))).toBe(true)
        }),
        makeSubagentStoreLive({ tempDirectory: root, username: 'owner' })
      )
    })
  )
})
