import { afterEach, describe, expect, test } from 'bun:test'

import { createFakePi } from '#test-utils/fake_pi'

import createMeridianSessionAffinityExtension from '../index.js'

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
  createMeridianSessionAffinityExtension(fixture.pi)
  return fixture
}

const context = (sessionId: string, baseUrl = 'https://api.anthropic.com') => ({
  model: { baseUrl },
  sessionManager: {
    getSessionId: () => sessionId,
  },
})

describe('meridian session affinity', () => {
  test('registers no daemon or session-start lifecycle behavior', () => {
    const fixture = createHarness()

    expect([...fixture.state.handlers.keys()]).toEqual(['before_provider_headers'])
    expect(fixture.state.commands.size).toBe(0)
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

  test('replaces stale or differently-cased affinity headers with each current session id', async () => {
    const fixture = createHarness()
    const firstEvent: { headers: Record<string, string> } = {
      headers: {
        'X-Meridian-Agent': 'pi',
        'X-Session-Affinity': 'stale',
      },
    }
    const secondEvent: { headers: Record<string, string> } = {
      headers: { 'x-meridian-agent': 'pi' },
    }

    await fixture.emit('before_provider_headers', firstEvent, context('session-one'))
    await fixture.emit('before_provider_headers', secondEvent, context('session-two'))

    expect(firstEvent.headers['X-Session-Affinity']).toBeUndefined()
    expect(firstEvent.headers['x-session-affinity']).toBe('session-one')
    expect(secondEvent.headers['x-session-affinity']).toBe('session-two')
  })
})
