import { initTheme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asTui } from '@tests/utils/casts.js'

import { type PersistedResolvedProfile } from '@/features/sub_agents/model.js'
import { type TranscriptContent } from '@/features/sub_agents/operator.js'
import { createTranscriptOverlay, createTranscriptView, entryMessages, transcriptEntries } from '@/features/sub_agents/transcript.js'

initTheme()

const sessionFixture = [
  { cwd: '/workspace', id: 'session', timestamp: '2025-01-01T00:00:00.000Z', type: 'session', version: 3 },
  {
    id: 'user',
    message: { content: [{ text: 'Start', type: 'text' }], role: 'user', timestamp: 1 },
    parentId: null,
    timestamp: '2025-01-01T00:00:01.000Z',
    type: 'message',
  },
  {
    id: 'assistant',
    message: { content: [{ text: 'Thinking', type: 'text' }], role: 'assistant', timestamp: 2 },
    parentId: 'user',
    timestamp: '2025-01-01T00:00:02.000Z',
    type: 'message',
  },
  {
    id: 'tool-result',
    message: {
      content: [{ text: 'contents', type: 'text' }],
      isError: false,
      role: 'toolResult',
      timestamp: 3,
      toolCallId: 'call-1',
      toolName: 'read',
    },
    parentId: 'assistant',
    timestamp: '2025-01-01T00:00:03.000Z',
    type: 'message',
  },
  {
    firstKeptEntryId: 'tool-result',
    id: 'compaction',
    parentId: 'tool-result',
    summary: 'Earlier work',
    timestamp: '2025-01-01T00:00:04.000Z',
    tokensBefore: 100,
    type: 'compaction',
  },
  {
    id: 'after-compaction',
    message: { content: [{ text: 'Done', type: 'text' }], role: 'assistant', timestamp: 5 },
    parentId: 'compaction',
    timestamp: '2025-01-01T00:00:05.000Z',
    type: 'message',
  },
]
  .map((entry) => JSON.stringify(entry))
  .join('\n')

const ids = (text: string): readonly string[] => transcriptEntries(text).map((entry) => entry.id)

const profile: PersistedResolvedProfile = { contextCeiling: 1, key: 'scout', model: 'model', prompt: 'prompt', provider: 'provider', tools: [] }

const viewContent = (unavailable = false): TranscriptContent => ({
  text: [
    { cwd: '/workspace', id: 'session', timestamp: '2025-01-01T00:00:00.000Z', type: 'session', version: 3 },
    {
      id: 'assistant',
      message: {
        api: 'responses',
        content: [
          { thinking: 'Visible reasoning', type: 'thinking' },
          { arguments: { path: 'file.ts' }, id: 'read-call', name: 'read', type: 'toolCall' },
          { arguments: { command: 'printf output' }, id: 'bash-call', name: 'bash', type: 'toolCall' },
          { arguments: { pattern: 'hit' }, id: 'ffgrep-call', name: 'ffgrep', type: 'toolCall' },
        ],
        model: 'model',
        provider: 'provider',
        role: 'assistant',
        stopReason: 'toolUse',
        timestamp: 1,
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      },
      parentId: null,
      timestamp: '2025-01-01T00:00:01.000Z',
      type: 'message',
    },
    {
      id: 'result',
      message: {
        content: [{ text: 'file contents', type: 'text' }],
        isError: false,
        role: 'toolResult',
        timestamp: 2,
        toolCallId: 'read-call',
        toolName: 'read',
      },
      parentId: 'assistant',
      timestamp: '2025-01-01T00:00:02.000Z',
      type: 'message',
    },
    {
      id: 'bash-result',
      message: {
        content: [{ text: Array.from({ length: 15 }, (_value, index) => `bash output ${index + 1}`).join('\n'), type: 'text' }],
        isError: false,
        role: 'toolResult',
        timestamp: 3,
        toolCallId: 'bash-call',
        toolName: 'bash',
      },
      parentId: 'result',
      timestamp: '2025-01-01T00:00:03.000Z',
      type: 'message',
    },
    {
      id: 'ffgrep-result',
      message: {
        content: [{ text: Array.from({ length: 15 }, (_value, index) => `grep hit ${String(index + 1).padStart(2, '0')}`).join('\n'), type: 'text' }],
        isError: false,
        role: 'toolResult',
        timestamp: 4,
        toolCallId: 'ffgrep-call',
        toolName: 'ffgrep',
      },
      parentId: 'bash-result',
      timestamp: '2025-01-01T00:00:04.000Z',
      type: 'message',
    },
    {
      id: 'aborted',
      message: {
        api: 'responses',
        content: [{ arguments: { patch: '[file.ts#tag]\n+updated' }, id: 'write-call', name: 'write', type: 'toolCall' }],
        errorMessage: 'Stopped by user',
        model: 'model',
        provider: 'provider',
        role: 'assistant',
        stopReason: 'aborted',
        timestamp: 5,
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      },
      parentId: 'ffgrep-result',
      timestamp: '2025-01-01T00:00:05.000Z',
      type: 'message',
    },
    {
      firstKeptEntryId: 'aborted',
      id: 'compaction',
      parentId: 'aborted',
      summary: 'Earlier work',
      timestamp: '2025-01-01T00:00:06.000Z',
      tokensBefore: 100,
      type: 'compaction',
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n'),
  turns: [{ profile, result: { conclusion: 'Finished', status: 'completed', task_name: 'task', turn: 1 } }],
  unavailable,
})

describe('sub-agent transcript projection', () => {
  it('keeps the full persisted branch across compaction and malformed lines', () => {
    const entries = transcriptEntries(`${sessionFixture}\nnot json\n`)

    expect(entries.map((entry) => entry.id)).toEqual(['user', 'assistant', 'tool-result', 'compaction', 'after-compaction'])
    expect(entryMessages(entries[2])).toEqual([
      { content: [{ text: 'contents', type: 'text' }], isError: false, role: 'toolResult', timestamp: 3, toolCallId: 'call-1', toolName: 'read' },
    ])
  })

  it('returns no entries for empty text', () => {
    expect(transcriptEntries('')).toEqual([])
  })

  it('renders persisted messages, transcript status, durable outcomes, and toggled tool expansion', () => {
    const view = createTranscriptView({ cwd: '/workspace', expanded: false, tui: asTui({}) })
    const content = viewContent(true)
    view.setContent(content)

    const collapsed = view.component.render(100).join('\n')
    expect(collapsed).toContain('Visible reasoning')
    expect(collapsed).toContain('read')
    expect(collapsed).toContain('"pattern": "hit"')
    expect(collapsed).toContain('bash output 1')
    expect(collapsed).toContain('bash output 10')
    expect(collapsed).not.toContain('bash output 11')
    expect(collapsed).toContain('grep hit 10')
    expect(collapsed).toContain('5 more lines')
    expect(collapsed).not.toContain('grep hit 11')
    expect(collapsed).toContain('write')
    expect(collapsed).toContain('Stopped by user')
    expect(collapsed).toContain('── context compacted (100 tokens) ──')
    expect(collapsed).toContain('Conversation unavailable: session file could not be read.')
    expect(collapsed).toContain('Durable turn outcomes:')
    expect(collapsed).toContain(JSON.stringify(viewContent().turns[0].result))

    view.toggleExpanded()
    const expanded = view.component.render(100).join('\n')
    expect(expanded).toContain('file contents')
    expect(expanded).toContain('"pattern": "hit"')
    expect(expanded).toContain('grep hit 15')
    expect(expanded).not.toContain('more lines')

    view.setContent({ ...content })
    expect(view.component.render(100).join('\n')).toContain('grep hit 15')

    view.toggleExpanded()
    const collapsedAgain = view.component.render(100).join('\n')
    expect(collapsedAgain).toContain('grep hit 10')
    expect(collapsedAgain).toContain('5 more lines')
    expect(collapsedAgain).not.toContain('grep hit 11')
  })

  it('only rebuilds when handed new transcript content', () => {
    const view = createTranscriptView({ cwd: '/workspace', expanded: false, tui: asTui({}) })
    const content = viewContent()
    view.setContent(content)
    const children = [...view.component.children]

    view.setContent(content)
    expect(view.component.children).toEqual(children)

    view.setContent({ ...content })
    expect(view.component.children).not.toEqual(children)
  })

  it('frames and controls a transcript overlay', () => {
    const content: TranscriptContent = {
      text: [
        { cwd: '/workspace', id: 'session', timestamp: '2025-01-01T00:00:00.000Z', type: 'session', version: 3 },
        {
          id: 'assistant',
          message: {
            api: 'responses',
            content: [{ arguments: { pattern: 'hit' }, id: 'ffgrep-call', name: 'ffgrep', type: 'toolCall' }],
            model: 'model',
            provider: 'provider',
            role: 'assistant',
            stopReason: 'toolUse',
            timestamp: 1,
            usage: {
              cacheRead: 0,
              cacheWrite: 0,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
              input: 0,
              output: 0,
              totalTokens: 0,
            },
          },
          parentId: null,
          timestamp: '2025-01-01T00:00:01.000Z',
          type: 'message',
        },
        {
          id: 'result',
          message: {
            content: [{ text: Array.from({ length: 15 }, (_value, index) => `grep hit ${index + 1}`).join('\n'), type: 'text' }],
            isError: false,
            role: 'toolResult',
            timestamp: 2,
            toolCallId: 'ffgrep-call',
            toolName: 'ffgrep',
          },
          parentId: 'assistant',
          timestamp: '2025-01-01T00:00:02.000Z',
          type: 'message',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
      turns: [],
      unavailable: false,
    }
    let closeCalls = 0
    const overlay = createTranscriptOverlay({
      content: () => content,
      cwd: '/workspace',
      expanded: false,
      keybindings: { matches: (data, key) => key === 'app.tools.expand' && data === '\u000f' },
      onClose: () => {
        closeCalls += 1
      },
      theme: { bold: (text) => text, fg: (_color, text) => text },
      title: 'Agent transcript',
      tui: asTui({ requestRender: () => undefined, terminal: { columns: 100, rows: 40 } }),
    })

    overlay.refresh()
    const collapsed = overlay.render(100)
    expect(collapsed).toHaveLength(32)
    expect(collapsed[0]).toStartWith('╭─ Agent transcript')
    expect(stripTerminalSequences(collapsed[0])).toEndWith('╮')
    expect(collapsed.at(-1)).toContain('expand tools')
    expect(collapsed.at(-1)).toContain('close')
    expect(stripTerminalSequences(collapsed.at(-1) ?? '')).toEndWith('╯')
    expect(collapsed.every((line) => line.startsWith('│') || line.startsWith('╭') || line.startsWith('╰'))).toBeTrue()
    expect(collapsed.every((line) => visibleWidth(line) <= 100)).toBeTrue()
    expect(collapsed.join('\n')).toContain('5 more lines')
    expect(collapsed.join('\n')).not.toContain('grep hit 11')

    overlay.handleInput?.('\u000f')
    expect(overlay.render(100).join('\n')).toContain('grep hit 15')
    overlay.handleInput?.('\u000f')
    expect(overlay.render(100).join('\n')).not.toContain('grep hit 11')
    overlay.handleInput?.('\u001b')
    expect(closeCalls).toBe(1)
    overlay.handleInput?.('\u001b[27u')
    expect(closeCalls).toBe(2)
  })

  it('keeps overlay geometry within tiny terminals', () => {
    const overlay = createTranscriptOverlay({
      content: () => ({ text: '', turns: [], unavailable: false }),
      cwd: '/workspace',
      expanded: false,
      keybindings: { matches: () => false },
      onClose: () => undefined,
      theme: { bold: (text) => text, fg: (_color, text) => text },
      title: 'Agent transcript',
      tui: asTui({ requestRender: () => undefined, terminal: { columns: 12, rows: 4 } }),
    })

    overlay.refresh()
    const lines = overlay.render(12)
    expect(lines).toHaveLength(3)
    expect(lines.every((line) => visibleWidth(line) <= 12)).toBeTrue()
    expect(lines[0]).toStartWith('╭')
    expect(lines.at(-1)).toStartWith('╰')

    for (const [rows, expectedHeight] of [
      [1, 1],
      [2, 2],
    ]) {
      const shortOverlay = createTranscriptOverlay({
        content: () => ({ text: '', turns: [], unavailable: false }),
        cwd: '/workspace',
        expanded: false,
        keybindings: { matches: () => false },
        onClose: () => undefined,
        theme: { bold: (text) => text, fg: (_color, text) => text },
        title: 'Agent transcript',
        tui: asTui({ requestRender: () => undefined, terminal: { columns: 12, rows } }),
      })
      shortOverlay.refresh()
      expect(shortOverlay.render(12)).toHaveLength(expectedHeight)
    }
  })

  it('scrolls transcript output with arrow and page keys', () => {
    const content: TranscriptContent = {
      text: [
        { cwd: '/workspace', id: 'session', timestamp: '2025-01-01T00:00:00.000Z', type: 'session', version: 3 },
        {
          id: 'assistant',
          message: {
            api: 'responses',
            content: [{ arguments: { pattern: 'hit' }, id: 'ffgrep-call', name: 'ffgrep', type: 'toolCall' }],
            model: 'model',
            provider: 'provider',
            role: 'assistant',
            stopReason: 'toolUse',
            timestamp: 1,
            usage: {
              cacheRead: 0,
              cacheWrite: 0,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
              input: 0,
              output: 0,
              totalTokens: 0,
            },
          },
          parentId: null,
          timestamp: '2025-01-01T00:00:01.000Z',
          type: 'message',
        },
        {
          id: 'result',
          message: {
            content: [{ text: Array.from({ length: 15 }, (_value, index) => `grep hit ${index + 1}`).join('\n'), type: 'text' }],
            isError: false,
            role: 'toolResult',
            timestamp: 2,
            toolCallId: 'ffgrep-call',
            toolName: 'ffgrep',
          },
          parentId: 'assistant',
          timestamp: '2025-01-01T00:00:02.000Z',
          type: 'message',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
      turns: [],
      unavailable: false,
    }
    const overlay = createTranscriptOverlay({
      content: () => content,
      cwd: '/workspace',
      expanded: true,
      keybindings: { matches: () => false },
      onClose: () => undefined,
      theme: { bold: (text) => text, fg: (_color, text) => text },
      title: 'Agent transcript',
      tui: asTui({ requestRender: () => undefined, terminal: { columns: 100, rows: 5 } }),
    })

    overlay.refresh()
    const initial = overlay.render(100).join('\n')
    overlay.handleInput?.('\u001b[B')
    const afterDown = overlay.render(100).join('\n')
    expect(afterDown).not.toEqual(initial)
    overlay.handleInput?.('\u001b[6~')
    const afterPageDown = overlay.render(100).join('\n')
    expect(afterPageDown).not.toEqual(afterDown)
    for (let index = 0; index < 21; index += 1) {
      overlay.handleInput?.('\u001b[6~')
    }
    const atEnd = overlay.render(100).join('\n')
    overlay.handleInput?.('\u001b[6~')
    expect(overlay.render(100).join('\n')).toEqual(atEnd)
  })

  it('terminates when parent links are cyclic', () => {
    const text = [
      { cwd: '/workspace', id: 'session', timestamp: '2025-01-01T00:00:00.000Z', type: 'session', version: 3 },
      { id: 'first', message: { content: [], role: 'user', timestamp: 1 }, parentId: 'last', timestamp: '2025-01-01T00:00:01.000Z', type: 'message' },
      {
        id: 'last',
        message: { content: [], role: 'assistant', timestamp: 2 },
        parentId: 'first',
        timestamp: '2025-01-01T00:00:02.000Z',
        type: 'message',
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n')

    expect(ids(text)).toEqual(['first', 'last'])
  })
})
