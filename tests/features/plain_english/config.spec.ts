import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Option } from 'effect'

import { loadConfig, makeToggle, proseLength } from '@/features/plain_english/config.js'

describe('plain_english configuration', () => {
  it('uses defaults when no environment values are configured', () => {
    const config = loadConfig({})

    expect(Option.isNone(config.model)).toBe(true)
    expect(config.minChars).toBe(200)
    expect(config.timeoutMs).toBe(45_000)
    expect(config.mdTimeoutMs).toBe(150_000)
  })

  it('falls back for malformed numeric values and model configuration', () => {
    const config = loadConfig({
      PI_PLAIN_ENGLISH_MD_TIMEOUT_MS: 'Infinity',
      PI_PLAIN_ENGLISH_MIN_CHARS: '0',
      PI_PLAIN_ENGLISH_MODEL: '/model',
      PI_PLAIN_ENGLISH_TIMEOUT_MS: 'not-a-number',
    })

    expect(Option.isNone(config.model)).toBe(true)
    expect(Option.isNone(loadConfig({ PI_PLAIN_ENGLISH_MODEL: 'provider/' }).model)).toBe(true)
    expect(Option.isNone(loadConfig({ PI_PLAIN_ENGLISH_MODEL: 'provider' }).model)).toBe(true)
    expect(config.minChars).toBe(200)
    expect(config.timeoutMs).toBe(45_000)
    expect(config.mdTimeoutMs).toBe(150_000)
  })

  it('parses a model provider and preserves slashes in the model id', () => {
    const config = loadConfig({ PI_PLAIN_ENGLISH_MODEL: 'anthropic/claude/sonnet' })

    expect(Option.getOrUndefined(config.model)).toEqual({ modelId: 'claude/sonnet', provider: 'anthropic' })
  })

  it('defaults toggles to enabled and allows inversion', () => {
    const toggle = makeToggle()

    expect(toggle.get()).toBe(true)
    toggle.set(false)
    expect(toggle.get()).toBe(false)
    toggle.set(true)
    expect(toggle.get()).toBe(true)
  })

  it('excludes fenced code blocks from prose length', () => {
    expect(proseLength('Prose before\n```ts\nconst hidden = true\n```\nProse after')).toBe('Prose before\n\nProse after'.length)
  })
})
