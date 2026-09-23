import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect, Path } from 'effect'

import { renderFooterLines as renderFooterLinesWithPath, type FooterState, type FooterTheme } from '@/features/status_panel/footer.js'

const theme = { fg: (_color: string, text: string) => text }
const path = runtime.runSync(Path.Path)
const renderFooterLines = (state: FooterState, renderTheme: FooterTheme, width: number) => renderFooterLinesWithPath(state, renderTheme, width, path)

const state: FooterState = {
  cwd: '/Users/example/pi-extensions',
  git: { branch: 'main', changedFiles: 1, pullRequest: undefined },
  model: {
    cacheHitPercent: undefined,
    contextPercent: 12.5,
    contextTokens: 34_000,
    contextWindow: 272_000,
    modelId: 'claude-opus-5',
    provider: 'anthropic',
    thinking: 'medium',
    tokensPerSecond: undefined,
  },
  quotas: {},
}

describe('renderFooterLines', () => {
  it.effect('uses a ccstatusline-style summary followed by Git', () =>
    Effect.sync(() => {
      expect(renderFooterLines(state, theme, 80)).toEqual(['Ctx ▓░░░ 13% | claude-opus-5 · medium', 'main · 1 file changed'])
    })
  )

  it.effect('uses a singular file label and omits the branch outside a repository', () =>
    Effect.sync(() => {
      expect(renderFooterLines(state, theme, 80)[1]).toBe('main · 1 file changed')
      expect(renderFooterLines({ ...state, git: { ...state.git, changedFiles: 3 } }, theme, 80)[1]).toBe('main · 3 files changed')

      const detached = renderFooterLines({ ...state, git: { branch: undefined, changedFiles: 0, pullRequest: undefined } }, theme, 80)
      expect(detached[1]).toBe(state.cwd)
      expect(detached).toHaveLength(2)
    })
  )

  it.effect('prepends available throughput and cache hit metrics to the second row', () =>
    Effect.sync(() => {
      for (const [tokensPerSecond, cacheHitPercent, prefix] of [
        [42.4, 87.25, '42 tok/s · Cache hit 87.3% · '],
        [0, undefined, '0 tok/s · '],
        [undefined, 0, 'Cache hit 0.0% · '],
      ] as const) {
        const lines = renderFooterLines({ ...state, model: { ...state.model, cacheHitPercent, tokensPerSecond } }, theme, 80)
        expect(lines).toHaveLength(2)
        expect(lines[1]).toBe(`${prefix}main · 1 file changed`)
      }
    })
  )

  it.effect('fits session, reset, weekly, Azure and model on one row by dropping bars', () =>
    Effect.sync(() => {
      const lines = renderFooterLines(
        {
          ...state,
          quotas: {
            anthropic: {
              detail: 'verbose quota detail',
              label: 'anthropic',
              percent: 42,
              windows: [
                { label: 'Session', percent: 42, resetsIn: '3h 10m' },
                { detail: '31.62/200$', label: 'Weekly', percent: 18, resetsIn: '4d 1h' },
              ],
            },
            azure: { label: 'azure', percent: 7 },
          },
        },
        theme,
        80
      )

      expect(lines).toHaveLength(2)
      expect(lines[0]).toBe('Ctx 13% | 5h 42% 3h 10m | 7d 18% | Azure 7% | claude-opus-5 · medium')
    })
  )

  it.effect('renders quota bars when they fit, including quotas without structured windows', () =>
    Effect.sync(() => {
      const lines = renderFooterLines({ ...state, quotas: { anthropic: { label: 'anthropic', percent: 50 } } }, theme, 80)

      expect(lines[0]).toBe('Ctx ▓░░░ 13% | 5h ▓▓░░ 50% | claude-opus-5 · medium')
      expect(lines).toHaveLength(2)
    })
  )

  it.effect('keeps every line within the available width', () =>
    Effect.sync(() => {
      for (const width of [0, 1, 20, 40, 60, 80]) {
        const lines = renderFooterLines(
          {
            ...state,
            git: { ...state.git, branch: '分支'.repeat(40) },
            model: { ...state.model, cacheHitPercent: 87.25, modelId: '模型'.repeat(40), tokensPerSecond: 42.4 },
            quotas: { anthropic: { detail: 'x'.repeat(80), label: 'anthropic', percent: 99 } },
          },
          { fg: (_color, text) => `\u001b[36m${text}\u001b[0m` },
          width
        )

        expect(lines).toHaveLength(2)
        expect(lines.every((line) => visibleWidth(line) <= width)).toBeTrue()
      }
    })
  )
})
