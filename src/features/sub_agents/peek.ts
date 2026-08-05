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
import { Effect, Exit, Fiber, Schema, Scope } from 'effect'

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

const TextContentSchema = Schema.Struct({
  text: Schema.String,
  textSignature: Schema.optional(Schema.String),
  type: Schema.Literal('text'),
})

const ThinkingContentSchema = Schema.Struct({
  redacted: Schema.optional(Schema.Boolean),
  thinking: Schema.String,
  thinkingSignature: Schema.optional(Schema.String),
  type: Schema.Literal('thinking'),
})

const ImageContentSchema = Schema.Struct({
  data: Schema.String,
  mimeType: Schema.String,
  type: Schema.Literal('image'),
})

const ToolCallSchema = Schema.Struct({
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  id: Schema.String,
  name: Schema.String,
  thoughtSignature: Schema.optional(Schema.String),
  type: Schema.Literal('toolCall'),
})

const UsageSchema = Schema.Struct({
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  cacheWrite1h: Schema.optional(Schema.Finite),
  cost: Schema.Struct({
    cacheRead: Schema.Finite,
    cacheWrite: Schema.Finite,
    input: Schema.Finite,
    output: Schema.Finite,
    total: Schema.Finite,
  }),
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.optional(Schema.Finite),
  totalTokens: Schema.Finite,
})

const AssistantMessageDiagnosticSchema = Schema.Struct({
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
      message: Schema.String,
      name: Schema.optional(Schema.String),
      stack: Schema.optional(Schema.String),
    })
  ),
  timestamp: Schema.Finite,
  type: Schema.String,
})

const StopReasonSchema = Schema.Literals(['stop', 'length', 'toolUse', 'error', 'aborted'] as const)

const UserMessageSchema = Schema.Struct({
  content: Schema.Union([Schema.String, Schema.Array(Schema.Union([TextContentSchema, ImageContentSchema]))]),
  role: Schema.Literal('user'),
  timestamp: Schema.Finite,
})

const AssistantMessageSchema = Schema.Struct({
  api: Schema.String,
  content: Schema.Array(Schema.Union([TextContentSchema, ThinkingContentSchema, ToolCallSchema])),
  diagnostics: Schema.optional(Schema.Array(AssistantMessageDiagnosticSchema)),
  errorMessage: Schema.optional(Schema.String),
  model: Schema.String,
  provider: Schema.String,
  responseId: Schema.optional(Schema.String),
  responseModel: Schema.optional(Schema.String),
  role: Schema.Literal('assistant'),
  stopReason: StopReasonSchema,
  timestamp: Schema.Finite,
  usage: UsageSchema,
})

const ToolResultMessageSchema = Schema.Struct({
  addedToolNames: Schema.optional(Schema.Array(Schema.String)),
  content: Schema.Array(Schema.Union([TextContentSchema, ImageContentSchema])),
  details: Schema.optional(Schema.Unknown),
  isError: Schema.Boolean,
  role: Schema.Literal('toolResult'),
  timestamp: Schema.Finite,
  toolCallId: Schema.String,
  toolName: Schema.String,
  usage: Schema.optional(UsageSchema),
})

const MessageSchema = Schema.Union([UserMessageSchema, AssistantMessageSchema, ToolResultMessageSchema])

const ToolExecutionResultPayloadSchema = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      data: Schema.optional(Schema.String),
      mimeType: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
      type: Schema.String,
    })
  ),
  details: Schema.optional(Schema.Unknown),
})

const ActiveToolEventSchema = Schema.Struct({
  args: Schema.Unknown,
  isError: Schema.optional(Schema.Boolean),
  partialResult: Schema.optional(ToolExecutionResultPayloadSchema),
  result: Schema.optional(ToolExecutionResultPayloadSchema),
  toolCallId: Schema.String,
  toolName: Schema.String,
})

const PeekSocketEventSchema = Schema.Union([
  Schema.Struct({
    activeTools: Schema.optional(Schema.Array(ActiveToolEventSchema)),
    partialMessage: Schema.optional(AssistantMessageSchema),
    status: Schema.optional(Schema.Literals(['thinking', 'streaming', 'tool', 'done'] as const)),
    type: Schema.Literal('sync'),
    userMessage: Schema.optional(MessageSchema),
  }),
  Schema.Struct({
    message: MessageSchema,
    type: Schema.Literal('message_start'),
  }),
  Schema.Struct({
    assistantMessageEvent: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
    message: MessageSchema,
    type: Schema.Literal('message_update'),
  }),
  Schema.Struct({
    message: MessageSchema,
    type: Schema.Literal('message_end'),
  }),
  Schema.Struct({
    args: Schema.Unknown,
    toolCallId: Schema.String,
    toolName: Schema.String,
    type: Schema.Literal('tool_execution_start'),
  }),
  Schema.Struct({
    args: Schema.Unknown,
    partialResult: ToolExecutionResultPayloadSchema,
    toolCallId: Schema.String,
    toolName: Schema.String,
    type: Schema.Literal('tool_execution_update'),
  }),
  Schema.Struct({
    isError: Schema.Boolean,
    result: ToolExecutionResultPayloadSchema,
    toolCallId: Schema.String,
    toolName: Schema.String,
    type: Schema.Literal('tool_execution_end'),
  }),
  Schema.Struct({
    type: Schema.Literal('agent_settled'),
  }),
])

const isPeekSocketEvent = Schema.is(PeekSocketEventSchema)

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
  done: (navigation?: 'previous' | 'next' | 'back') => void
}

export class SubagentPeekOverlay {
  private readonly tui: TUI
  private readonly theme: Theme
  private readonly info: AgentInfo
  private readonly done: (navigation?: 'previous' | 'next' | 'back') => void
  private readonly sessionFile: string
  private readonly cwd: string
  private readonly modelName: string
  private sessionManager: SessionManager | undefined = undefined
  private lastFileSize = 0
  private readonly chatContainer = new Container()
  private scrollOffset = Number.MAX_SAFE_INTEGER
  private followMode = true
  private socket: Socket | undefined = undefined
  private socketScope: Scope.Closeable | undefined = undefined
  private socketBuffer = ''
  private status: PeekStatus = 'done'
  private streamingComponent: AssistantMessageComponent | undefined = undefined
  private streamingMessage: AssistantMessage | undefined = undefined
  private readonly pendingTools = new Map<string, ToolExecutionComponent>()
  private disposed = false
  private pollFiber: Fiber.Fiber<never> | undefined = undefined
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
    this.pollFiber = Effect.runFork(Effect.forever(Effect.delay(Effect.sync(() => this.poll()).pipe(Effect.ignoreCause), 200)))
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
    if (this.sessionManager === undefined) {
      return
    }
    const context = this.sessionManager.buildSessionContext()
    for (const message of context.messages) {
      if (message.role === 'user') {
        const text = this.getUserText(message)
        if (text !== '') {
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
        if (component !== undefined) {
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

  /** Releases the scope only if it is still the caller's current connection, so a closed-then-superseded socket cannot tear down a newer one. */
  private releaseSocketScope(scope: Scope.Closeable): void {
    if (this.socketScope !== scope) {
      return
    }
    this.socketScope = undefined
    this.socket = undefined
    Effect.runFork(Scope.close(scope, Exit.void))
  }

  private connectSocket(): void {
    this.lastConnectAttemptAt = Date.now()
    const scope = Scope.makeUnsafe()
    let socket: Socket
    try {
      socket = Effect.runSync(
        Effect.acquireRelease(
          Effect.sync(() => connect(getSocketPath(this.info.id))),
          (connectedSocket) => Effect.sync(() => connectedSocket.destroy())
        ).pipe(Effect.provideService(Scope.Scope, scope))
      )
    } catch {
      Effect.runFork(Scope.close(scope, Exit.void))
      return
    }
    this.socket = socket
    this.socketScope = scope
    this.socketBuffer = ''
    socket.on('error', () => this.releaseSocketScope(scope))
    socket.on('close', () => {
      this.releaseSocketScope(scope)
      if (this.disposed) {
        return
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
        if (line.trim() === '') {
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          parsed = undefined
        }
        if (isPeekSocketEvent(parsed)) {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- isPeekSocketEvent already validated this shape; only the readonly/mutable modifier differs from the hand-written event union.
          this.handleEvent(parsed as PeekSocketEvent)
        }
      }
    })
  }

  private handleSyncEvent(event: SyncEvent): void {
    this.status = event.status || 'done'
    if (event.userMessage !== undefined) {
      const text = this.getUserText(event.userMessage)
      if (text !== '') {
        this.chatContainer.addChild(new UserMessageComponent(text, getMarkdownTheme()))
      }
    }
    if (event.partialMessage !== undefined) {
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
    if (component === undefined) {
      component = this.createToolComponent(activeTool.toolName, activeTool.toolCallId, activeTool.args)
      this.chatContainer.addChild(component)
      this.pendingTools.set(activeTool.toolCallId, component)
    }
    if (activeTool.result !== undefined) {
      component.updateResult({ ...activeTool.result, isError: activeTool.isError ?? false })
      this.pendingTools.delete(activeTool.toolCallId)
    } else if (activeTool.partialResult !== undefined) {
      component.updateResult({ ...activeTool.partialResult, isError: false }, true)
    }
  }

  private handleMessageStart(event: MessageStartEvent): void {
    if (event.message?.role === 'user') {
      const text = this.getUserText(event.message)
      if (text !== '') {
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
    if (this.streamingComponent === undefined || event.message?.role !== 'assistant') {
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
    if (event.toolCallId !== '' && event.toolName !== '' && !this.pendingTools.has(event.toolCallId)) {
      const component = this.createToolComponent(event.toolName, event.toolCallId, event.args)
      this.chatContainer.addChild(component)
      this.pendingTools.set(event.toolCallId, component)
    }
  }

  private handleToolExecutionUpdate(event: ToolExecutionUpdateEvent): void {
    if (event.toolCallId === '') {
      return
    }
    const component = this.pendingTools.get(event.toolCallId)
    if (component !== undefined && event.partialResult !== undefined) {
      component.updateResult({ ...event.partialResult, isError: false }, true)
    }
  }

  private handleToolExecutionEnd(event: ToolExecutionEndEvent): void {
    if (event.toolCallId === '') {
      return
    }
    const component = this.pendingTools.get(event.toolCallId)
    if (component !== undefined) {
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
    if (this.streamingMessage === undefined) {
      return
    }
    for (const content of this.streamingMessage.content) {
      if (content.type !== 'toolCall') {
        continue
      }
      const existing = this.pendingTools.get(content.id)
      if (existing === undefined) {
        const component = this.createToolComponent(content.name, content.id, content.arguments)
        this.chatContainer.addChild(component)
        this.pendingTools.set(content.id, component)
      } else {
        existing.updateArgs(content.arguments)
      }
    }
  }

  private ensureStreamingComponent(): void {
    if (this.streamingComponent !== undefined) {
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
    if (this.streamingComponent !== undefined) {
      this.chatContainer.removeChild(this.streamingComponent)
    }
    this.streamingComponent = undefined
    this.streamingMessage = undefined
    this.pendingTools.clear()
  }

  private poll(): void {
    if (this.disposed) {
      return
    }
    if (this.socket === undefined && isPeekActive(this.info.id) && Date.now() - this.lastConnectAttemptAt >= 2000) {
      this.connectSocket()
    }
    try {
      const { size } = statSync(this.sessionFile)
      if (size === this.lastFileSize) {
        return
      }
      this.loadSession()
      if (this.streamingComponent === undefined) {
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
    if (matchesKey(data, 'escape')) {
      this.dispose()
      this.done('back')
      return true
    }
    if (matchesKey(data, 'ctrl+c') || data === 'q') {
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
    const modelTag = this.modelName === '' ? '' : `[${truncateToWidth(this.modelName, 18)}] `
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
    if (this.cachedLines !== undefined && this.cachedWidth === innerWidth) {
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
    const maxVisible = Math.max(4, this.tui.terminal.rows - 4)
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
    const footer = ` ${scrollInfo} ${followIcon} │ esc back/again stop │ ←/→ agent │ j/k scroll │ g/G top/end │ q close `
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
    this.disposed = true
    if (this.pollFiber !== undefined) {
      Effect.runFork(Fiber.interrupt(this.pollFiber))
      this.pollFiber = undefined
    }
    if (this.socketScope !== undefined) {
      this.releaseSocketScope(this.socketScope)
    }
  }
}
