import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'

import { renderFooterLine, renderStatusLine, type StatusTheme } from '@/features/status_panel/footer.js'
import { emptyModelInfoState, type ModelInfoState } from '@/features/status_panel/state.js'

const plain: StatusTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
  getThinkingBorderColor: () => (text) => text,
}
const tagged: StatusTheme = { ...plain, fg: (color, text) => `<${color}>${text}` }

const model: ModelInfoState = {
  ...emptyModelInfoState(),
  cacheHitPercent: 87.4,
  contextPercent: 12.5,
  contextTokens: 34_000,
  contextWindow: 272_000,
  modelId: 'claude-opus-5',
  thinking: 'medium',
  tokensPerSecond: 42.4,
}

describe('renderStatusLine', () => {
  it.effect('shows ready, model and thinking level', () =>
    Effect.sync(() => {
      expect(renderStatusLine(model, plain, 80)).toBe('● Ready › claude-opus-5 · medium')
      expect(visibleWidth(renderStatusLine(model, plain, 12))).toBeLessThanOrEqual(12)
    })
  )

  it.effect('replaces ready with the activity, giving it only the width the model leaves', () =>
    Effect.sync(() => {
      const widths: number[] = []
      const activity = (width: number) => {
        widths.push(width)
        return '⠋ Working…'
      }
      expect(renderStatusLine(model, plain, 40, activity)).toBe('⠋ Working… › claude-opus-5 · medium')
      expect(widths).toEqual([40 - ' › claude-opus-5 · medium'.length])
    })
  )
})

describe('renderFooterLine', () => {
  it.effect('puts context on the left and cache hit and throughput on the right', () =>
    Effect.sync(() => {
      const line = renderFooterLine(model, plain, 60)
      expect(line).toBe(`ctx ■········· 12.5% · 34k / 272k${' '.repeat(7)}cache 87% · 42 tok/s`)
      expect(visibleWidth(line)).toBe(60)
    })
  )

  it.effect('omits missing metrics and marks unknown context usage', () =>
    Effect.sync(() => {
      expect(renderFooterLine({ ...model, cacheHitPercent: undefined, tokensPerSecond: undefined }, plain, 40)).toBe(
        'ctx ■········· 12.5% · 34k / 272k'
      )
      expect(renderFooterLine({ ...model, cacheHitPercent: undefined }, plain, 40).trimEnd()).toEndWith('42 tok/s')
      expect(renderFooterLine(emptyModelInfoState(), plain, 40)).toBe('ctx ·········· — / —')
    })
  )

  it.effect('escalates the context colour as the window fills', () =>
    Effect.sync(() => {
      expect(renderFooterLine({ ...model, contextPercent: 69 }, tagged, 80)).toStartWith('<muted>ctx')
      expect(renderFooterLine({ ...model, contextPercent: 70 }, tagged, 80)).toStartWith('<warning>ctx')
      expect(renderFooterLine({ ...model, contextPercent: 90 }, tagged, 80)).toStartWith('<error>ctx')
    })
  )

  it.effect('stays within narrow widths', () =>
    Effect.sync(() => {
      expect(visibleWidth(renderFooterLine(model, plain, 24))).toBeLessThanOrEqual(24)
    })
  )
})
