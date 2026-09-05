import {
  AssistantMessageComponent,
  getMarkdownTheme,
  migrateSessionEntries,
  parseSessionEntries,
  sessionEntryToContextMessages,
  ToolExecutionComponent,
  UserMessageComponent,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent'
import { Container, Text, type TUI } from '@earendil-works/pi-tui'

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
}

const userText = (message: Extract<AgentMessage, { readonly role: 'user' }>): string => {
  if (typeof message.content === 'string') {
    return message.content
  }
  return message.content
    .filter((part): part is { readonly type: 'text'; readonly text: string } => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

const renderMessage = ({
  component,
  cwd,
  message,
  pendingTools,
  tui,
}: {
  readonly component: Container
  readonly cwd: string
  readonly message: AgentMessage
  readonly pendingTools: Map<string, ToolExecutionComponent>
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
      const tool = new ToolExecutionComponent(part.name, part.id, part.arguments, {}, undefined, tui, cwd)
      tool.setExpanded(true)
      component.addChild(tool)
      pendingTools.set(part.id, tool)
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

export const createTranscriptView = ({ cwd, title, tui }: { readonly cwd: string; readonly title: string; readonly tui: TUI }): TranscriptView => {
  const component = new Container()

  const rebuild = (content: TranscriptContent): void => {
    component.clear()
    component.addChild(new Text(title))
    const pendingTools = new Map<string, ToolExecutionComponent>()

    for (const entry of transcriptEntries(content.text)) {
      if (entry.type === 'compaction') {
        component.addChild(new Text(`── context compacted (${entry.tokensBefore} tokens) ──`))
        continue
      }
      for (const message of entryMessages(entry)) {
        renderMessage({ component, cwd, message, pendingTools, tui })
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

  return { component, setContent }
}
