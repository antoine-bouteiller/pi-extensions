import { stripVTControlCharacters } from 'node:util'

import { type ExtensionCommandContext, initTheme } from '@earendil-works/pi-coding-agent'
import { type Component, type TUI } from '@earendil-works/pi-tui'
import { BunFileSystem } from '@effect/platform-bun'
import { describe, expect, it, PromiseEffectError } from '@tests/utils/bun_effect.js'
import { asNarrowed, asTheme } from '@tests/utils/casts.js'
import { mouseEvent } from '@tests/utils/mouse.js'
import { Effect, Fiber } from 'effect'
import { FileSystem } from 'effect/FileSystem'

import { type RunningAgentView } from '@/features/subagents/subagents.js'
import { createTranscriptOverlay, displayOnlyRenderers, openViewer, transcriptEntries } from '@/features/subagents/viewer.js'

initTheme()

const EXPAND = '\u000F'
const CTRL_END = '\u001B[1;5F'
const keybindings = asNarrowed<Parameters<typeof createTranscriptOverlay>[0]['keybindings'], object>({
  getKeys: (id: string) => (id === 'app.tools.expand' ? ['ctrl+o'] : ['ctrl+end']),
  matches: (data: string, id: string) => data === (id === 'app.tools.expand' ? EXPAND : CTRL_END),
})
const theme = asTheme({ bg: (_color: string, text: string) => text, bold: (text: string) => text, fg: (_color: string, text: string) => text })
const fakeTui = (rows: number) => asNarrowed<TUI, object>({ requestRender: () => undefined, terminal: { columns: 120, rows } })
const plain = (lines: readonly string[]) => lines.map((line) => stripVTControlCharacters(line))
const AGENT: RunningAgentView = { agent_id: '1a2b3c4d', cwd: '/project', model: 'p/m', name: 'Review', status: 'working' }

const usage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
}
const assistant = (content: unknown[], stopReason = 'stop') => ({
  message: { api: 'responses', content, model: 'm', provider: 'p', role: 'assistant', stopReason, timestamp: 1, usage },
  type: 'message',
})
const user = (text: string) => ({ message: { content: [{ text, type: 'text' }], role: 'user', timestamp: 1 }, type: 'message' })
const toolResult = (toolCallId: string, toolName: string, prefix: string) => ({
  message: {
    content: [{ text: Array.from({ length: 20 }, (_value, index) => `${prefix} L${String(index + 1).padStart(2, '0')}`).join('\n'), type: 'text' }],
    isError: false,
    role: 'toolResult',
    timestamp: 1,
    toolCallId,
    toolName,
  },
  type: 'message',
})
/** One session file whose entries form a single chain. */
type EntryFields = (
  | ReturnType<typeof user>
  | ReturnType<typeof assistant>
  | ReturnType<typeof toolResult>
  | { readonly firstKeptEntryId: string; readonly summary: string; readonly tokensBefore: number; readonly type: 'compaction' }
) & { readonly parentId?: string }
const sessionText = (...entries: EntryFields[]) =>
  [
    { cwd: '/project', id: 'session', timestamp: '2026-01-01T00:00:00.000Z', type: 'session', version: 3 },
    ...entries.map((entry, index) => ({
      id: `e${index}`,
      parentId: index === 0 ? null : `e${index - 1}`,
      timestamp: '2026-01-01T00:00:01.000Z',
      ...entry,
    })),
  ]
    .map((entry) => `${JSON.stringify(entry)}\n`)
    .join('')
const conversation: EntryFields[] = [
  user('Inspect the repository'),
  assistant(
    [
      { thinking: 'Weighing where to start', type: 'thinking' },
      { arguments: { path: 'notes.txt' }, id: 'read-1', name: 'read', type: 'toolCall' },
      { arguments: { pattern: 'needle' }, id: 'grep-1', name: 'ffgrep', type: 'toolCall' },
    ],
    'toolUse'
  ),
  toolResult('read-1', 'read', 'read'),
  toolResult('grep-1', 'ffgrep', 'grep'),
  { firstKeptEntryId: 'e3', summary: 'Earlier work', tokensBefore: 1234, type: 'compaction' },
]

const waitFor = (check: () => boolean, label: string) =>
  Effect.promise(() => Bun.sleep(10)).pipe(
    Effect.andThen(Effect.sync(check)),
    Effect.flatMap((done) => (done ? Effect.void : Effect.fail(PromiseEffectError.make({ cause: `timed out waiting for ${label}` })))),
    Effect.retry({ times: 300 }),
    Effect.orDie
  )

interface ViewerHarness {
  readonly agents: RunningAgentView[]
  readonly selections?: (options: string[]) => string | undefined
}

const viewerContext = ({ agents, selections }: ViewerHarness, mode = 'tui') => {
  const notifications: string[] = []
  const selects: string[][] = []
  const overlays: { component: Component; options: unknown }[] = []
  let expandedWrites = 0
  const ctx = asNarrowed<ExtensionCommandContext, object>({
    mode,
    ui: {
      custom: (factory: (tui: TUI, th: unknown, kb: unknown, done: (value: unknown) => void) => Component, options: unknown) =>
        new Promise((resolve) => {
          overlays.push({ component: factory(fakeTui(200), theme, keybindings, resolve), options })
        }),
      getToolsExpanded: () => false,
      notify: (message: string, level: string) => notifications.push(`${level}: ${message}`),
      select: (_title: string, options: string[]) => {
        selects.push(options)
        return Promise.resolve(selections === undefined ? options[0] : selections(options))
      },
      setToolsExpanded: () => {
        expandedWrites++
      },
    },
  })
  return { ctx, expandedWrites: () => expandedWrites, notifications, overlays, selects, source: { running: () => [...agents] } }
}

describe('/subagents', () => {
  it.live('[VC-4.1] shows the persisted conversation, expands tools in place, and follows the file as it grows', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem
        const file = `${yield* fs.makeTempDirectoryScoped()}/session.jsonl`
        yield* fs.writeFileString(file, sessionText(...conversation))
        const harness = viewerContext({ agents: [{ ...AGENT, session_file: file }] })
        const viewing = yield* Effect.forkChild(openViewer(harness.source, harness.ctx))
        yield* waitFor(() => harness.overlays.length === 1, 'the overlay')
        const overlay = harness.overlays[0]?.component
        const text = () => plain(overlay?.render(120) ?? []).join('\n')

        const collapsed = text()
        for (const expected of [
          'Inspect the repository',
          'Weighing where to start',
          '── context compacted (1234 tokens) ──',
          'read notes.txt',
          'grep L01',
          'more lines',
        ]) {
          expect(collapsed).toContain(expected)
        }
        expect(collapsed).not.toContain('read L20')
        expect(collapsed).not.toContain('grep L20')

        overlay?.handleInput?.(EXPAND)
        expect(text()).toContain('read L20')
        expect(text()).toContain('grep L20')

        yield* fs.writeFileString(file, sessionText(...conversation, assistant([{ text: 'Finished the survey', type: 'text' }])))
        yield* waitFor(() => text().includes('Finished the survey'), 'the refreshed transcript')
        expect(text()).toContain('read L20')

        overlay?.handleInput?.('q')
        yield* Fiber.join(viewing)
        expect(harness.expandedWrites()).toBe(0)
      })
    ).pipe(Effect.provide(BunFileSystem.layer))
  )

  it.live('shows a placeholder for a child without a session file, and notifies when it cannot open', () =>
    Effect.gen(function* () {
      const empty = viewerContext({ agents: [AGENT] })
      const viewing = yield* Effect.forkChild(openViewer(empty.source, empty.ctx))
      yield* waitFor(() => empty.overlays.length === 1, 'the overlay')
      expect(plain(empty.overlays[0]?.component.render(80) ?? []).join('\n')).toContain('No messages yet.')
      expect(empty.overlays[0]?.options).toEqual({ overlay: true, overlayOptions: { maxHeight: '80%', width: '80%' } })
      empty.overlays[0]?.component.handleInput?.('\u001B')
      yield* Fiber.join(viewing)

      const headless = viewerContext({ agents: [AGENT] }, 'rpc')
      yield* openViewer(headless.source, headless.ctx)
      expect(headless.notifications).toEqual(['warning: /subagents needs the interactive TUI.'])

      const none = viewerContext({ agents: [] })
      yield* openViewer(none.source, none.ctx)
      expect(none.notifications).toEqual(['info: No running sub-agents.'])

      const dismissed = viewerContext({ agents: [AGENT], selections: () => undefined })
      yield* openViewer(dismissed.source, dismissed.ctx)
      expect([dismissed.notifications, dismissed.overlays]).toEqual([[], []])

      const agents = [AGENT]
      const gone = viewerContext({
        agents,
        selections: (options) => {
          agents.pop()
          return options[0]
        },
      })
      yield* openViewer(gone.source, gone.ctx)
      expect(gone.selects).toEqual([['Review · p/m · working']])
      expect(gone.notifications).toEqual(['warning: Agent 1a2b3c4d is no longer running.'])
      expect(gone.overlays).toEqual([])
    }).pipe(Effect.provide(BunFileSystem.layer))
  )
})

const wheel = (wheelDelta: number) => mouseEvent('wheel', 'none', 10, 3, wheelDelta)
const longText = (extra = false) =>
  sessionText(
    user(Array.from({ length: 40 }, (_value, index) => `row ${index + 1}`).join('\n\n')),
    ...(extra ? [assistant([{ text: 'Newest reply', type: 'text' }])] : [])
  )
const scrolledOverlay = () => {
  const overlay = createTranscriptOverlay({ agent: AGENT, expanded: false, keybindings, onClose: () => undefined, theme, tui: fakeTui(10) })
  overlay.setText(longText())
  overlay.render(80)
  return overlay
}

describe('transcript overlay', () => {
  it('[VC-7] handles every wheel event, scrolling by its delta and never past the end', () => {
    const overlay = scrolledOverlay()
    const end = overlay.scroll.scrollTop
    expect(end).toBeGreaterThan(3)
    expect(overlay.handleMouse?.(wheel(-3))).toEqual({ handled: true })
    expect(overlay.scroll.scrollTop).toBe(end - 3)
    overlay.scroll.scrollToEnd()
    expect(overlay.handleMouse?.(wheel(3))).toEqual({ handled: true })
    expect(overlay.scroll.scrollTop).toBe(end)
  })

  it('[VC-8] draws a jump-to-latest label while scrolled up, and both its click and key return to the newest message', () => {
    const overlay = scrolledOverlay()
    const lines = () => plain(overlay.render(80))
    expect(lines().join('\n')).not.toContain('Jump to latest message')

    for (const jump of ['click', 'key']) {
      overlay.setText(longText())
      overlay.render(80)
      overlay.handleMouse?.(wheel(-3))
      const row = lines()[6] ?? ''
      expect(row).toContain('↓ Jump to latest message · Ctrl+End')
      const top = overlay.scroll.scrollTop
      overlay.setText(longText(true))
      expect(lines().join('\n')).not.toContain('Newest reply')
      expect(overlay.scroll.scrollTop).toBe(top)
      if (jump === 'click') {
        const column = (lines()[6] ?? '').indexOf('↓')
        expect(overlay.handleMouse?.(mouseEvent('press', 'left', column, 6))).toEqual({ handled: true })
      } else {
        overlay.handleInput?.(CTRL_END)
      }
      expect(lines().join('\n')).toContain('Newest reply')
      expect(lines().join('\n')).not.toContain('Jump to latest message')
    }
  })

  it('frames the transcript with its title, status, and key hints, and scrolls by line and page', () => {
    const overlay = scrolledOverlay()
    const lines = plain(overlay.render(80))
    expect(lines).toHaveLength(8)
    expect(lines[0]).toStartWith('╭─ Review · p/m · working ')
    expect(lines.at(-1)).toStartWith('╰─ ↑↓ scroll · pgup/pgdn page · ctrl+o expand tools · esc close ')
    expect(lines.every((line) => line.length === 80)).toBeTrue()
    overlay.setStatus('exited')
    expect(plain(overlay.render(80))[0]).toStartWith('╭─ Review · p/m · exited ')

    const end = overlay.scroll.scrollTop
    overlay.handleInput?.('\u001B[A')
    expect(overlay.scroll.scrollTop).toBe(end - 1)
    overlay.handleInput?.('\u001B[5~')
    expect(overlay.scroll.scrollTop).toBe(end - 7)
    overlay.handleInput?.('\u001B[6~')
    overlay.handleInput?.('\u001B[B')
    expect(overlay.scroll.scrollTop).toBe(end)
  })
})

describe('transcript projection', () => {
  it('keeps the branch of the last entry and terminates on cyclic parents', () => {
    const text = sessionText(user('one'), user('two'))
    const forked = `${text}${JSON.stringify({ ...user('fork'), id: 'f', parentId: 'e0', timestamp: '2026-01-01T00:00:02.000Z' })}\n`
    expect(transcriptEntries(forked).map((entry) => entry.id)).toEqual(['e0', 'f'])
    const cyclic = sessionText({ ...user('a'), parentId: 'e1' }, user('b'))
    expect(transcriptEntries(cyclic.replace('"parentId":null', '"parentId":"e1"')).map((entry) => entry.id)).toEqual(['e0', 'e1'])
    expect(transcriptEntries('')).toEqual([])
  })

  it('renders unknown tools as compact arguments and a collapsed result preview', () => {
    const renderers = displayOnlyRenderers('ffgrep', 'ctrl+o')
    const options = { expanded: false, isPartial: false }
    const context = asNarrowed<Parameters<NonNullable<typeof renderers.renderCall>>[2], object>({ expanded: false })
    expect(
      plain(renderers.renderCall?.({ pattern: 'x' }, theme, context).render(80) ?? [])
        .join('')
        .trim()
    ).toBe('ffgrep {"pattern":"x"}')
    const result = { content: [{ text: 'a\nb\nc\nd\ne', type: 'text' as const }], details: undefined }
    expect(plain(renderers.renderResult?.(result, options, theme, context).render(80) ?? []).map((line) => line.trimEnd())).toEqual([
      'a',
      'b',
      'c',
      '… (2 more lines, ctrl+o to expand)',
    ])
    expect(
      plain(renderers.renderResult?.(result, { ...options, expanded: true }, theme, context).render(80) ?? []).map((line) => line.trimEnd())
    ).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})
