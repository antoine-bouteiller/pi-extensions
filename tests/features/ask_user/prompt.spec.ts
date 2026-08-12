import { describe, expect, it } from '@tests/utils/bun_effect.js'

import { buildAskUserResultMessage } from '@/features/ask_user/prompt.js'

describe('ask_user result messages', () => {
  it.effect('describes selected and custom answers', () => {
    expect(buildAskUserResultMessage({ answer: 'Ship it', index: 2, kind: 'selected' })).toBe('User selected option 2: Ship it')
    expect(buildAskUserResultMessage({ answer: 'Wait until Friday', kind: 'custom' })).toBe('User wrote their own answer: Wait until Friday')
  })

  it.effect('does not invent an answer when dismissed', () => {
    expect(buildAskUserResultMessage({ kind: 'dismissed' })).toContain('Do not assume an answer')
    expect(buildAskUserResultMessage({ kind: 'no-ui' })).toContain('plain text')
  })
})
