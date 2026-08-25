import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'

import { createActivityProjection } from '@/features/sub_agents/operator.js'

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
})
