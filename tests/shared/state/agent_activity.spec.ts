import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'

import { createAgentActivityStore, type RunningAgent } from '@/shared/state/agent_activity.js'

describe('agent activity store', () => {
  it.effect('publishes a snapshot that later mutations cannot change', () =>
    Effect.sync(() => {
      const store = createAgentActivityStore()
      const published: RunningAgent[] = [
        { agentId: 'scout', color: 'accent', lastActivityAt: 0, name: '/scout', sessionId: 'session', state: 'running' },
      ]

      store.publish(published)
      published.push({ agentId: 'reviewer', color: 'warning', lastActivityAt: 0, name: '/reviewer', sessionId: 'session', state: 'running' })

      expect(store.list()).toEqual([{ agentId: 'scout', color: 'accent', lastActivityAt: 0, name: '/scout', sessionId: 'session', state: 'running' }])
    })
  )

  it.effect('notifies subscribers until they unsubscribe', () =>
    Effect.sync(() => {
      const store = createAgentActivityStore()
      let notifications = 0
      const unsubscribe = store.subscribe(() => notifications++)

      store.publish([{ agentId: 'scout', color: 'accent', lastActivityAt: 0, name: '/scout', sessionId: 'session', state: 'running' }])
      store.publish([])
      unsubscribe()
      store.publish([{ agentId: 'scout', color: 'accent', lastActivityAt: 0, name: '/scout', sessionId: 'session', state: 'running' }])

      expect(notifications).toBe(2)
      expect(store.list()).toEqual([{ agentId: 'scout', color: 'accent', lastActivityAt: 0, name: '/scout', sessionId: 'session', state: 'running' }])
    })
  )
})
