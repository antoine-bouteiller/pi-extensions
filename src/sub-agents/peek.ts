import { existsSync, statSync } from 'node:fs'
import { connect, type Socket } from 'node:net'

import { type AssistantMessage, type Message } from '@earendil-works/pi-ai'
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  SessionManager,
  ToolExecutionComponent,
  UserMessageComponent,
  type Theme,
  type ThemeColor,
} from '@earendil-works/pi-coding-agent'
import { Container, matchesKey, truncateToWidth, visibleWidth, type TUI } from '@earendil-works/pi-tui'

import { getSocketPath, isPeekActive, type AgentInfo } from './core.js'
import { persistedProfileColor } from './profiles.js'

// oxlint-disable-next-line no-control-regex -- OSC 133 terminal markers contain ESC and BEL.
const OSC133_PROMPT_MARKER_RE = /\x1b\]133;[ABC]\x07/g

const stripPromptMarkers = (lines: string[]): string[] => lines.map((line) => line.replace(OSC133_PROMPT_MARKER_RE, ''))

interface ToolExecutionResultPayload {
  content: { type: string; text?: string; data?: string; mimeType?: string }[]
  details?: unknown
}

interface ActiveToolEvent {
  toolCallId: string
  toolName: string
  args: unknown
  result?: ToolExecutionResultPayload
  partialResult?: ToolExecutionResultPayload
  isError?: boolean
}

interface AgentMessageEvent {
  message: Message
}

type PeekStatus = 'thinking' | 'streaming' | 'tool' | 'done'

interface SyncEvent {
  type: 'sync'
  status?: PeekStatus
  userMessage?: Message
  partialMessage?: AssistantMessage
  activeTools?: ActiveToolEvent[]
}

interface MessageStartEvent extends AgentMessageEvent {
  type: 'message_start'
}

interface MessageUpdateEvent extends AgentMessageEvent {
  type: 'message_update'
  assistantMessageEvent?: { type?: string }
}

interface MessageEndEvent extends AgentMessageEvent {
  type: 'message_end'
}

interface ToolExecutionStartEvent {
  type: 'tool_execution_start'
  toolCallId: string
  toolName: string
  args: unknown
}

interface ToolExecutionUpdateEvent {
  type: 'tool_execution_update'
  toolCallId: string
  toolName: string
  args: unknown
  partialResult: ToolExecutionResultPayload
}

interface ToolExecutionEndEvent {
  type: 'tool_execution_end'
  toolCallId: string
  toolName: string
  result: ToolExecutionResultPayload
  isError: boolean
}

interface AgentSettledEvent {
  type: 'agent_settled'
}

type PeekSocketEvent =
  | SyncEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | AgentSettledEvent

const STATUS_ICONS: Record<PeekStatus, string> = {
  done: '✓',
  streaming: '●',
  thinking: '◐',
  tool: '◑',
}

const STATUS_COLORS: Record<PeekStatus, ThemeColor> = {
  done: 'success',
  streaming: 'success',
  thinking: 'warning',
  tool: 'accent',
}

export interface SubagentPeekOverlayOptions {
  tui: TUI
  theme: Theme
  info: AgentInfo
  done: (navigation?: 'previous' | 'next') => void
}

export class SubagentPeekOverlay {
  private readonly tui: TUI
  private readonly theme: Theme
  private readonly info: AgentInfo
  private readonly done: (navigation?: 'previous' | 'next') => void
  private readonly sessionFile: string
  private readonly cwd: string
  private readonly modelName: string
  private sessionManager: SessionManager | undefined = undefined
  private lastFileSize = 0
  private readonly chatContainer = new Container()
  private scrollOffset = Number.MAX_SAFE_INTEGER
  private followMode = true
  private socket: Socket | undefined = undefined
  private socketBuffer = ''
  private status: PeekStatus = 'done'
  private streamingComponent: AssistantMessageComponent | undefined = undefined
  private streamingMessage: AssistantMessage | undefined = undefined
  private readonly pendingTools = new Map<string, ToolExecutionComponent>()
  private pollInterval: ReturnType<typeof setInterval> | undefined = undefined
  private lastConnectAttemptAt = 0
  private cachedLines: string[] | undefined = undefined
  private cachedWidth: number | undefined = undefined

  constructor(options: SubagentPeekOverlayOptions) {
    this.tui = options.tui
    this.theme = options.theme
    this.info = options.info
    this.done = options.done
    this.sessionFile = options.info.sessionFile
    this.cwd = options.info.cwd
    this.modelName = options.info.modelId || options.info.model
    this.loadSession()
    this.rebuildChat()
    if (isPeekActive(options.info.id)) {
      this.connectSocket()
    }
    this.pollInterval = setInterval(() => this.poll(), 200)
  }

  private loadSession(): void {
    try {
      if (!existsSync(this.sessionFile)) {
        return
      }
      this.sessionManager = SessionManager.open(this.sessionFile)
      this.lastFileSize = statSync(this.sessionFile).size
    } catch {
      this.sessionManager = undefined
    }
  }

  private rebuildChat(): void {
    this.invalidateCache()
    this.chatContainer.clear()
    this.pendingTools.clear()
    if (!this.sessionManager) {
      return
    }
    const context = this.sessionManager.buildSessionContext()
    for (const message of context.messages) {
      if (message.role === 'user') {
        const text = this.getUserText(message)
        if (text) {
          this.chatContainer.addChild(new UserMessageComponent(text, getMarkdownTheme()))
        }
        continue
      }
      if (message.role === 'assistant') {
        this.addAssistantMessage(message)
        continue
      }
      if (message.role === 'toolResult') {
        const component = this.pendingTools.get(message.toolCallId)
        if (component) {
          component.updateResult(message)
          this.pendingTools.delete(message.toolCallId)
        }
      }
    }
  }

  private addAssistantMessage(message: AssistantMessage): void {
    this.chatContainer.addChild(new AssistantMessageComponent(message, true, getMarkdownTheme()))
    for (const content of message.content) {
      if (content.type !== 'toolCall') {
        continue
      }
      const component = this.createToolComponent(content.name, content.id, content.arguments)
      this.chatContainer.addChild(component)
      if (message.stopReason === 'aborted' || message.stopReason === 'error') {
        component.updateResult({
          content: [
            {
              text: message.errorMessage || (message.stopReason === 'aborted' ? 'Operation aborted' : 'Error'),
              type: 'text',
            },
          ],
          isError: true,
        })
      } else {
        this.pendingTools.set(content.id, component)
      }
    }
  }

  private createToolComponent(name: string, id: string, args: unknown): ToolExecutionComponent {
    return new ToolExecutionComponent(name, id, args, {}, undefined, this.tui, this.cwd)
  }

  private getUserText(message: Message | undefined): string {
    const content = message?.content
    if (typeof content === 'string') {
      return content
    }
    if (!Array.isArray(content)) {
      return ''
    }
    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string' && part.text.length > 0)
      .map((part) => part.text)
      .join('\n')
  }

  private connectSocket(): void {
    this.lastConnectAttemptAt = Date.now()
    try {
      const socket = connect(getSocketPath(this.info.id))
      this.socket = socket
      this.socketBuffer = ''
      socket.on('error', () => {
        if (this.socket === socket) {
          this.socket = undefined
        }
      })
      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = undefined
        }
        this.status = 'done'
        this.cleanupStreaming()
        this.loadSession()
        this.rebuildChat()
        this.tui.requestRender()
      })
      socket.on('data', (data) => {
        this.socketBuffer += data.toString()
        const lines = this.socketBuffer.split('\n')
        this.socketBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) {
            continue
          }
          try {
            this.handleEvent(JSON.parse(line) as PeekSocketEvent)
          } catch {
            // Best effort; a malformed event line is dropped.
          }
        }
      })
    } catch {
      this.socket = undefined
    }
  }

  private handleSyncEvent(event: SyncEvent): void {
    this.status = event.status || 'done'
    if (event.userMessage) {
      const text = this.getUserText(event.userMessage)
      if (text) {
        this.chatContainer.addChild(new UserMessageComponent(text, getMarkdownTheme()))
      }
    }
    if (event.partialMessage) {
      this.streamingMessage = event.partialMessage
      this.streamingComponent = new AssistantMessageComponent(undefined, true, getMarkdownTheme())
      this.chatContainer.addChild(this.streamingComponent)
      this.streamingComponent.updateContent(this.streamingMessage)
      this.syncToolComponentsFromMessage()
    }
    for (const activeTool of event.activeTools ?? []) {
      this.applyActiveTool(activeTool)
    }
  }

  private applyActiveTool(activeTool: ActiveToolEvent): void {
    let component = this.pendingTools.get(activeTool.toolCallId)
    if (!component) {
      component = this.createToolComponent(activeTool.toolName, activeTool.toolCallId, activeTool.args)
      this.chatContainer.addChild(component)
      this.pendingTools.set(activeTool.toolCallId, component)
    }
    if (activeTool.result) {
      component.updateResult({ ...activeTool.result, isError: activeTool.isError ?? false })
      this.pendingTools.delete(activeTool.toolCallId)
    } else if (activeTool.partialResult) {
      component.updateResult({ ...activeTool.partialResult, isError: false }, true)
    }
  }

  private handleMessageStart(event: MessageStartEvent): void {
    if (event.message?.role === 'user') {
      const text = this.getUserText(event.message)
      if (text) {
        this.chatContainer.addChild(new UserMessageComponent(text, getMarkdownTheme()))
      }
    } else if (event.message?.role === 'assistant') {
      this.cleanupStreaming()
      this.streamingMessage = event.message
      this.streamingComponent = new AssistantMessageComponent(undefined, true, getMarkdownTheme())
      this.chatContainer.addChild(this.streamingComponent)
      this.streamingComponent.updateContent(this.streamingMessage)
      this.status = 'thinking'
    }
  }

  private handleMessageUpdate(event: MessageUpdateEvent): void {
    if (event.message?.role !== 'assistant') {
      return
    }
    this.ensureStreamingComponent()
    this.streamingMessage = event.message
    this.streamingComponent?.updateContent(this.streamingMessage)
    const delta = event.assistantMessageEvent
    if (delta?.type === 'thinking_delta') {
      this.status = 'thinking'
    }
    if (delta?.type === 'text_delta') {
      this.status = 'streaming'
    }
    this.syncToolComponentsFromMessage()
  }

  private handleMessageEnd(event: MessageEndEvent): void {
    if (!this.streamingComponent || event.message?.role !== 'assistant') {
      return
    }
    this.streamingMessage = event.message
    this.streamingComponent.updateContent(this.streamingMessage)
    if (event.message.stopReason === 'aborted' || event.message.stopReason === 'error') {
      const errorMessage = event.message.errorMessage || 'Error'
      for (const component of this.pendingTools.values()) {
        component.updateResult({
          content: [{ text: errorMessage, type: 'text' }],
          isError: true,
        })
      }
      this.pendingTools.clear()
    } else {
      for (const component of this.pendingTools.values()) {
        component.setArgsComplete()
      }
    }
    this.streamingComponent = undefined
    this.streamingMessage = undefined
  }

  private handleToolExecutionStart(event: ToolExecutionStartEvent): void {
    this.status = 'tool'
    if (event.toolCallId && event.toolName && !this.pendingTools.has(event.toolCallId)) {
      const component = this.createToolComponent(event.toolName, event.toolCallId, event.args)
      this.chatContainer.addChild(component)
      this.pendingTools.set(event.toolCallId, component)
    }
  }

  private handleToolExecutionUpdate(event: ToolExecutionUpdateEvent): void {
    if (!event.toolCallId) {
      return
    }
    const component = this.pendingTools.get(event.toolCallId)
    if (component && event.partialResult) {
      component.updateResult({ ...event.partialResult, isError: false }, true)
    }
  }

  private handleToolExecutionEnd(event: ToolExecutionEndEvent): void {
    if (!event.toolCallId) {
      return
    }
    const component = this.pendingTools.get(event.toolCallId)
    if (component) {
      component.updateResult({ ...event.result, isError: event.isError ?? false })
      this.pendingTools.delete(event.toolCallId)
    }
  }

  private handleEvent(event: PeekSocketEvent): void {
    if (event.type === 'sync') {
      this.loadSession()
      this.rebuildChat()
      this.handleSyncEvent(event)
    } else if (event.type === 'message_start') {
      this.handleMessageStart(event)
    } else if (event.type === 'message_update') {
      this.handleMessageUpdate(event)
    } else if (event.type === 'message_end') {
      this.handleMessageEnd(event)
    } else if (event.type === 'tool_execution_start') {
      this.handleToolExecutionStart(event)
    } else if (event.type === 'tool_execution_update') {
      this.handleToolExecutionUpdate(event)
    } else if (event.type === 'tool_execution_end') {
      this.handleToolExecutionEnd(event)
    } else if (event.type === 'agent_settled') {
      this.cleanupStreaming()
      this.loadSession()
      this.rebuildChat()
      this.status = 'done'
    }
    this.invalidateCache()
    if (this.followMode) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER
    }
    this.tui.requestRender()
  }

  private syncToolComponentsFromMessage(): void {
    if (!this.streamingMessage) {
      return
    }
    for (const content of this.streamingMessage.content) {
      if (content.type !== 'toolCall') {
        continue
      }
      const existing = this.pendingTools.get(content.id)
      if (existing) {
        existing.updateArgs(content.arguments)
      } else {
        const component = this.createToolComponent(content.name, content.id, content.arguments)
        this.chatContainer.addChild(component)
        this.pendingTools.set(content.id, component)
      }
    }
  }

  private ensureStreamingComponent(): void {
    if (this.streamingComponent) {
      return
    }
    this.streamingMessage = {
      api: 'responses',
      content: [],
      model: '',
      provider: 'openai-codex',
      role: 'assistant',
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
      },
    }
    this.streamingComponent = new AssistantMessageComponent(undefined, true, getMarkdownTheme())
    this.chatContainer.addChild(this.streamingComponent)
    this.streamingComponent.updateContent(this.streamingMessage)
  }

  private cleanupStreaming(): void {
    if (this.streamingComponent) {
      this.chatContainer.removeChild(this.streamingComponent)
    }
    this.streamingComponent = undefined
    this.streamingMessage = undefined
    this.pendingTools.clear()
  }

  private poll(): void {
    if (!this.socket && isPeekActive(this.info.id) && Date.now() - this.lastConnectAttemptAt >= 2000) {
      this.connectSocket()
    }
    try {
      const { size } = statSync(this.sessionFile)
      if (size === this.lastFileSize) {
        return
      }
      this.loadSession()
      if (!this.streamingComponent) {
        this.rebuildChat()
      }
      this.invalidateCache()
      if (this.followMode) {
        this.scrollOffset = Number.MAX_SAFE_INTEGER
      }
      this.tui.requestRender()
    } catch {
      // Best effort; a transient stat failure is retried on the next poll.
    }
  }

  private handleNavigationInput(data: string): boolean {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || data === 'q') {
      this.dispose()
      this.done()
      return true
    }
    if (matchesKey(data, 'left')) {
      this.dispose()
      this.done('previous')
      return true
    }
    if (matchesKey(data, 'right')) {
      this.dispose()
      this.done('next')
      return true
    }
    return false
  }

  private handleScrollInput(data: string): boolean {
    if (matchesKey(data, 'up') || data === 'k') {
      this.followMode = false
      this.scrollOffset = Math.max(0, this.scrollOffset - 1)
    } else if (matchesKey(data, 'down') || data === 'j') {
      this.scrollOffset++
    } else if (matchesKey(data, 'pageUp') || matchesKey(data, 'ctrl+u')) {
      this.followMode = false
      this.scrollOffset = Math.max(0, this.scrollOffset - 15)
    } else if (matchesKey(data, 'pageDown') || matchesKey(data, 'ctrl+d')) {
      this.scrollOffset += 15
    } else if (data === 'g') {
      this.followMode = false
      this.scrollOffset = 0
    } else if (data === 'G' || matchesKey(data, 'shift+g')) {
      this.followMode = true
      this.scrollOffset = Number.MAX_SAFE_INTEGER
    } else {
      return false
    }
    return true
  }

  handleInput(data: string): void {
    if (this.handleNavigationInput(data)) {
      return
    }
    if (this.handleScrollInput(data)) {
      this.tui.requestRender()
    }
  }

  private invalidateCache(): void {
    this.cachedLines = undefined
    this.cachedWidth = undefined
  }

  invalidate(): void {
    this.chatContainer.invalidate()
    this.invalidateCache()
  }

  private renderHeader(innerWidth: number): string {
    const title = ` ${this.info.taskName} `
    const modelTag = this.modelName ? `[${truncateToWidth(this.modelName, 18)}] ` : ''
    const statusText = ` ${STATUS_ICONS[this.status]} ${this.status} `
    const statusColor = STATUS_COLORS[this.status]
    const statusWidth = visibleWidth(statusText)
    if (statusWidth > innerWidth) {
      return this.theme.fg(statusColor, truncateToWidth(statusText, innerWidth, ''))
    }
    const leftWidth = innerWidth - statusWidth
    const left = truncateToWidth(`${title}${modelTag}`, leftWidth, '')
    return (
      this.theme.fg(persistedProfileColor(this.info.profile, this.info.color), left) +
      this.theme.fg('border', '─'.repeat(Math.max(0, leftWidth - visibleWidth(left)))) +
      this.theme.fg(statusColor, statusText)
    )
  }

  private getContentLines(innerWidth: number): string[] {
    if (this.cachedLines && this.cachedWidth === innerWidth) {
      return this.cachedLines
    }
    const contentLines = stripPromptMarkers(this.chatContainer.render(innerWidth))
    this.cachedLines = contentLines
    this.cachedWidth = innerWidth
    return contentLines
  }

  render(width: number): string[] {
    if (width <= 1) {
      return [truncateToWidth('╴', Math.max(0, width), '')]
    }
    const innerWidth = Math.max(0, width - 2)
    const lines = [this.theme.fg('border', '╭') + this.renderHeader(innerWidth) + this.theme.fg('border', '╮')]

    const contentLines = this.getContentLines(innerWidth)
    const maxHeight = Math.min(60, Math.max(8, this.tui.terminal.rows - 4))
    const maxVisible = Math.max(4, maxHeight - 4)
    const maxScroll = Math.max(0, contentLines.length - maxVisible)
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll)
    const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + maxVisible)
    for (const line of visible) {
      const clipped = truncateToWidth(line, innerWidth, '')
      const padded = clipped + ' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)))
      lines.push(this.theme.fg('border', '│') + padded + this.theme.fg('border', '│'))
    }
    for (let index = visible.length; index < maxVisible; index++) {
      lines.push(this.theme.fg('border', '│') + ' '.repeat(innerWidth) + this.theme.fg('border', '│'))
    }
    const scrollInfo =
      contentLines.length > maxVisible
        ? `${this.scrollOffset + 1}-${Math.min(this.scrollOffset + maxVisible, contentLines.length)}/${contentLines.length}`
        : `${contentLines.length}L`
    const followIcon = this.followMode ? this.theme.fg('success', '●') : this.theme.fg('dim', '○')
    lines.push(this.theme.fg('border', `├${'─'.repeat(innerWidth)}┤`))
    const footer = ` ${scrollInfo} ${followIcon} │ ←/→ agent │ j/k scroll │ g/G top/end │ q close `
    const clippedFooter = truncateToWidth(footer, innerWidth, '')
    lines.push(
      this.theme.fg('border', '│') +
        this.theme.fg('dim', clippedFooter) +
        ' '.repeat(Math.max(0, innerWidth - visibleWidth(clippedFooter))) +
        this.theme.fg('border', '│')
    )
    lines.push(this.theme.fg('border', `╰${'─'.repeat(innerWidth)}╯`))
    return lines
  }

  dispose(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
    }
    this.pollInterval = undefined
    this.socket?.end()
    this.socket = undefined
  }
}
