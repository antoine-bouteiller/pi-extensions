import { initTheme } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asTui } from '@tests/utils/casts.js'

import { type PersistedResolvedProfile } from '@/features/sub_agents/model.js'
import { type TranscriptContent } from '@/features/sub_agents/operator.js'
import { createTranscriptView, entryMessages, transcriptEntries } from '@/features/sub_agents/transcript.js'

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
      id: 'aborted',
      message: {
        api: 'responses',
        content: [{ arguments: { patch: '[file.ts#tag]\n+updated' }, id: 'write-call', name: 'write', type: 'toolCall' }],
        errorMessage: 'Stopped by user',
        model: 'model',
        provider: 'provider',
        role: 'assistant',
        stopReason: 'aborted',
        timestamp: 4,
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      },
      parentId: 'bash-result',
      timestamp: '2025-01-01T00:00:04.000Z',
      type: 'message',
    },
    {
      firstKeptEntryId: 'aborted',
      id: 'compaction',
      parentId: 'aborted',
      summary: 'Earlier work',
      timestamp: '2025-01-01T00:00:04.000Z',
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

  it('renders persisted messages, transcript status, and durable outcomes', () => {
    const view = createTranscriptView({ cwd: '/workspace', title: 'Agent transcript', tui: asTui({}) })
    view.setContent(viewContent(true))

    const rendered = view.component.render(100).join('\n')
    expect(rendered).toContain('Agent transcript')
    expect(rendered).toContain('Visible reasoning')
    expect(rendered).toContain('read')
    expect(rendered).toContain('file contents')
    expect(rendered).toContain('bash output 1')
    expect(rendered).toContain('bash output 15')
    expect(rendered).toContain('write')
    expect(rendered).toContain('Stopped by user')
    expect(rendered).toContain('── context compacted (100 tokens) ──')
    expect(rendered).toContain('Conversation unavailable: session file could not be read.')
    expect(rendered).toContain('Durable turn outcomes:')
    expect(rendered).toContain(JSON.stringify(viewContent().turns[0].result))
  })

  it('only rebuilds when handed new transcript content', () => {
    const view = createTranscriptView({ cwd: '/workspace', title: 'Agent transcript', tui: asTui({}) })
    const content = viewContent()
    view.setContent(content)
    const children = [...view.component.children]

    view.setContent(content)
    expect(view.component.children).toEqual(children)

    view.setContent({ ...content })
    expect(view.component.children).not.toEqual(children)
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
