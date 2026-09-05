import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext } from '@tests/utils/casts.js'
import { deferred } from '@tests/utils/deferred.js'
import { withProcessEnv } from '@tests/utils/process_env.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect, Path } from 'effect'

import {
  createSidebarController,
  renderSidebarLines as renderSidebarLinesWithPath,
  type RenderSidebarLinesOptions,
  type SidebarState,
} from '@/features/status_panel/sidebar.js'

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
}
const path = runtime.runSync(Path.Path)
const renderSidebarLines = (options: Omit<RenderSidebarLinesOptions, 'path'>) => renderSidebarLinesWithPath({ ...options, path })

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
    agentId: `scout-${index}`,
    color: 'accent' as const,
    lastActivityAt: 0,
    name: `/scout-${index}`,
    profile: 'scout',
    sessionId: 'session',
    state: 'running' as const,
  })),
})

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

const stripAnsi = (text: string) => text.replace(ANSI_PATTERN, '')

describe('sidebar rendering', () => {
  it.effect('renders the Atelier-style information hierarchy', () =>
    Effect.sync(() => {
      const lines = renderSidebarLines({ height: 36, now: 0, state, theme, width: 44 })
      const text = stripAnsi(lines.join('\n'))

      expect(lines).toHaveLength(36)
      expect(lines.every((line) => visibleWidth(line) <= 44)).toBeTrue()
      expect(lines.every((line) => stripAnsi(line).startsWith('  '))).toBeTrue()
      expect(lines.some((line) => stripAnsi(line).trim() === '')).toBeTrue()

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
  )

  it.effect('uses semantic theme colors instead of a fixed RGB palette', () =>
    withProcessEnv('NO_COLOR', undefined, () =>
      Effect.sync(() => {
        const colors = new Set<string>()
        const lines = renderSidebarLines({
          height: 36,
          now: 0,
          state,
          theme: {
            bold: (text: string) => text,
            fg: (color: string, text: string) => {
              colors.add(color)
              return text
            },
          },
          width: 44,
        })

        expect(colors).toEqual(new Set(['warning', 'text', 'muted', 'thinkingLow', 'accent']))
        expect(lines.join('\n')).not.toContain('\x1b[38;2;')
      })
    )
  )

  it.effect('does not apply palette or theme colors when NO_COLOR is set', () =>
    withProcessEnv('NO_COLOR', '1', () =>
      Effect.sync(() => {
        let colorCalls = 0
        const lines = renderSidebarLines({
          height: 36,
          state: withAgents(1),
          theme: {
            bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
            fg: (_color: string, text: string) => {
              colorCalls += 1
              return `\x1b[31m${text}\x1b[39m`
            },
          },
          width: 44,
        })

        expect(colorCalls).toBe(0)
        expect(lines.join('\n')).not.toContain('\x1b[38;2;')
      })
    )
  )

  it.effect('renders session and weekly quota as matching bars with their time left', () =>
    Effect.sync(() => {
      const lines = renderSidebarLines({ height: 36, now: 0, state, theme, width: 44 }).map(stripAnsi)
      const quotaIndex = lines.findIndex((line) => line.includes('QUOTA'))
      const quotaLines = lines.slice(quotaIndex + 1, quotaIndex + 5)
      if (quotaLines.length < 4) {
        throw new Error('expected quota meter rows')
      }
      const [session, sessionMeter, weekly, weeklyMeter] = quotaLines

      expect(session).toContain('Session')
      expect(session).toContain('42.3%')
      expect(sessionMeter).toMatch(/■+·+ +2h 14m/)
      expect(weekly).toContain('Weekly')
      expect(weekly).toContain('18.0%')
      expect(weekly).not.toContain('31.62/200$')
      expect(weeklyMeter).toMatch(/■+·+ +4d 6h 31\.62\/200\$/)
      expect(sessionMeter.indexOf('2h 14m') + '2h 14m'.length).toBe(weeklyMeter.indexOf('31.62/200$') + '31.62/200$'.length)
      expect(lines.slice(quotaIndex).join('\n')).toContain('Azure')
    })
  )

  it.effect('falls back to a single labelled bar when only Azure quota is available', () =>
    Effect.sync(() => {
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
  )

  it.effect('pulses only the working Agent jewel', () =>
    Effect.sync(() => {
      const first = stripAnsi(renderSidebarLines({ height: 20, now: 0, state, theme, width: 44 }).join('\n'))
      const second = stripAnsi(renderSidebarLines({ height: 20, now: 400, state, theme, width: 44 }).join('\n'))

      expect(first).toContain('╭─ ✦ AGENT')
      expect(second).toContain('╭─ ✧ AGENT')
      expect(second).toContain('╭─ ✦ CONTEXT')
    })
  )

  it.effect('lists running subagents and hides the panel when none are running', () =>
    Effect.sync(() => {
      const text = stripAnsi(renderSidebarLines({ height: 36, now: 0, state: withAgents(2), theme, width: 44 }).join('\n'))

      expect(text).toContain('╭─ ✦ SUBAGENTS')
      expect(text).toContain('▸ /scout-0')
      expect(text).toContain('▸ /scout-1')
      expect(text).toContain('scout')
      expect(stripAnsi(renderSidebarLines({ height: 36, now: 0, state, theme, width: 44 }).join('\n'))).not.toContain('SUBAGENTS')
    })
  )

  it.effect('caps the subagent list so a large fan-out cannot crowd out other panels', () =>
    Effect.sync(() => {
      const text = stripAnsi(renderSidebarLines({ height: 40, now: 0, state: withAgents(9), theme, width: 44 }).join('\n'))

      expect(text).toContain('▸ /scout-4')
      expect(text).not.toContain('▸ /scout-5')
      expect(text).toContain('+4 more')
    })
  )

  it.effect('renders MCP servers in their own panel instead of STATUS', () =>
    Effect.sync(() => {
      const lines = renderSidebarLines({
        height: 48,
        state: {
          ...state,
          extensionStatuses: [
            { key: 'mcp', text: 'MCP linear: connected' },
            { key: 'mcp', text: 'MCP slack: auth needed' },
            { key: 'index', text: 'index ready' },
          ],
        },
        theme,
        width: 44,
      }).map(stripAnsi)
      const mcpIndex = lines.findIndex((line) => line.includes('MCP'))
      const statusIndex = lines.findIndex((line) => line.includes('STATUS'))

      expect(mcpIndex).toBeGreaterThan(-1)
      expect(statusIndex).toBeGreaterThan(mcpIndex)
      expect(lines.slice(mcpIndex, statusIndex).join('\n')).toContain('linear: connected')
      expect(lines.slice(mcpIndex, statusIndex).join('\n')).toContain('slack: auth needed')
      expect(lines.slice(statusIndex).join('\n')).toContain('index ready')
      expect(lines.slice(statusIndex).join('\n')).not.toContain('linear: connected')
    })
  )

  it.effect('keeps running subagents visible after other optional panels are dropped', () =>
    Effect.sync(() => {
      const text = stripAnsi(renderSidebarLines({ height: 20, now: 0, state: withAgents(2), theme, width: 44 }).join('\n'))

      expect(text).toContain('SUBAGENTS')
      expect(text).not.toContain('QUOTA')
      expect(text).not.toContain('STATUS')
    })
  )

  it.effect('drops optional panels as terminal height contracts', () =>
    Effect.sync(() => {
      const text = stripAnsi(renderSidebarLines({ height: 12, now: 0, state, theme, width: 44 }).join('\n'))

      expect(text).toContain('AGENT')
      expect(text).toContain('CONTEXT')
      expect(text).not.toContain('WORKSPACE')
      expect(text).not.toContain('QUOTA')
      expect(text).not.toContain('STATUS')
    })
  )

  it.effect('keeps output bounded at narrow sidebar widths', () =>
    Effect.sync(() => {
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
  )

  it.effect('renders unavailable context explicitly', () =>
    Effect.sync(() => {
      const unavailable = {
        ...state,
        model: { ...state.model, contextPercent: undefined, contextTokens: undefined },
      }
      const text = stripAnsi(renderSidebarLines({ height: 20, state: unavailable, theme, width: 44 }).join('\n'))

      expect(text).toContain('Context unavailable')
    })
  )
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

const renderMainPane = (_width: number) => []

const fakeTui = (onRender: () => void = () => undefined) => {
  const renderer = {
    render: renderMainPane,
    requestRender: onRender,
    terminal: { columns: 120, rows: 30 },
  }
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'render') {
          return (width: number) => renderer.render(width)
        }
        return Reflect.get(renderer, property, renderer)
      },
      getPrototypeOf: () => ({ render: renderMainPane }),
      set(_target, property, value) {
        return Reflect.set(renderer, property, value, renderer)
      },
    }
  )
}

const controllerTheme = { bold: (text: string) => text, fg: (_color: string, text: string) => text }

const flushMicrotasks = (): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.promise(() => Promise.resolve())
      yield* Effect.promise(() => Promise.resolve())
    })
  )

describe('sidebar controller overlay race', () => {
  it.effect('does not let a stale generation clobber a newer overlay once it is active', () =>
    Effect.gen(function* () {
      const calls: CustomCall[] = []
      const hiddenHandles: string[] = []
      const renderRequests: string[] = []
      const firstTui = fakeTui(() => renderRequests.push('first'))
      const secondTui = fakeTui(() => renderRequests.push('second'))
      const ctx = asExtensionContext({
        mode: 'tui',
        ui: {
          custom: (factory: CustomCall['factory'], options: CustomCall['options']) => {
            const result = deferred<void>()
            calls.push({ factory, options, resolve: () => result.resolve(undefined) })
            return result.promise
          },
        },
      })

      const sidebar = createSidebarController({ ctx, getState: () => state, path })

      sidebar.show()
      expect(calls).toHaveLength(1)
      if (calls.length === 0) {
        throw new Error('expected a first overlay request')
      }
      const [first] = calls

      sidebar.hide()
      sidebar.show()
      expect(calls).toHaveLength(2)
      if (calls.length < 2) {
        throw new Error('expected a second overlay request')
      }
      const [, second] = calls

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
      yield* Effect.promise(() => flushMicrotasks())
      sidebar.requestRender()

      expect(hiddenHandles).toEqual(['first'])
      expect(renderRequests).not.toContain('first')
      expect(renderRequests.at(-1)).toBe('second')
      expect(sidebar.isVisible()).toBeTrue()

      sidebar.dispose()
    })
  )
})
