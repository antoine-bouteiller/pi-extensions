import {
  AssistantMessageComponent,
  getMarkdownTheme,
  keyHint,
  type KeybindingsManager,
  rawKeyHint,
  migrateSessionEntries,
  parseSessionEntries,
  sessionEntryToContextMessages,
  ToolExecutionComponent,
  type Theme,
  type ToolDefinition,
  UserMessageComponent,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent'
import { Container, matchesKey, ScrollView, Text, truncateToWidth, visibleWidth, type Component, type TUI } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import { type TranscriptContent } from './operator.js'

type AgentMessage = ReturnType<typeof sessionEntryToContextMessages>[number]

/** Projects every persisted entry on the current root-to-leaf branch, including compacted history. */
export const transcriptEntries = (text: string): readonly SessionEntry[] => {
  try {
    const parsed = parseSessionEntries(text)
    migrateSessionEntries(parsed)
    const entries = parsed.filter((entry): entry is SessionEntry => entry.type !== 'session')
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    const leaf = entries.at(-1)
    const branch: SessionEntry[] = []
    const visited = new Set<string>()
    let current = leaf

    while (current !== undefined && !visited.has(current.id)) {
      branch.push(current)
      visited.add(current.id)
      current = current.parentId === null ? undefined : byId.get(current.parentId)
    }

    return branch.toReversed()
  } catch {
    return []
  }
}

/** Projects a persisted entry into the agent messages used by transcript rendering. */
export const entryMessages = (entry: SessionEntry): readonly AgentMessage[] => sessionEntryToContextMessages(entry)

export interface TranscriptView {
  readonly component: Container
  readonly setContent: (content: TranscriptContent) => void
  readonly toggleExpanded: () => void
}

// oxlint-disable-next-line capitalized-comments
// ponytail: every tool renders generically; pi 0.85.1 moved built-in renderers behind an unexported
// `withBuiltInRenderers`. Restore per-tool fidelity if pi ever exports them from its package root.
const displayOnlyDefinition = (name: string): ToolDefinition => ({
  description: '',
  execute: () => Promise.reject(new Error('Transcript tools are display-only.')),
  label: name,
  name,
  parameters: Type.Object({}),
  renderCall: (args, theme) => new Text(`${theme.fg('toolTitle', theme.bold(name))}\n\n${JSON.stringify(args, undefined, 2)}`),
})

const userText = (message: Extract<AgentMessage, { readonly role: 'user' }>): string => {
  if (typeof message.content === 'string') {
    return message.content
  }
  return message.content
    .filter((part): part is { readonly type: 'text'; readonly text: string } => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

const pad = (line: string, width: number): string => {
  const truncated = truncateToWidth(line, width, '')
  return `${truncated}${' '.repeat(Math.max(0, width - visibleWidth(truncated)))}`
}

const renderMessage = ({
  component,
  cwd,
  message,
  expanded,
  pendingTools,
  tools,
  tui,
}: {
  readonly component: Container
  readonly cwd: string
  readonly expanded: boolean
  readonly message: AgentMessage
  readonly pendingTools: Map<string, ToolExecutionComponent>
  readonly tools: ToolExecutionComponent[]
  readonly tui: TUI
}): void => {
  if (message.role === 'user') {
    const text = userText(message)
    if (text.length > 0) {
      component.addChild(new UserMessageComponent(text, getMarkdownTheme()))
    }
    return
  }

  if (message.role === 'assistant') {
    component.addChild(new AssistantMessageComponent(message, false, getMarkdownTheme()))
    for (const part of message.content) {
      if (part.type !== 'toolCall') {
        continue
      }
      const tool = new ToolExecutionComponent(part.name, part.id, part.arguments, {}, displayOnlyDefinition(part.name), tui, cwd)
      tool.setExpanded(expanded)
      component.addChild(tool)
      pendingTools.set(part.id, tool)
      tools.push(tool)
    }
    if (message.stopReason === 'aborted' || message.stopReason === 'error') {
      const error = message.errorMessage || (message.stopReason === 'aborted' ? 'Operation aborted' : 'Error')
      for (const tool of pendingTools.values()) {
        tool.updateResult({ content: [{ text: error, type: 'text' }], isError: true })
      }
      pendingTools.clear()
    }
    return
  }

  if (message.role === 'toolResult') {
    const tool = pendingTools.get(message.toolCallId)
    if (tool !== undefined) {
      tool.updateResult(message)
      pendingTools.delete(message.toolCallId)
    }
  }
}

export const createTranscriptOverlay = (options: {
  readonly content: () => TranscriptContent
  readonly cwd: string
  readonly expanded: boolean
  readonly keybindings: Pick<KeybindingsManager, 'matches'>
  readonly onClose: () => void
  readonly theme: Pick<Theme, 'bold' | 'fg'>
  readonly title: string
  readonly tui: TUI
}): Component & { readonly refresh: () => void } => {
  const view = createTranscriptView(options)
  const scroll = new ScrollView(view.component, { follow: 'none', scrollbar: 'auto' })
  const height = (): number => Math.min(options.tui.terminal.rows, Math.max(3, Math.floor(options.tui.terminal.rows * 0.8)))
  const frame = (width: number, body: readonly string[]): string[] => {
    const innerWidth = Math.max(1, width - 4)
    const safeTitle = truncateToWidth(options.title, Math.max(0, innerWidth - 2), '…')
    const title = options.theme.bold(options.theme.fg('accent', safeTitle))
    const top = `${options.theme.fg('border', '╭─ ')}${title}${options.theme.fg('border', ` ${'─'.repeat(Math.max(0, innerWidth - visibleWidth(safeTitle) - 1))}╮`)}`
    const fullHints = `${rawKeyHint('↑↓', 'scroll')}  ${rawKeyHint('pgup/pgdn', 'page')}  ${keyHint('app.tools.expand', 'expand tools')}  ${rawKeyHint('esc', 'close')}`
    const closeHint = rawKeyHint('esc', 'close')
    let hints = ''
    if (visibleWidth(fullHints) <= innerWidth - 2) {
      hints = fullHints
    } else if (visibleWidth(closeHint) <= innerWidth - 2) {
      hints = closeHint
    }
    const bottom =
      hints.length === 0
        ? options.theme.fg('border', `╰${'─'.repeat(innerWidth + 2)}╯`)
        : `${options.theme.fg('border', '╰─ ')}${hints}${options.theme.fg('border', ` ${'─'.repeat(Math.max(0, innerWidth - visibleWidth(hints) - 1))}╯`)}`
    const rows = body.map((row) => `${options.theme.fg('border', '│')} ${pad(row, innerWidth)} ${options.theme.fg('border', '│')}`)

    return [top, ...rows, bottom].slice(0, height()).map((line) => truncateToWidth(line, Math.max(0, width), ''))
  }

  return {
    handleInput: (data) => {
      const bodyRows = Math.max(0, height() - 2)
      if (options.keybindings.matches(data, 'app.tools.expand')) {
        view.toggleExpanded()
        options.tui.requestRender()
      } else if (matchesKey(data, 'escape') || data === 'q') {
        options.onClose()
      } else if (matchesKey(data, 'up')) {
        scroll.scrollBy(-1)
      } else if (matchesKey(data, 'down')) {
        scroll.scrollBy(1)
      } else if (matchesKey(data, 'pageUp')) {
        scroll.scrollBy(-Math.max(1, bodyRows - 1))
      } else if (matchesKey(data, 'pageDown')) {
        scroll.scrollBy(Math.max(1, bodyRows - 1))
      }
    },
    invalidate: () => scroll.invalidate(),
    refresh: () => {
      view.setContent(options.content())
      options.tui.requestRender()
    },
    render: (width) => {
      const bodyRows = Math.max(0, height() - 2)
      const innerWidth = Math.max(1, width - 4)
      scroll.updateLayout(view.component.render(innerWidth).length, bodyRows, () => options.tui.requestRender())
      const body = scroll.render(innerWidth).slice(scroll.scrollTop, scroll.scrollTop + bodyRows)
      while (body.length < bodyRows) {
        body.push('')
      }
      return frame(width, body)
    },
  }
}

export const createTranscriptView = (options: { readonly cwd: string; readonly expanded: boolean; readonly tui: TUI }): TranscriptView => {
  const component = new Container()
  // oxlint-disable-next-line prefer-destructuring
  let expanded = options.expanded
  let tools: ToolExecutionComponent[] = []

  const rebuild = (content: TranscriptContent): void => {
    component.clear()
    tools = []
    const pendingTools = new Map<string, ToolExecutionComponent>()

    for (const entry of transcriptEntries(content.text)) {
      if (entry.type === 'compaction') {
        component.addChild(new Text(`── context compacted (${entry.tokensBefore} tokens) ──`))
        continue
      }
      for (const message of entryMessages(entry)) {
        renderMessage({ component, cwd: options.cwd, expanded, message, pendingTools, tools, tui: options.tui })
      }
    }

    if (content.unavailable) {
      component.addChild(new Text('Conversation unavailable: session file could not be read.'))
    }
    if (content.turns.length > 0) {
      component.addChild(new Text('Durable turn outcomes:'))
      for (const turn of content.turns) {
        component.addChild(new Text(JSON.stringify(turn.result)))
      }
    }
  }

  let applied: TranscriptContent | undefined
  const setContent = (content: TranscriptContent): void => {
    if (content === applied) {
      return
    }
    applied = content
    rebuild(content)
  }

  const toggleExpanded = (): void => {
    expanded = !expanded
    for (const tool of tools) {
      tool.setExpanded(expanded)
    }
  }

  return { component, setContent, toggleExpanded }
}
