import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asResult } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtimeWithEnvironment } from '@tests/utils/runtime.js'
import { Effect, Scope } from 'effect'

import { feature } from '@/features/status_panel/index.js'
import { columns, formatTokens } from '@/features/status_panel/render.js'
import { publishStatus } from '@/shared/state/status_bar.js'

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
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

interface TitleModel {
  readonly setting?: string
  readonly available?: boolean
  readonly reply?: string
}

const harness = (mode: 'tui' | 'rpc' = 'tui', titleModel: TitleModel = {}) => {
  const titleRequests: { model: string; prompt: unknown }[] = []
  let replyTitle: (() => void) | undefined
  const fixture = createFakePi()
  fixture.pi.getSettings = () => asResult(titleModel.setting === undefined ? {} : { sessionTitleModel: titleModel.setting })
  let sessionName: string | undefined
  fixture.pi.getSessionName = () => sessionName
  fixture.pi.setSessionName = (name) => {
    sessionName = name
  }
  const scope = Scope.makeUnsafe()
  const descriptor = feature()
  descriptor.implementation.register(fixture.pi, runtime)
  let renders = 0
  const tui = {
    requestRender: () => {
      renders++
    },
    terminal: { columns: 80, rows: 30 },
  }
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
    modelRegistry: {
      complete: (model: { provider: string; id: string }, context: { messages: { content: unknown }[] }) => {
        titleRequests.push({ model: `${model.provider}/${model.id}`, prompt: context.messages[0]?.content })
        return new Promise((resolve) => {
          replyTitle = () =>
            resolve(
              titleModel.reply === undefined
                ? { content: [], stopReason: 'error' }
                : { content: [{ text: titleModel.reply, type: 'text' }], stopReason: 'stop' }
            )
        })
      },
      find: (provider: string, id: string) => (titleModel.available === false ? undefined : { id, provider }),
    },
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
        runtime.runPromise(
          (descriptor.implementation.activate?.({ reason: 'startup', type: 'session_start' }, ctx) ?? Effect.void).pipe(
            Effect.provideService(Scope.Scope, scope)
          )
        )
      ),
    ctx,
    deactivate: () => Effect.promise(() => runtime.runPromise(descriptor.implementation.deactivate?.(ctx, 'shutdown') ?? Effect.void)),
    emit: (name: string, event: unknown = {}) => Effect.promise(() => fixture.emit(name, event, ctx)),
    fixture,
    footerLine: (width: number) => ui.footer?.(tui, theme, {}).render(width) ?? [],
    makeEditor: () => ui.editor?.(tui, { borderColor: (text: string) => text, selectList: {} }, {}),
    previousEditor,
    renders: () => renders,
    replyTitle: () =>
      Effect.promise(async () => {
        await tick()
        replyTitle?.()
        await tick()
      }),
    sessionName: () => sessionName,
    setUsage: (next: typeof usage) => {
      usage = next
    },
    titleModel,
    titleRequests,
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
        'before_agent_start',
      ])
    })
  )

  it.effect('shows activity, model and thinking in the editor border and context metrics in a one-line footer', () =>
    Effect.gen(function* () {
      const panel = harness()
      panel.fixture.pi.getThinkingLevel = () => 'low'
      yield* panel.activate()

      expect(panel.topBorder(60)).toBe(`╭─ ● Ready › gpt-test · low ${'─'.repeat(31)}╮`)
      expect(panel.footerLine(60)).toEqual(['ctx ■········· 6.2% · 12k / 200k'])

      yield* panel.emit('thinking_level_select', { level: 'high' })
      expect(panel.topBorder(60)).toStartWith('╭─ ● Ready › gpt-test · high ')

      const now = Date.now()
      yield* panel.emit('message_end', {
        message: { role: 'assistant', timestamp: now - 2000, usage: { cacheRead: 900, cacheWrite: 0, input: 100, output: 100 } },
      })
      panel.setUsage({ contextWindow: 200_000, percent: 10, tokens: 20_000 })
      yield* panel.emit('agent_settled')
      expect(panel.topBorder(60)).toStartWith('╭─ ● Ready ')
      expect(panel.footerLine(60)[0]).toMatch(/^ctx ■········· 10\.0% · 20k \/ 200k +cache 90% · \d+ tok\/s$/)
    })
  )

  it.effect('[VC-2] shows shared status entries in the footer and re-renders when one is published', () =>
    Effect.gen(function* () {
      const panel = harness()
      yield* panel.activate()
      expect(panel.footerLine(80)[0]).not.toContain('2 sub-agents')
      const before = panel.renders()
      publishStatus('panel-test', { priority: 30, text: '2 sub-agents', tone: 'muted' })
      expect(panel.renders()).toBe(before + 1)
      expect(panel.footerLine(80)[0]).toEndWith('2 sub-agents')
      yield* panel.deactivate()
      const after = panel.renders()
      publishStatus('panel-test', undefined)
      expect(panel.renders()).toBe(after)
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

  it.effect('installs nothing and names nothing outside TUI mode', () =>
    Effect.gen(function* () {
      const panel = harness('rpc', { reply: 'Fix login', setting: 'anthropic/claude-haiku-4-5' })
      yield* panel.activate()
      yield* panel.emit('before_agent_start', { messageType: 'user', prompt: 'fix the login bug' })
      expect(panel.ui.footer).toBeUndefined()
      expect(panel.ui.editor).toBeUndefined()
      expect(panel.titleRequests).toEqual([])
      expect(panel.sessionName()).toBeUndefined()
    })
  )

  it.effect('names an unnamed session from its first prompt with the configured model without waiting for the title', () =>
    Effect.gen(function* () {
      const panel = harness('tui', { reply: '"Fix login redirect."\nextra', setting: 'anthropic/claude-haiku-4-5' })
      yield* panel.activate()
      yield* panel.emit('before_agent_start', { messageType: 'user', prompt: 'fix the login bug' })
      expect(panel.sessionName()).toBeUndefined()
      yield* panel.replyTitle()
      expect(panel.sessionName()).toBe('Fix login redirect')
      expect(panel.titleRequests).toEqual([{ model: 'anthropic/claude-haiku-4-5', prompt: 'fix the login bug' }])
      panel.fixture.pi.setSessionName = () => undefined
      yield* panel.emit('before_agent_start', { messageType: 'user', prompt: 'next' })
      expect(panel.titleRequests).toHaveLength(1)
    })
  )

  it.effect('keeps a name the session already has or gets while the title is pending', () =>
    Effect.gen(function* () {
      const named = harness('tui', { reply: 'Generated', setting: 'anthropic/claude-haiku-4-5' })
      named.fixture.pi.setSessionName('my name')
      yield* named.activate()
      yield* named.emit('before_agent_start', { messageType: 'user', prompt: 'hello' })
      expect(named.titleRequests).toEqual([])

      const renamed = harness('tui', { reply: 'Generated', setting: 'anthropic/claude-haiku-4-5' })
      yield* renamed.activate()
      yield* renamed.emit('before_agent_start', { messageType: 'user', prompt: 'hello' })
      renamed.fixture.pi.setSessionName('my name')
      yield* renamed.replyTitle()
      expect(renamed.titleRequests).toHaveLength(1)
      expect(renamed.sessionName()).toBe('my name')
    })
  )

  it.effect('falls back to the start of the prompt without a configured, available, or answering title model', () =>
    Effect.gen(function* () {
      const prompt = '  Refactor   the status panel so that it names sessions\nsecond line'
      const expected = 'Refactor the status panel so that it na…'

      const unconfigured = harness('tui')
      yield* unconfigured.activate()
      yield* unconfigured.emit('before_agent_start', { messageType: 'user', prompt })
      expect(unconfigured.titleRequests).toEqual([])
      expect(unconfigured.sessionName()).toBe(expected)

      const unavailable = harness('tui', { available: false, setting: 'anthropic/missing' })
      yield* unavailable.activate()
      yield* unavailable.emit('before_agent_start', { messageType: 'user', prompt: 'short prompt' })
      expect(unavailable.titleRequests).toEqual([])
      expect(unavailable.sessionName()).toBe('short prompt')

      const failing = harness('tui', { setting: 'anthropic/claude-haiku-4-5' })
      yield* failing.activate()
      yield* failing.emit('before_agent_start', { messageType: 'user', prompt: 'short prompt' })
      yield* failing.replyTitle()
      expect(failing.titleRequests).toHaveLength(1)
      expect(failing.sessionName()).toBe('short prompt')
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
