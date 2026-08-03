import { describe, expect, test } from 'bun:test'

import { visibleWidth } from '@earendil-works/pi-tui'
import { asExtensionContext } from '@tests/utils/casts.js'

import { createSidebarController, renderSidebarLines, type SidebarState } from '@/features/status_panel/sidebar.js'

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
}

const state: SidebarState = {
  activity: 'working',
  agents: [],
  cwd: '/Users/example/pi-extensions',
  extensionStatuses: [{ key: 'index', text: 'index ready' }],
  git: {
    branch: 'feature/sidebar',
    changedFiles: 4,
    pullRequest: undefined,
  },
  model: {
    contextPercent: 11.5,
    contextTokens: 31_000,
    contextWindow: 272_000,
    modelId: 'gpt-5.6-sol',
    provider: 'openai-codex',
    thinking: 'medium',
  },
  quotas: {
    anthropic: {
      label: 'anthropic',
      percent: 42.3,
      windows: [
        { label: 'Session', percent: 42.3, resetsIn: '2h 14m' },
        { detail: '31.62/200$', label: 'Weekly', percent: 18, resetsIn: '4d 6h' },
      ],
    },
    azure: { label: 'azure', percent: 71 },
  },
}

const withAgents = (count: number): SidebarState => ({
  ...state,
  agents: Array.from({ length: count }, (_value, index) => ({
    color: 'accent' as const,
    name: `/scout-${index}`,
    profile: 'scout',
  })),
})

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

const stripAnsi = (text: string) => text.replace(ANSI_PATTERN, '')

describe('sidebar rendering', () => {
  test('renders the Atelier-style information hierarchy', () => {
    const lines = renderSidebarLines({ height: 36, now: 0, state, theme, width: 44 })
    const text = stripAnsi(lines.join('\n'))

    expect(lines).toHaveLength(36)
    expect(lines.every((line) => visibleWidth(line) <= 44)).toBeTrue()
    expect(lines.every((line) => stripAnsi(line).startsWith('│ '))).toBeTrue()
    expect(text).toContain('╭─ ✦ AGENT')
    expect(text).toContain('◆ Working')
    expect(text).toContain('gpt-5.6-sol')
    expect(text).toContain('╭─ ✦ CONTEXT')
    expect(text).toContain('31k / 272k')
    expect(text).toContain('11.5%')
    expect(text).toContain('╭─ ✦ WORKSPACE')
    expect(text).toContain('feature/sidebar')
    expect(text).toContain('4 files changed')
    expect(text).toContain('╭─ ✦ QUOTA')
  })

  test('renders session and weekly quota as matching bars with their time left', () => {
    const lines = renderSidebarLines({ height: 36, now: 0, state, theme, width: 44 }).map(stripAnsi)
    const quotaIndex = lines.findIndex((line) => line.includes('QUOTA'))
    const [session, sessionMeter, weekly, weeklyMeter] = lines.slice(quotaIndex + 1, quotaIndex + 5)

    expect(session).toContain('Session')
    expect(session).toContain('42.3%')
    expect(sessionMeter).toMatch(/■+·+ +2h 14m/)
    expect(weekly).toContain('Weekly')
    expect(weekly).toContain('18.0%')
    expect(weekly).not.toContain('31.62/200$')
    expect(weeklyMeter).toMatch(/■+·+ +4d 6h 31\.62\/200\$/)
    if (!sessionMeter || !weeklyMeter) {
      throw new Error('expected quota meter rows')
    }
    expect(sessionMeter.indexOf('2h 14m') + '2h 14m'.length).toBe(weeklyMeter.indexOf('31.62/200$') + '31.62/200$'.length)
    expect(lines.slice(quotaIndex).join('\n')).toContain('Azure')
  })

  test('falls back to a single labelled bar when only Azure quota is available', () => {
    const text = stripAnsi(
      renderSidebarLines({
        height: 36,
        now: 0,
        state: { ...state, quotas: { azure: { label: 'azure', percent: 71 } } },
        theme,
        width: 44,
      }).join('\n')
    )

    expect(text).toContain('Azure')
    expect(text).toContain('71.0%')
  })

  test('pulses only the working Agent jewel', () => {
    const first = stripAnsi(renderSidebarLines({ height: 20, now: 0, state, theme, width: 44 }).join('\n'))
    const second = stripAnsi(renderSidebarLines({ height: 20, now: 400, state, theme, width: 44 }).join('\n'))

    expect(first).toContain('╭─ ✦ AGENT')
    expect(second).toContain('╭─ ✧ AGENT')
    expect(second).toContain('╭─ ✦ CONTEXT')
  })

  test('lists running subagents and hides the panel when none are running', () => {
    const text = stripAnsi(renderSidebarLines({ height: 36, now: 0, state: withAgents(2), theme, width: 44 }).join('\n'))

    expect(text).toContain('╭─ ✦ SUBAGENTS')
    expect(text).toContain('▸ /scout-0')
    expect(text).toContain('▸ /scout-1')
    expect(text).toContain('scout')
    expect(stripAnsi(renderSidebarLines({ height: 36, now: 0, state, theme, width: 44 }).join('\n'))).not.toContain('SUBAGENTS')
  })

  test('caps the subagent list so a large fan-out cannot crowd out other panels', () => {
    const text = stripAnsi(renderSidebarLines({ height: 40, now: 0, state: withAgents(9), theme, width: 44 }).join('\n'))

    expect(text).toContain('▸ /scout-4')
    expect(text).not.toContain('▸ /scout-5')
    expect(text).toContain('+4 more')
  })

  test('keeps running subagents visible after other optional panels are dropped', () => {
    const text = stripAnsi(renderSidebarLines({ height: 20, now: 0, state: withAgents(2), theme, width: 44 }).join('\n'))

    expect(text).toContain('SUBAGENTS')
    expect(text).not.toContain('QUOTA')
    expect(text).not.toContain('STATUS')
  })

  test('drops optional panels as terminal height contracts', () => {
    const text = stripAnsi(renderSidebarLines({ height: 12, now: 0, state, theme, width: 44 }).join('\n'))

    expect(text).toContain('AGENT')
    expect(text).toContain('CONTEXT')
    expect(text).not.toContain('WORKSPACE')
    expect(text).not.toContain('QUOTA')
    expect(text).not.toContain('STATUS')
  })

  test('keeps output bounded at narrow sidebar widths', () => {
    const long: SidebarState = {
      ...state,
      cwd: `/Users/example/${'界'.repeat(60)}`,
      extensionStatuses: [{ key: 'status', text: `status ${'z'.repeat(100)}` }],
      model: { ...state.model, modelId: `model-${'x'.repeat(100)}` },
    }

    for (const width of [1, 2, 8, 28, 44]) {
      const lines = renderSidebarLines({ height: 24, state: long, theme, width })
      expect(lines).toHaveLength(24)
      expect(lines.every((line) => visibleWidth(line) <= width)).toBeTrue()
    }
    expect(stripAnsi(renderSidebarLines({ height: 24, state: long, theme, width: 28 }).join('\n'))).toContain('◆ Working')
  })

  test('renders unavailable context explicitly', () => {
    const unavailable = {
      ...state,
      model: { ...state.model, contextPercent: undefined, contextTokens: undefined },
    }
    const text = stripAnsi(renderSidebarLines({ height: 20, state: unavailable, theme, width: 44 }).join('\n'))

    expect(text).toContain('Context unavailable')
  })
})

interface FakeOverlayHandle {
  hide: () => void
}

interface CustomCall {
  factory: (
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    done: (value: void) => void
  ) => { render: (width: number) => string[]; invalidate: () => void }
  options: { onHandle?: (handle: FakeOverlayHandle) => void }
  resolve: (value: void) => void
}

const fakeTui = (onRender: () => void = () => undefined) => ({
  render: (_width: number) => [],
  requestRender: onRender,
  terminal: { columns: 120, rows: 30 },
})

const controllerTheme = { bold: (text: string) => text, fg: (_color: string, text: string) => text }

const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('sidebar controller overlay race', () => {
  test('does not let a stale generation clobber a newer overlay once it is active', async () => {
    const calls: CustomCall[] = []
    const hiddenHandles: string[] = []
    const renderRequests: string[] = []
    const firstTui = fakeTui(() => renderRequests.push('first'))
    const secondTui = fakeTui(() => renderRequests.push('second'))
    const ctx = asExtensionContext({
      mode: 'tui',
      ui: {
        custom: (factory: CustomCall['factory'], options: CustomCall['options']) =>
          new Promise<void>((resolve) => {
            calls.push({ factory, options, resolve })
          }),
      },
    })

    const sidebar = createSidebarController({ ctx, getState: () => state })

    sidebar.show()
    expect(calls).toHaveLength(1)
    const [first] = calls
    if (!first) {
      throw new Error('expected a first overlay request')
    }

    sidebar.hide()
    sidebar.show()
    expect(calls).toHaveLength(2)
    const [, second] = calls
    if (!second) {
      throw new Error('expected a second overlay request')
    }

    // The newer overlay attaches and is accepted first.
    second.factory(secondTui, controllerTheme, {}, second.resolve)
    const secondHandle: FakeOverlayHandle = { hide: () => hiddenHandles.push('second') }
    second.options.onHandle?.(secondHandle)
    expect(sidebar.isVisible()).toBeTrue()

    // The stale first generation now delivers its callbacks late: attach, onHandle, and the custom() promise settling via .finally().
    first.factory(firstTui, controllerTheme, {}, first.resolve)
    const firstHandle: FakeOverlayHandle = { hide: () => hiddenHandles.push('first') }
    first.options.onHandle?.(firstHandle)
    first.resolve()
    await flushMicrotasks()
    sidebar.requestRender()

    expect(hiddenHandles).toEqual(['first'])
    expect(renderRequests).not.toContain('first')
    expect(renderRequests.at(-1)).toBe('second')
    expect(sidebar.isVisible()).toBeTrue()

    sidebar.dispose()
  })

  test('redraws only while working and stops the redraw fiber on dispose', async () => {
    const calls: CustomCall[] = []
    let renderRequests = 0
    let currentState: SidebarState = { ...state, activity: 'ready' }
    const tui = fakeTui(() => {
      renderRequests += 1
    })
    const ctx = asExtensionContext({
      mode: 'tui',
      ui: {
        custom: (factory: CustomCall['factory'], options: CustomCall['options']) =>
          new Promise<void>((resolve) => {
            calls.push({ factory, options, resolve })
          }),
      },
    })
    const sidebar = createSidebarController({ ctx, getState: () => currentState, redrawMs: 10 })

    sidebar.show()
    const [overlay] = calls
    if (!overlay) {
      throw new Error('expected an overlay request')
    }
    overlay.factory(tui, controllerTheme, {}, overlay.resolve)
    const idleRenders = renderRequests
    await Bun.sleep(30)
    expect(renderRequests).toBe(idleRenders)

    currentState = { ...currentState, activity: 'working' }
    sidebar.requestRender()
    await Bun.sleep(30)
    expect(renderRequests).toBeGreaterThan(idleRenders + 1)

    currentState = { ...currentState, activity: 'ready' }
    await Bun.sleep(15)
    currentState = { ...currentState, activity: 'working' }
    sidebar.requestRender()
    const rendersAtRestart = renderRequests
    await Bun.sleep(15)
    expect(renderRequests).toBeGreaterThan(rendersAtRestart)

    sidebar.dispose()
    const rendersAfterDispose = renderRequests
    await Bun.sleep(30)
    expect(renderRequests).toBe(rendersAfterDispose)
  })
})
