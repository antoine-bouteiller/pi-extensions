import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionCommandContext,
  getMarkdownTheme,
  type KeybindingsManager,
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry,
  sessionEntryToContextMessages,
  type Theme,
  ToolExecutionComponent,
  type ToolRenderers,
  UserMessageComponent,
} from '@earendil-works/pi-coding-agent'
import {
  type Component,
  Container,
  matchesKey,
  ScrollView,
  sliceByColumn,
  Text,
  truncateToWidth,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from '@earendil-works/pi-tui'
import { Effect } from 'effect'
import { FileSystem } from 'effect/FileSystem'

import { type RunningAgentView } from './subagents.js'

type AgentMessage = ReturnType<typeof sessionEntryToContextMessages>[number]
type ViewerTheme = Pick<Theme, 'bg' | 'bold' | 'fg'>
type ViewerKeybindings = Pick<KeybindingsManager, 'getKeys' | 'matches'>

const REFRESH_INTERVAL = '500 millis'
const COLLAPSED_RESULT_LINES = 3
const ARGS_PREVIEW_CHARS = 160
/** Border and one column of padding on each side. */
const FRAME_CHROME = 4

type ToolRendering = ConstructorParameters<typeof ToolExecutionComponent>[4]

const BUILT_IN_TOOLS = new Map<string, (cwd: string) => ToolRendering>([
  ['bash', createBashToolDefinition],
  ['edit', createEditToolDefinition],
  ['find', createFindToolDefinition],
  ['grep', createGrepToolDefinition],
  ['ls', createLsToolDefinition],
  ['read', createReadToolDefinition],
  ['write', createWriteToolDefinition],
])

/**
 * The root-to-leaf branch of the last persisted entry, compactions included.
 *
 * @internal
 */
export const transcriptEntries = (text: string): readonly SessionEntry[] => {
  try {
    const parsed = parseSessionEntries(text)
    migrateSessionEntries(parsed)
    const entries = parsed.filter((entry): entry is SessionEntry => entry.type !== 'session')
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    const branch: SessionEntry[] = []
    const visited = new Set<string>()
    let current = entries.at(-1)
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

/**
 * Renders a tool the viewer has no definition for: its tool definitions live in the child process.
 *
 * @internal
 */
export const displayOnlyRenderers = (name: string, expandKey: string): ToolRenderers => ({
  renderCall: (args, theme, context) => {
    const compact = JSON.stringify(args) ?? ''
    const preview = context.expanded || compact.length <= ARGS_PREVIEW_CHARS ? compact : `${compact.slice(0, ARGS_PREVIEW_CHARS - 1)}…`
    return new Text(`${theme.fg('toolTitle', theme.bold(name))} ${theme.fg('muted', preview)}`, 0, 0)
  },
  renderResult: (result, { expanded }, theme) => {
    const lines = result.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')
      .split('\n')
    const shown = expanded ? lines : lines.slice(0, COLLAPSED_RESULT_LINES)
    const remaining = lines.length - shown.length
    const text = shown.map((line) => theme.fg('toolOutput', line)).join('\n')
    return new Text(remaining > 0 ? `${text}\n${theme.fg('muted', `… (${remaining} more lines, ${expandKey} to expand)`)}` : text, 0, 0)
  },
})

const userText = (message: Extract<AgentMessage, { readonly role: 'user' }>): string =>
  typeof message.content === 'string' ? message.content : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')

interface TranscriptView {
  readonly component: Container
  readonly setText: (text: string) => void
  readonly toggleExpanded: () => void
}

const createTranscriptView = (options: {
  readonly cwd: string
  readonly expanded: boolean
  readonly expandKey: string
  readonly theme: ViewerTheme
  readonly tui: TUI
}): TranscriptView => {
  const component = new Container()
  const definitions = new Map<string, ToolRendering>()
  let { expanded } = options
  let tools: ToolExecutionComponent[] = []
  let applied: string | undefined

  const definition = (name: string): ToolRendering => {
    const known = definitions.get(name)
    if (known !== undefined) {
      return known
    }
    const create = BUILT_IN_TOOLS.get(name)
    const created = create === undefined ? displayOnlyRenderers(name, options.expandKey) : create(options.cwd)
    definitions.set(name, created)
    return created
  }

  const addMessage = (message: AgentMessage, pending: Map<string, ToolExecutionComponent>): void => {
    if (message.role === 'user') {
      const text = userText(message)
      if (text.length > 0) {
        component.addChild(new UserMessageComponent(text, getMarkdownTheme()))
      }
    } else if (message.role === 'assistant') {
      component.addChild(new AssistantMessageComponent(message, false, getMarkdownTheme()))
      for (const part of message.content) {
        if (part.type === 'toolCall') {
          const tool = new ToolExecutionComponent(part.name, part.id, part.arguments, {}, definition(part.name), options.tui, options.cwd)
          tool.setExpanded(expanded)
          component.addChild(tool)
          tools.push(tool)
          pending.set(part.id, tool)
        }
      }
      if (message.stopReason === 'aborted' || message.stopReason === 'error') {
        const error = message.errorMessage ?? (message.stopReason === 'aborted' ? 'Operation aborted' : 'Error')
        for (const tool of pending.values()) {
          tool.updateResult({ content: [{ text: error, type: 'text' }], isError: true })
        }
        pending.clear()
      }
    } else if (message.role === 'toolResult') {
      pending.get(message.toolCallId)?.updateResult(message)
      pending.delete(message.toolCallId)
    }
  }

  const setText = (text: string): void => {
    if (text === applied) {
      return
    }
    applied = text
    component.clear()
    tools = []
    const pending = new Map<string, ToolExecutionComponent>()
    const entries = transcriptEntries(text)
    if (entries.length === 0) {
      component.addChild(new Text(options.theme.fg('muted', 'No messages yet.'), 0, 0))
    }
    for (const entry of entries) {
      if (entry.type === 'compaction') {
        component.addChild(new Text(options.theme.fg('muted', `── context compacted (${entry.tokensBefore} tokens) ──`), 0, 0))
        continue
      }
      for (const message of sessionEntryToContextMessages(entry)) {
        addMessage(message, pending)
      }
    }
  }

  return {
    component,
    setText,
    toggleExpanded: () => {
      expanded = !expanded
      for (const tool of tools) {
        tool.setExpanded(expanded)
      }
    },
  }
}

/** Formats keys the way Pi labels its own shortcuts, for example `Ctrl+End`. */
const keyDisplay = (keys: readonly string[]): string =>
  keys
    .map((key) =>
      key
        .split('+')
        .map((part) => (process.platform === 'darwin' && part.toLowerCase() === 'alt' ? 'option' : part))
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('+')
    )
    .join('/')

const fit = (line: string, width: number): string => {
  const content = truncateToWidth(line, width, '')
  return `${content}${' '.repeat(Math.max(0, width - visibleWidth(content)))}`
}

export interface TranscriptOverlay extends Component {
  readonly setText: (text: string) => void
  readonly setStatus: (status: string) => void
  readonly scroll: ScrollView
}

/** @internal */
export const createTranscriptOverlay = (options: {
  readonly agent: RunningAgentView
  readonly expanded: boolean
  readonly keybindings: ViewerKeybindings
  readonly onClose: () => void
  readonly theme: ViewerTheme
  readonly tui: TUI
}): TranscriptOverlay => {
  const { keybindings, theme, tui } = options
  const expandKey = keybindings.getKeys('app.tools.expand').join('/')
  const view = createTranscriptView({ cwd: options.agent.cwd, expandKey, expanded: options.expanded, theme, tui })
  const scroll = new ScrollView(view.component, { follow: 'end' })
  const jumpLabel = theme.bg(
    'selectedBg',
    theme.fg('text', ` ↓ Jump to latest message · ${keyDisplay(keybindings.getKeys('tui.altScreen.bottom'))} `)
  )
  let status: string = options.agent.status
  /** Body-relative column range of the jump label as last drawn, while it is shown. */
  let label: { readonly start: number; readonly end: number } | undefined
  let bodyRows = 0

  const requestRender = () => tui.requestRender()
  const border = (text: string) => theme.fg('border', text)
  const height = () => Math.max(3, Math.floor(tui.terminal.rows * 0.8))

  const top = (width: number): string => {
    const title = truncateToWidth(`${options.agent.name ?? options.agent.agent_id} · ${options.agent.model} · ${status}`, Math.max(0, width - 6), '…')
    return `${border('╭─ ')}${theme.bold(title)}${border(` ${'─'.repeat(Math.max(0, width - 5 - visibleWidth(title)))}╮`)}`
  }

  const bottom = (width: number): string => {
    const hints = truncateToWidth(`↑↓ scroll · pgup/pgdn page · ${expandKey} expand tools · esc close`, Math.max(0, width - 6), '')
    return border(`╰─ ${hints} ${'─'.repeat(Math.max(0, width - 5 - visibleWidth(hints)))}╯`)
  }

  const withLabel = (row: string, width: number): string => {
    const text = truncateToWidth(jumpLabel, width, '')
    const labelWidth = visibleWidth(text)
    const start = Math.floor((width - labelWidth) / 2)
    label = { end: start + labelWidth, start }
    return `${sliceByColumn(row, 0, start)}${text}${sliceByColumn(row, start + labelWidth, width - start - labelWidth)}`
  }

  const scrollToEnd = () => {
    scroll.scrollToEnd()
    requestRender()
  }

  return {
    handleInput: (data) => {
      if (keybindings.matches(data, 'app.tools.expand')) {
        view.toggleExpanded()
      } else if (matchesKey(data, 'escape') || data === 'q') {
        options.onClose()
        return
      } else if (keybindings.matches(data, 'tui.altScreen.bottom')) {
        scroll.scrollToEnd()
      } else if (matchesKey(data, 'up')) {
        scroll.scrollBy(-1)
      } else if (matchesKey(data, 'down')) {
        scroll.scrollBy(1)
      } else if (matchesKey(data, 'pageUp')) {
        scroll.scrollBy(-Math.max(1, bodyRows))
      } else if (matchesKey(data, 'pageDown')) {
        scroll.scrollBy(Math.max(1, bodyRows))
      } else {
        return
      }
      requestRender()
    },
    // Pi routes an unhandled wheel over an overlay to the main transcript behind it.
    handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
      if (event.type === 'wheel') {
        scroll.scrollBy(event.wheelDelta ?? 0)
        return { handled: true }
      }
      const column = event.x - 2
      if (
        event.type === 'press' &&
        event.button === 'left' &&
        label !== undefined &&
        event.y === bodyRows &&
        column >= label.start &&
        column < label.end
      ) {
        scrollToEnd()
        return { handled: true }
      }
      return undefined
    },
    invalidate: () => view.component.invalidate(),
    render: (width) => {
      const innerWidth = Math.max(1, width - FRAME_CHROME)
      bodyRows = height() - 2
      const content = view.component.render(innerWidth)
      scroll.updateLayout(content.length, bodyRows, requestRender)
      const body = Array.from({ length: bodyRows }, (_row, index) => fit(content[scroll.scrollTop + index] ?? '', innerWidth))
      label = undefined
      if (!scroll.isFollowingEnd && bodyRows > 0) {
        body[bodyRows - 1] = withLabel(body[bodyRows - 1] ?? '', innerWidth)
      }
      return [top(width), ...body.map((row) => `${border('│')} ${row} ${border('│')}`), bottom(width)].map((line) => truncateToWidth(line, width, ''))
    },
    scroll,
    setStatus: (next) => {
      if (next !== status) {
        status = next
        requestRender()
      }
    },
    setText: (text) => {
      view.setText(text)
      requestRender()
    },
  }
}

const optionLabel = (agent: RunningAgentView) => `${agent.name ?? agent.agent_id} · ${agent.model} · ${agent.status}`

/** Empty while there is no file to read. */
const sizeOf = (path: string | undefined) =>
  path === undefined
    ? Effect.succeed('')
    : FileSystem.pipe(
        Effect.flatMap((fs) => fs.stat(path)),
        Effect.map((info) => String(info.size)),
        Effect.orElseSucceed(() => '')
      )

const readText = (path: string | undefined) =>
  path === undefined
    ? Effect.succeed('')
    : FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(path)),
        Effect.orElseSucceed(() => '')
      )

/** `/subagents`: picks a running child of this session and shows its persisted conversation, read-only. */
export const openViewer = (
  source: { readonly running: (ctx: ExtensionCommandContext) => readonly RunningAgentView[] },
  ctx: ExtensionCommandContext
) =>
  Effect.gen(function* () {
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('/subagents needs the interactive TUI.', 'warning')
      return
    }
    const agents = source.running(ctx)
    if (agents.length === 0) {
      ctx.ui.notify('No running sub-agents.', 'info')
      return
    }
    const options = agents.map(optionLabel)
    const choice = yield* Effect.promise((signal) => ctx.ui.select('Sub-agents', options, { signal }))
    const chosen = agents[options.indexOf(choice ?? '')]
    if (chosen === undefined) {
      return
    }
    const current = () => source.running(ctx).find((agent) => agent.agent_id === chosen.agent_id)
    const agent = current()
    if (agent === undefined) {
      ctx.ui.notify(`Agent ${chosen.agent_id} is no longer running.`, 'warning')
      return
    }
    let size = yield* sizeOf(agent.session_file)
    const initial = yield* readText(agent.session_file)
    let overlay: TranscriptOverlay | undefined

    const refresh = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(REFRESH_INTERVAL)
        const running = current()
        if (running === undefined) {
          overlay?.setStatus('exited')
          return
        }
        overlay?.setStatus(running.status)
        const next = yield* sizeOf(running.session_file)
        if (next !== size) {
          size = next
          overlay?.setText(yield* readText(running.session_file))
        }
      }
    })

    yield* Effect.forkScoped(refresh)
    yield* Effect.promise(() =>
      ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => {
          overlay = createTranscriptOverlay({ agent, expanded: ctx.ui.getToolsExpanded(), keybindings, onClose: () => done(undefined), theme, tui })
          overlay.setText(initial)
          return overlay
        },
        { overlay: true, overlayOptions: { maxHeight: '80%', width: '80%' } }
      )
    )
  }).pipe(Effect.scoped)
