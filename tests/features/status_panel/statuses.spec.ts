import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asFooterDataProvider } from '@tests/utils/casts.js'
import { Effect } from 'effect'

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
  it.effect('renders and splits a shared-channel status once despite the mirror into pi', () =>
    Effect.sync(() => {
      const channel = createStatusChannel('collect-mcp', { tone: 'muted' })
      channel.set(ctx, { text: 'MCP linear: connected\nMCP slack: needs auth' })

      const collected = collectStatuses(footerData({ 'collect-mcp': 'MCP linear: connected\nMCP slack: needs auth' }))

      expect(statusLines(collected.filter((entry) => entry.key === 'collect-mcp'))).toEqual(['MCP linear: connected', 'MCP slack: needs auth'])
      channel.clear(ctx)
    })
  )

  it.effect('keeps statuses owned by other extensions and splits their lines', () =>
    Effect.sync(() => {
      const collected = collectStatuses(footerData({ other: 'first\nsecond' }))

      expect(statusLines(collected)).toEqual(['first', 'second'])
      expect(collected.every((entry) => entry.tone === 'muted')).toBeTrue()
    })
  )

  it.effect('works without a footer data provider', () =>
    Effect.sync(() => {
      const channel = createStatusChannel('collect-solo', { icon: '🛡️' })
      channel.set(ctx, { text: 'cmd-guard' })

      expect(statusLines(collectStatuses(undefined))).toEqual(['🛡️ cmd-guard'])
      channel.clear(ctx)
    })
  )
})
