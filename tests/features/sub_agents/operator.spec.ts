import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'

import { type PersistedResolvedProfile } from '@/features/sub_agents/model.js'
import { createActivityProjection, createSubagentsOperator } from '@/features/sub_agents/operator.js'
import { type SubagentRecord, type SubagentStoreApi } from '@/features/sub_agents/store.js'
import { bunFileSystem, bunPath } from '@/shared/effect/bun_services.js'

const profile: PersistedResolvedProfile = {
  contextCeiling: 1,
  key: 'scout',
  model: 'model',
  prompt: 'prompt',
  provider: 'provider',
  tools: [],
}
const settled = (session: string, taskName: string, sessionPath: string): SubagentRecord => ({
  logPath: 'worker.log',
  profile,
  session,
  sessionPath,
  settledAt: 1,
  status: 'completed',
  taskName,
  turns: [],
})
const store = (records: readonly { readonly agentId: string; readonly record: SubagentRecord }[]): SubagentStoreApi => ({
  artifactPath: (_agentId, name) => Effect.succeed(name),
  createLease: () => Effect.void,
  createLog: () => Effect.succeed('worker.log'),
  createSession: () => Effect.succeed({ runDirectory: '/run', sessionPath: '/run/session.json' }),
  delete: () => Effect.void,
  initialize: Effect.void,
  listLeases: Effect.succeed([]),
  listRecords: Effect.succeed(records),
  prune: () => Effect.void,
  readArtifact: () => Effect.succeed(new Uint8Array()),
  readRecord: (agentId) => Effect.succeed(records.find((entry) => entry.agentId === agentId)?.record),
  removeLease: () => Effect.void,
  replaceRecord: () => Effect.void,
  writeFullResult: () => Effect.succeed('result'),
})

describe('sub-agent operator activity projection', () => {
  it.effect('publishes one ready agent, updates verified activity, and removes settled or closed agents', () =>
    Effect.sync(() => {
      const snapshots: string[][] = []
      const projection = createActivityProjection({
        publish: (agents) => {
          snapshots.push(agents.map((agent) => agent.agentId ?? ''))
        },
      })
      const scout = {
        agentId: 'scout',
        color: 'thinkingLow' as const,
        lastActivityAt: 1,
        name: 'find-files',
        sessionId: 'one',
        state: 'running' as const,
      }

      projection.publishReady(scout)
      projection.publishReady(scout)
      projection.updateActivity('scout', 2)
      projection.closeSession('other')
      projection.closeSession('one')

      expect(snapshots).toEqual([['scout'], ['scout'], ['scout'], []])
      expect(projection.list()).toEqual([])
    })
  )

  it.scoped('refreshes growing transcripts, retains the last content after removal, then marks it unavailable', () =>
    Effect.gen(function* () {
      const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'operator-transcript-' })
      const path = bunPath.join(root, 'session.json')
      yield* bunFileSystem.writeFileString(path, '{"event":1}\n')
      yield* bunFileSystem.chmod(path, 0o600)
      const operator = createSubagentsOperator({
        activity: () => [],
        sessionId: 'current',
        store: store([{ agentId: 'one', record: settled('current', 'task', path) }]),
      })
      const transcript = operator.open('one')
      yield* transcript.refresh
      expect(transcript.content().entries).toEqual([{ event: 1 }])
      yield* bunFileSystem.writeFileString(path, '{"event":1}\n{"event":2}\n')
      yield* transcript.refresh
      expect(transcript.content().entries).toEqual([{ event: 1 }, { event: 2 }])
      yield* bunFileSystem.remove(path)
      yield* transcript.refresh
      expect(transcript.content()).toEqual({ entries: [{ event: 1 }, { event: 2 }], turns: [], unavailable: true })
    })
  )

  it.effect('lists durable current-session records and decorates only their ready-running activity', () =>
    Effect.gen(function* () {
      const records = [
        { agentId: 'settled', record: settled('current', 'settled-task', '/run/settled.json') },
        {
          agentId: 'running',
          record: {
            identity: { birthMarker: 'birth', pid: 1 },
            logPath: 'running.log',
            profile,
            session: 'current',
            sessionPath: '/run/running.json',
            status: 'running' as const,
            taskName: 'running-task',
            turns: [],
          },
        },
      ]
      const operator = createSubagentsOperator({
        activity: () => [
          { agentId: 'ghost', color: 'muted', lastActivityAt: 8, name: 'ghost', sessionId: 'current', state: 'running' },
          { agentId: 'running', color: 'thinkingLow', lastActivityAt: 9, name: 'running-task', sessionId: 'current', state: 'running' },
          { agentId: 'settled', color: 'thinkingLow', lastActivityAt: 10, name: 'settled-task', sessionId: 'other', state: 'running' },
        ],
        sessionId: 'current',
        store: store(records),
      })
      expect(yield* operator.list).toEqual([
        { agentId: 'settled', lastActivityAt: undefined, profile: 'scout', status: 'completed', taskName: 'settled-task' },
        { agentId: 'running', lastActivityAt: 9, profile: 'scout', status: 'running', taskName: 'running-task' },
      ])
    })
  )
})
