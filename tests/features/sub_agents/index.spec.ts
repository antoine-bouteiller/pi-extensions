import { describe, expect, it } from '@tests/utils/bun_effect.js'

import { feature } from '@/features/sub_agents/index.js'

describe('sub-agent feature registration', () => {
  it('is an eager parent-only feature', () => {
    expect(feature.bootstrap).toBe('eager')
    expect(feature.id).toBe('sub-agents')
  })
})
