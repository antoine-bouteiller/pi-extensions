import { describe, expect, test } from 'bun:test'

import { visibleWidth } from '@earendil-works/pi-tui'

import { renderFooterLines, type FooterState } from '@/features/status_panel/footer.js'

const theme = { fg: (_color: string, text: string) => text }

const state: FooterState = {
  cwd: '/Users/example/pi-extensions',
  git: { branch: 'main', changedFiles: 1, pullRequest: undefined },
  model: {
    contextPercent: 12.5,
    contextTokens: 34_000,
    contextWindow: 272_000,
    modelId: 'claude-opus-5',
    provider: 'anthropic',
    thinking: 'medium',
  },
  quotas: {},
  statuses: [],
}

describe('renderFooterLines', () => {
  test('always shows the directory, model and context', () => {
    const lines = renderFooterLines(state, theme, 80)

    expect(lines[0]).toContain('pi-extensions')
    expect(lines[0]).toContain('claude-opus-5 · medium')
    expect(lines[1]).toContain('34k/272k (13%)')
  })

  test('uses a singular file label and omits the branch outside a repository', () => {
    expect(renderFooterLines(state, theme, 80)[2]).toBe('main · 1 file changed')
    expect(renderFooterLines({ ...state, git: { ...state.git, changedFiles: 3 } }, theme, 80)[2]).toBe('main · 3 files changed')

    const detached = renderFooterLines({ ...state, git: { branch: undefined, changedFiles: 0, pullRequest: undefined } }, theme, 80)
    expect(detached.join('\n')).not.toContain('changed')
  })

  test('renders Claude and Azure quotas together', () => {
    const lines = renderFooterLines(
      {
        ...state,
        quotas: {
          anthropic: { detail: '3h 10m  Weekly: 18.0% 31.62/200$', label: 'anthropic', percent: 42 },
          azure: { label: 'azure', percent: 7 },
        },
      },
      theme,
      80
    )

    expect(lines.at(-2)).toContain('Session:')
    expect(lines.at(-2)).toContain('31.62/200$')
    expect(lines.at(-1)).toContain('Azure:')
  })

  test('renders each status with its icon', () => {
    const lines = renderFooterLines(
      {
        ...state,
        statuses: [
          { icon: '🛡️', key: 'safety', text: 'cmd-guard', tone: 'success' },
          { key: 'mcp', text: 'MCP: 2 connected' },
        ],
      },
      theme,
      80
    )

    expect(lines.at(-2)).toBe('🛡️ cmd-guard')
    expect(lines.at(-1)).toBe('MCP: 2 connected')
  })

  test('keeps every line within the available width', () => {
    const lines = renderFooterLines(
      {
        ...state,
        cwd: `/Users/example/${'deep-'.repeat(40)}`,
        quotas: { anthropic: { detail: 'x'.repeat(80), label: 'anthropic', percent: 99 } },
        statuses: [{ key: 'long', text: 'z'.repeat(200) }],
      },
      theme,
      40
    )

    expect(lines.every((line) => visibleWidth(line) <= 40)).toBeTrue()
  })
})
