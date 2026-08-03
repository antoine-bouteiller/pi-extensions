import { describe, expect, test } from 'bun:test'

import { asExtensionContext, asFooterDataProvider } from '@tests/utils/casts.js'

import { collectStatuses, statusLines } from '@/features/status_panel/statuses.js'
import { createStatusChannel } from '@/shared/state/status_bar.js'

const ctx = asExtensionContext({
  hasUI: true,
  ui: { setStatus: () => undefined },
})

const footerData = (entries: Record<string, string>) =>
  asFooterDataProvider({
    getExtensionStatuses: () => new Map(Object.entries(entries)),
  })

describe('collectStatuses', () => {
  test('renders a shared-channel status once despite the mirror into pi', () => {
    const channel = createStatusChannel('collect-mcp', { tone: 'muted' })
    channel.set(ctx, { text: 'MCP: 2 connected' })

    const collected = collectStatuses(footerData({ 'collect-mcp': 'MCP: 2 connected' }))

    expect(collected.filter((entry) => entry.key === 'collect-mcp')).toHaveLength(1)
    channel.clear(ctx)
  })

  test('keeps statuses owned by other extensions and splits their lines', () => {
    const collected = collectStatuses(footerData({ other: 'first\nsecond' }))

    expect(statusLines(collected)).toEqual(['first', 'second'])
    expect(collected.every((entry) => entry.tone === 'muted')).toBeTrue()
  })

  test('works without a footer data provider', () => {
    const channel = createStatusChannel('collect-solo', { icon: '🛡️' })
    channel.set(ctx, { text: 'cmd-guard' })

    expect(statusLines(collectStatuses(undefined))).toEqual(['🛡️ cmd-guard'])
    channel.clear(ctx)
  })
})
