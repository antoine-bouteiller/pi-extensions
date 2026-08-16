import { Effect } from 'effect'

import { createAgentActivityStore, type RunningAgent } from '#shared/state/agent_activity'
import { describe, expect, it } from '#tests/utils/effect'

describe('agent activity store', () => {
  it.effect('publishes a snapshot that later mutations cannot change', () =>
    Effect.sync(() => {
      const store = createAgentActivityStore()
      const published: RunningAgent[] = [{ color: 'accent', name: '/scout' }]

      store.publish(published)
      published.push({ color: 'warning', name: '/reviewer' })

      expect(store.list()).toEqual([{ color: 'accent', name: '/scout' }])
    })
  )

  it.effect('notifies subscribers until they unsubscribe', () =>
    Effect.sync(() => {
      const store = createAgentActivityStore()
      let notifications = 0
      const unsubscribe = store.subscribe(() => notifications++)

      store.publish([{ color: 'accent', name: '/scout' }])
      store.publish([])
      unsubscribe()
      store.publish([{ color: 'accent', name: '/scout' }])

      expect(notifications).toBe(2)
      expect(store.list()).toEqual([{ color: 'accent', name: '/scout' }])
    })
  )
})
