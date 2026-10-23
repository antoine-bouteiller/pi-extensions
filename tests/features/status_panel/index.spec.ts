import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtimeWithEnvironment } from '@tests/utils/runtime.js'
import { Effect } from 'effect'

import { feature } from '@/features/status_panel/index.js'
import { columns, formatTokens } from '@/features/status_panel/render.js'

const runtime = runtimeWithEnvironment(process.env)

interface Rendered {
  render: (width: number) => string[]
  setWorkingStatusIndicator?: (indicator: unknown) => void
}
type Factory = (...args: unknown[]) => Rendered

const previousEditor: Factory = () => ({ render: () => [] })

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
  getThinkingBorderColor: () => (text: string) => text,
}

const harness = (mode: 'tui' | 'rpc' = 'tui') => {
  const fixture = createFakePi()
  const descriptor = feature()
  descriptor.implementation.register(fixture.pi, runtime)
  const tui = { requestRender: () => undefined, terminal: { columns: 80, rows: 30 } }
  const ui = {
    editor: undefined as Factory | undefined,
    footer: undefined as Factory | undefined,
  }
  let usage = { contextWindow: 200_000, percent: 6.2, tokens: 12_345 }
  const ctx = asExtensionContext({
    cwd: '/project',
    getContextUsage: () => usage,
    mode,
    model: { contextWindow: 200_000, id: 'gpt-test', provider: 'openai', reasoning: true },
    ui: {
      getEditorComponent: () => previousEditor,
      setEditorComponent: (factory?: Factory) => {
        ui.editor = factory
      },
      setFooter: (factory?: Factory) => {
        ui.footer = factory
      },
      setTitle: () => undefined,
      theme,
    },
  })
  return {
    activate: () =>
      Effect.promise(() =>
        runtime.runPromise(descriptor.implementation.activate?.({ reason: 'startup', type: 'session_start' }, ctx) ?? Effect.void)
      ),
    ctx,
    deactivate: () => Effect.promise(() => runtime.runPromise(descriptor.implementation.deactivate?.(ctx, 'shutdown') ?? Effect.void)),
    emit: (name: string, event: unknown = {}) => Effect.promise(() => fixture.emit(name, event, ctx)),
    fixture,
    footerLine: (width: number) => ui.footer?.(tui, theme, {}).render(width) ?? [],
    makeEditor: () => ui.editor?.(tui, { borderColor: (text: string) => text, selectList: {} }, {}),
    previousEditor,
    setUsage: (next: typeof usage) => {
      usage = next
    },
    topBorder: (width: number) => ui.editor?.(tui, { borderColor: (text: string) => text, selectList: {} }, {}).render(width)[0],
    ui,
  }
}

describe('status panel', () => {
  it.effect('registers the main-session lifecycle handlers', () =>
    Effect.sync(() => {
      expect([...harness().fixture.state.handlers.keys()]).toEqual([
        'model_select',
        'thinking_level_select',
        'message_end',
        'turn_end',
        'agent_settled',
      ])
    })
  )

  it.effect('shows activity, model and thinking in the editor border and context metrics in a one-line footer', () =>
    Effect.gen(function* () {
      const panel = harness()
      panel.fixture.pi.getThinkingLevel = () => 'low'
      yield* panel.activate()

      expect(panel.topBorder(60)).toBe(`╭─ ● Ready › gpt-test · low ${'─'.repeat(31)}╮`)
      expect(panel.footerLine(60)).toEqual(['ctx 6.2% · 12k / 200k'])

      yield* panel.emit('thinking_level_select', { level: 'high' })
      expect(panel.topBorder(60)).toStartWith('╭─ ● Ready › gpt-test · high ')

      const now = Date.now()
      yield* panel.emit('message_end', {
        message: { role: 'assistant', timestamp: now - 2000, usage: { cacheRead: 900, cacheWrite: 0, input: 100, output: 100 } },
      })
      panel.setUsage({ contextWindow: 200_000, percent: 10, tokens: 20_000 })
      yield* panel.emit('agent_settled')
      expect(panel.topBorder(60)).toStartWith('╭─ ● Ready ')
      expect(panel.footerLine(60)[0]).toMatch(/^ctx 10\.0% · 20k \/ 200k +cache 90% · \d+ tok\/s$/)
    })
  )

  it.effect('frames every editor row within the terminal width', () =>
    Effect.gen(function* () {
      const panel = harness()
      yield* panel.activate()
      const lines = panel.makeEditor()?.render(40) ?? []
      expect(lines.length).toBeGreaterThanOrEqual(3)
      expect(lines.map((line) => visibleWidth(line))).toEqual(lines.map(() => 40))
      expect(lines.at(-1)).toBe(`╰${'─'.repeat(38)}╯`)
      for (const line of lines.slice(1, -1)) {
        expect(line).toStartWith('│ ')
        expect(line).toEndWith(' │')
      }
    })
  )

  it.effect("shows Pi's working or compaction indicator in place of ready while keeping the model", () =>
    Effect.gen(function* () {
      const panel = harness()
      yield* panel.activate()
      const editor = panel.makeEditor()
      editor?.setWorkingStatusIndicator?.({ renderInBorder: () => 'Compacting…', renderSpinnerInBorder: () => '⠋' })
      expect(editor?.render(40)[0]).toStartWith('╭─ Compacting… › gpt-test · off ─')
      editor?.setWorkingStatusIndicator?.(undefined)
      expect(editor?.render(40)[0]).toStartWith('╭─ ● Ready ')
    })
  )

  it.effect('drops the status when the editor is too narrow and the frame when it is narrower still', () =>
    Effect.gen(function* () {
      const panel = harness()
      yield* panel.activate()
      expect(panel.topBorder(16)).toBe(`╭${'─'.repeat(14)}╮`)
      expect(panel.topBorder(7)).toBe('─'.repeat(7))
    })
  )

  it.effect('restores the previous editor and the stock footer on shutdown', () =>
    Effect.gen(function* () {
      const panel = harness()
      yield* panel.activate()
      expect(panel.ui.footer).toBeDefined()
      yield* panel.deactivate()
      expect(panel.ui.footer).toBeUndefined()
      expect(panel.ui.editor).toBe(panel.previousEditor)
    })
  )

  it.effect('installs nothing outside TUI mode', () =>
    Effect.gen(function* () {
      const panel = harness('rpc')
      yield* panel.activate()
      expect(panel.ui.footer).toBeUndefined()
      expect(panel.ui.editor).toBeUndefined()
    })
  )
})

describe('status panel formatting', () => {
  it.effect('formats token counts and keeps columns within the available width', () =>
    Effect.sync(() => {
      expect(formatTokens(999)).toBe('999')
      expect(formatTokens(12_400)).toBe('12k')
      expect(formatTokens(1_250_000)).toBe('1.3M')
      expect(Bun.stringWidth(columns('a very long branch name', 'model/context', 20))).toBeLessThanOrEqual(20)
    })
  )
})
