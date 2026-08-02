import { describe, expect, test } from 'bun:test'

import { asExtensionContext } from '#test-utils/casts'

import { createStatusChannel, formatStatusText, statusBar } from '../status_bar'

const createContext = (hasUI = true) => {
  const written: { key: string; value: unknown }[] = []
  const ctx = asExtensionContext({
    hasUI,
    ui: {
      setStatus(key: string, value: unknown) {
        written.push({ key, value })
      },
    },
  })
  return { ctx, written }
}

describe('status bar channel', () => {
  test('publishes structured entries and mirrors plain text into pi', () => {
    const channel = createStatusChannel('demo-set', { icon: '⏳', tone: 'warning' })
    const { ctx, written } = createContext()

    channel.set(ctx, { text: '2 polls' })

    expect(statusBar.list()).toContainEqual({
      icon: '⏳',
      key: 'demo-set',
      text: '2 polls',
      tone: 'warning',
    })
    expect(written).toEqual([{ key: 'demo-set', value: '⏳ 2 polls' }])

    channel.clear(ctx)
    expect(statusBar.has('demo-set')).toBeFalse()
    expect(written.at(-1)).toEqual({ key: 'demo-set', value: undefined })
  })

  test('lets a call override channel defaults', () => {
    const channel = createStatusChannel('demo-override', { tone: 'muted' })
    const { ctx } = createContext()

    channel.set(ctx, { text: 'failed', tone: 'error' })

    expect(statusBar.list().find((entry) => entry.key === 'demo-override')?.tone).toBe('error')
    channel.clear(ctx)
  })

  test('still tracks state when the session has no UI', () => {
    const channel = createStatusChannel('demo-headless')
    const { ctx, written } = createContext(false)

    channel.set(ctx, { text: 'connected' })

    expect(statusBar.has('demo-headless')).toBeTrue()
    expect(written).toBeEmpty()
    channel.clear(ctx)
  })

  test('orders entries by priority then key', () => {
    const { ctx } = createContext()
    const late = createStatusChannel('demo-b', { priority: 50 })
    const early = createStatusChannel('demo-a', { priority: 10 })
    const tie = createStatusChannel('demo-a-tie', { priority: 10 })

    late.set(ctx, { text: 'late' })
    tie.set(ctx, { text: 'tie' })
    early.set(ctx, { text: 'early' })

    expect(statusBar.list().map((entry) => entry.key)).toEqual(['demo-a', 'demo-a-tie', 'demo-b'])

    for (const channel of [late, early, tie]) {
      channel.clear(ctx)
    }
  })

  test('notifies subscribers on publish and clear', () => {
    const channel = createStatusChannel('demo-events')
    const { ctx } = createContext()
    let notifications = 0
    const unsubscribe = statusBar.subscribe(() => notifications++)

    channel.set(ctx, { text: 'one' })
    channel.clear(ctx)
    channel.clear(ctx)
    unsubscribe()
    channel.set(ctx, { text: 'two' })

    expect(notifications).toBe(2)
    channel.clear(ctx)
  })
})

describe('formatStatusText', () => {
  test('prefixes the icon only when one is set', () => {
    expect(formatStatusText({ text: 'ready' })).toBe('ready')
    expect(formatStatusText({ icon: '🛡️', text: 'cmd-guard' })).toBe('🛡️ cmd-guard')
  })
})
