import { afterEach, describe, expect, test } from 'bun:test'

import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'

import { register as registerMeridianSessionAffinity } from '@/features/meridian_session_affinity/index.js'

const originalMeridianBaseUrl = process.env.MERIDIAN_BASE_URL

afterEach(() => {
  if (originalMeridianBaseUrl === undefined) {
    delete process.env.MERIDIAN_BASE_URL
  } else {
    process.env.MERIDIAN_BASE_URL = originalMeridianBaseUrl
  }
})

const createHarness = () => {
  const fixture = createFakePi()
  registerMeridianSessionAffinity(fixture.pi, runtime)
  return fixture
}

const context = (sessionId: string, baseUrl = 'https://api.anthropic.com', headers: Record<string, string> = {}) => ({
  model: { baseUrl, headers },
  sessionManager: {
    getSessionId: () => sessionId,
  },
})

describe('meridian session affinity', () => {
  test('registers only request-scoped lifecycle behavior', () => {
    const fixture = createHarness()

    expect([...fixture.state.handlers.keys()]).toEqual(['before_agent_start', 'before_provider_headers'])
    expect(fixture.state.commands.size).toBe(0)
  })

  test('scrubs Pi fingerprints from the system prompt before an agent starts', async () => {
    const fixture = createHarness()
    const systemPrompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read files

Pi documentation (read only when the user asks about pi itself):
- Main documentation: /home/user/pi-coding-agent/README.md
Current date: 7/10/2026
Current working directory: /repo`

    const results = await fixture.emit('before_agent_start', { systemPrompt }, context('session-a', 'http://127.0.0.1:3456'))

    expect(results).toEqual([
      {
        systemPrompt: `You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.
Available tools:
- read: Read files

Current date: 7/10/2026
Current working directory: /repo`,
      },
    ])
  })

  test('recognizes a Meridian header configured on the model when scrubbing', async () => {
    const fixture = createHarness()
    const systemPrompt =
      'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n'

    const results = await fixture.emit(
      'before_agent_start',
      { systemPrompt },
      context('session-a', 'https://api.anthropic.com', { 'X-Meridian-Agent': 'pi' })
    )

    expect(results).toEqual([
      {
        systemPrompt: 'You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.',
      },
    ])
  })

  test('does not scrub system prompts sent directly to non-Meridian providers', async () => {
    const fixture = createHarness()
    const systemPrompt = 'You are an expert coding assistant operating inside pi, a coding agent harness. Keep this direct-provider prompt.\n'

    const results = await fixture.emit('before_agent_start', { systemPrompt }, context('session-a'))

    expect(results).toEqual([undefined])
  })

  test('adds the Pi session id to requests identified by the Meridian agent header', async () => {
    const fixture = createHarness()
    const event: { headers: Record<string, string> } = {
      headers: {
        authorization: 'Bearer x',
        'x-meridian-agent': 'pi',
      },
    }

    await fixture.emit('before_provider_headers', event, context('session-a'))

    expect(event.headers).toEqual({
      authorization: 'Bearer x',
      'x-meridian-agent': 'pi',
      'x-session-affinity': 'session-a',
    })
  })

  test('recognizes the configured Meridian base URL without relying on static headers', async () => {
    process.env.MERIDIAN_BASE_URL = 'https://meridian.example.test/proxy/'
    const fixture = createHarness()
    const event: { headers: Record<string, string> } = { headers: {} }

    await fixture.emit('before_provider_headers', event, context('session-b', 'https://meridian.example.test/proxy'))

    expect(event.headers['x-session-affinity']).toBe('session-b')
  })

  test('does not leak session affinity to non-Meridian providers', async () => {
    const fixture = createHarness()
    const event: { headers: Record<string, string> } = {
      headers: { authorization: 'Bearer direct-anthropic-key' },
    }

    await fixture.emit('before_provider_headers', event, context('private-session', 'https://api.anthropic.com'))

    expect(event.headers['x-session-affinity']).toBeUndefined()
  })

  test('uses stable, distinct affinity ids for subagent sessions', async () => {
    const fixture = createHarness()
    const firstEvent: { headers: Record<string, string> } = {
      headers: {
        'X-Meridian-Agent': 'pi',
        'X-Session-Affinity': 'stale',
      },
    }
    const firstFollowup: { headers: Record<string, string> } = {
      headers: { 'x-meridian-agent': 'pi' },
    }
    const secondEvent: { headers: Record<string, string> } = {
      headers: { 'x-meridian-agent': 'pi' },
    }

    await fixture.emit('before_provider_headers', firstEvent, context('subagent-one'))
    await fixture.emit('before_provider_headers', firstFollowup, context('subagent-one'))
    await fixture.emit('before_provider_headers', secondEvent, context('subagent-two'))

    expect(firstEvent.headers['X-Session-Affinity']).toBeUndefined()
    expect(firstEvent.headers['x-session-affinity']).toBe('subagent-one')
    expect(firstFollowup.headers['x-session-affinity']).toBe(firstEvent.headers['x-session-affinity'])
    expect(secondEvent.headers['x-session-affinity']).toBe('subagent-two')
    expect(secondEvent.headers['x-session-affinity']).not.toBe(firstEvent.headers['x-session-affinity'])
  })
})
