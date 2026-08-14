import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'

import {
  AGENT_CONFIGS,
  AGENT_PROFILE_NAMES,
  configuredProfileColor,
  firstAvailable,
  getAgentProfileNames,
  getAgentProfilesDescription,
  hasModelId,
  isClaudeModelId,
  parseModelSelector,
  resolveAgentConfig,
  resolveModelSelector,
  type AgentConfig,
  type ModelSelectorContext,
} from '@/features/sub_agents/profiles.js'

const availableModels = [
  { id: 'gpt-5.6-luna', provider: 'azure-openai-responses' },
  { id: 'gpt-5.6-luna', provider: 'openai' },
  { id: 'claude-haiku-4-5', provider: 'anthropic' },
  { id: 'claude-sonnet-5', provider: 'anthropic' },
  { id: 'claude-opus-5', provider: 'anthropic' },
  { id: 'gpt-5.6-sol', provider: 'openai' },
  { id: 'gpt-5.6-terra', provider: 'openai' },
] as const

const context = {
  availableModels,
  parentModel: { id: 'gpt-5.6-sol', provider: 'openai' },
}

describe('model selectors', () => {
  it.effect('parses bare and provider-qualified exact selectors', () =>
    Effect.sync(() => {
      expect(parseModelSelector('claude-sonnet-5')).toEqual({ id: 'claude-sonnet-5' })
      expect(parseModelSelector('anthropic/claude-sonnet-5')).toEqual({
        id: 'claude-sonnet-5',
        provider: 'anthropic',
      })
      expect(() => parseModelSelector('anthropic/')).toThrow('Invalid provider-qualified')
    })
  )

  it.effect('prefers the canonical provider, then official variants, deterministically', () =>
    Effect.sync(() => {
      expect(resolveModelSelector('gpt-5.6-luna', availableModels)).toEqual({
        id: 'gpt-5.6-luna',
        provider: 'openai',
      })
      expect(
        resolveModelSelector('gpt-5.6-luna', [
          { id: 'gpt-5.6-luna', provider: 'custom-z' },
          { id: 'gpt-5.6-luna', provider: 'azure-openai-responses' },
        ])
      ).toEqual({ id: 'gpt-5.6-luna', provider: 'azure-openai-responses' })
      expect(resolveModelSelector('anthropic/claude-sonnet-5', availableModels)).toEqual({ id: 'claude-sonnet-5', provider: 'anthropic' })
    })
  )

  it.effect('uses only exact authenticated non-Google models', () =>
    Effect.sync(() => {
      expect(() => resolveModelSelector('gpt-5.6', availableModels)).toThrow('not authenticated')
      expect(() => resolveModelSelector('gemini-2.5-pro', [{ id: 'gemini-2.5-pro', provider: 'google' }])).toThrow('not authenticated')
      expect(hasModelId(availableModels, 'claude-opus-5')).toBe(true)
      expect(firstAvailable(availableModels, 'missing', 'claude-opus-5')).toBe('claude-opus-5')
    })
  )

  it.effect('recognizes Claude by model family across providers', () =>
    Effect.sync(() => {
      expect(isClaudeModelId('claude-opus-5')).toBe(true)
      expect(isClaudeModelId('CLAUDE-custom')).toBe(true)
      expect(isClaudeModelId('gpt-5.6-sol')).toBe(false)
    })
  )
})

describe('generic agent registry', () => {
  it.effect('contains the four built-ins and generates descriptions from registry keys', () =>
    Effect.sync(() => {
      expect(AGENT_PROFILE_NAMES).toEqual(['scout', 'librarian', 'implementer', 'reviewer'])
      const description = getAgentProfilesDescription()
      for (const key of AGENT_PROFILE_NAMES) {
        expect(description).toContain(`\`${key}\``)
      }
      expect(configuredProfileColor('librarian')).toBe('mdLink')
      expect(configuredProfileColor('missing')).toBe('muted')
    })
  )

  it.effect('normalizes defaults for a future entry with only the four required fields', () =>
    Effect.sync(() => {
      const registry = {
        future: {
          allowedTools: ['read', 'read'],
          isReadonly: true,
          model: 'anthropic/claude-haiku-4-5',
          prompt: 'Do future work.',
        },
      } satisfies Record<string, AgentConfig>
      expect(getAgentProfileNames(registry)).toEqual(['future'])
      expect(getAgentProfilesDescription(registry)).toContain('`future` — future')
      expect(resolveAgentConfig('future', context, registry)).toMatchObject({
        allowedTools: ['read'],
        color: 'accent',
        description: 'future',
        isReadonly: true,
        key: 'future',
        modelId: 'claude-haiku-4-5',
        provider: 'anthropic',
        thinking: 'high',
      })
    })
  )

  it.effect('passes immutable context to function selectors', () =>
    Effect.sync(() => {
      let received: ModelSelectorContext | undefined
      const registry = {
        selected: {
          allowedTools: ['read'],
          isReadonly: true,
          model: (selectorContext) => {
            received = selectorContext
            return selectorContext.parentModel.provider === 'openai' ? 'claude-opus-5' : 'gpt-5.6-sol'
          },
          prompt: 'Review.',
        },
      } satisfies Record<string, AgentConfig>
      expect(resolveAgentConfig('selected', context, registry).modelId).toBe('claude-opus-5')
      expect(Object.isFrozen(received)).toBe(true)
      expect(Object.isFrozen(received?.availableModels)).toBe(true)
      expect(Object.isFrozen(received?.availableModels[0])).toBe(true)
      expect(Object.isFrozen(received?.parentModel)).toBe(true)
    })
  )

  it.effect('resolves every built-in solely from its config', () =>
    Effect.sync(() => {
      const expected = {
        implementer: {
          color: 'success',
          isReadonly: false,
          modelId: 'gpt-5.6-terra',
          thinking: 'medium',
        },
        librarian: {
          color: 'mdLink',
          isReadonly: true,
          modelId: 'gpt-5.6-luna',
          thinking: 'low',
        },
        reviewer: {
          color: 'warning',
          isReadonly: true,
          modelId: 'gpt-5.6-sol',
          thinking: 'high',
        },
        scout: {
          color: 'accent',
          isReadonly: true,
          modelId: 'gpt-5.6-luna',
          thinking: 'low',
        },
      } as const
      for (const key of AGENT_PROFILE_NAMES) {
        const resolved = resolveAgentConfig(key, context)
        expect(resolved).toMatchObject(expected[key])
        expect(resolved.allowedTools).toEqual(AGENT_CONFIGS[key].allowedTools)
        expect(resolved.prompt.length).toBeGreaterThan(20)
      }
      expect(
        resolveAgentConfig('reviewer', {
          ...context,
          parentModel: { id: 'claude-opus-5', provider: 'anthropic' },
        }).modelId
      ).toBe('gpt-5.6-sol')
    })
  )

  it.effect('fails unknown, unavailable, and invalid selector results', () =>
    Effect.sync(() => {
      expect(() => resolveAgentConfig('missing', context)).toThrow('Unknown agent profile')
      expect(() =>
        resolveAgentConfig('scout', {
          ...context,
          availableModels: availableModels.filter((model) => model.id !== 'gpt-5.6-luna'),
        })
      ).toThrow('not authenticated')
      const registry = {
        bad: {
          allowedTools: ['read'],
          isReadonly: false,
          model: () => '',
          prompt: 'Bad.',
        },
      } satisfies Record<string, AgentConfig>
      expect(() => resolveAgentConfig('bad', context, registry)).toThrow('must not be empty')
    })
  )
})
