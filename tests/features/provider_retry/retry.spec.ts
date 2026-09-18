import { type AssistantMessage, isContextOverflow, isRetryableAssistantError } from '@earendil-works/pi-ai'
import { describe, expect, it } from '@tests/utils/bun_effect.js'

import { classifyProviderError } from '@/features/provider_retry/retry.js'

const errorMessage = 'An error occurred while processing the request'
const assistant = (error: string | undefined = errorMessage, stopReason: AssistantMessage['stopReason'] = 'error'): AssistantMessage => ({
  api: 'openai-responses',
  content: [{ text: 'partial output', type: 'text' }],
  errorMessage: error,
  model: 'test',
  provider: 'test',
  role: 'assistant',
  stopReason,
  timestamp: 0,
  usage: { cacheRead: 0, cacheWrite: 0, cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 }, input: 0, output: 0, totalTokens: 0 },
})

const classify = (message: AssistantMessage, status?: number) => classifyProviderError({ message, type: 'message_end' }, status)?.message

describe('provider error classification', () => {
  it('retries any unknown-status error while preserving the diagnostic and partial output', () => {
    expect(isRetryableAssistantError(assistant())).toBe(false)
    for (const text of [errorMessage, `Error: ${errorMessage}`, 'Unexpected response', '', 'Request abc-401 failed', '4000 bytes received']) {
      const message = assistant(text)
      const replacement = classify(message)
      expect(replacement).toEqual({ ...message, errorMessage: `server error: ${text}` })
      expect(message.errorMessage).toBe(text)
      if (replacement?.role !== 'assistant') {
        throw new Error('Expected an assistant replacement')
      }
      expect(isRetryableAssistantError(replacement)).toBe(true)
      expect(classify(replacement)).toBeUndefined()
    }
    const { errorMessage: _error, ...missingError } = assistant()
    expect(classify(missingError)?.errorMessage).toBe('server error: Unknown provider error')
  })

  it('adds retries for all 5xx statuses but not other known failure statuses', () => {
    for (const status of [500, 501, 502, 503, 504, 505, 599]) {
      expect(classify(assistant(), status)).toBeDefined()
      for (const text of [`${status} failed`, `${status}: failed`, `HTTP ${status} failed`, `OpenAI API error (${status}): failed`]) {
        expect(classify(assistant(text))).toBeDefined()
      }
    }
    for (const status of [301, 400, 401, 403, 404, 408, 409, 429]) {
      expect(classify(assistant(), status)).toBeUndefined()
      for (const text of [
        `${status} failed`,
        `${status}: failed`,
        `Error: ${status} failed`,
        `HTTP ${status} failed`,
        `Azure OpenAI API error (${status}): failed`,
      ]) {
        expect(classify(assistant(text))).toBeUndefined()
      }
    }
  })

  it('uses failure response status ahead of text, but treats a failed HTTP 200 stream as unknown', () => {
    expect(classify(assistant('501 failed'), 401)).toBeUndefined()
    expect(classify(assistant('401 failed'), 501)).toBeDefined()
    expect(classify(assistant('Unexpected stream response'), 200)).toBeDefined()
    expect(classify(assistant('401 failed'), 200)).toBeUndefined()
  })

  it('leaves successful responses, aborts, and non-assistant messages unchanged', () => {
    for (const reason of ['stop', 'length', 'toolUse', 'aborted'] as const) {
      expect(classify(assistant(errorMessage, reason), 503)).toBeUndefined()
    }
    expect(classifyProviderError({ message: { content: errorMessage, role: 'user', timestamp: 0 }, type: 'message_end' })).toBeUndefined()
    expect(
      classifyProviderError({
        message: { content: [], isError: true, role: 'toolResult', timestamp: 0, toolCallId: 'a', toolName: 'bash' },
        type: 'message_end',
      })
    ).toBeUndefined()
  })

  it('preserves Pi native rate-limit retries and quota/overflow exclusions', () => {
    expect(classify(assistant('429 Too many requests'))).toBeUndefined()
    expect(isRetryableAssistantError(assistant('429 Too many requests'))).toBe(true)
    const quota = classify(assistant('Billing quota exceeded.'))
    const overflow = classify(assistant('context length exceeded'))
    if (quota?.role !== 'assistant' || overflow?.role !== 'assistant') {
      throw new Error('Expected assistant replacements')
    }
    expect(isRetryableAssistantError(quota)).toBe(false)
    expect(isContextOverflow(overflow)).toBe(true)
  })
})
