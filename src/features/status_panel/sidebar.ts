import { type ExtensionContext, type ThemeColor } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth, type Component, type OverlayHandle } from '@earendil-works/pi-tui'
import { DateTime } from 'effect'
import { type Path } from 'effect/Path'

import { type RunningAgent } from '#shared/state/agent_activity'
import { formatStatusText, type StatusEntry, type StatusTone } from '#shared/state/status_bar'
import { isEmptyString, isNotEmptyString } from '#shared/utils/predicates'

import { formatDirectory, formatTokens } from './render.js'
import { createSplitPaneController, type SplitPaneController } from './split_pane.js'
import { type GitInfoState, type ModelInfoState, type ProviderQuota, type ProviderQuotas, type QuotaWindow } from './state.js'

export interface SidebarTheme {
  fg: (color: ThemeColor, text: string) => string
  bold?: (text: string) => string
}

export interface SidebarState {
  activity: 'ready' | 'working'
  cwd: string
  model: ModelInfoState
  git: GitInfoState
  quotas: ProviderQuotas
  agents?: readonly RunningAgent[]
  extensionStatuses: readonly StatusEntry[]
  sessionId?: string
}

const MAX_AGENT_ROWS = 5

type PaletteColor = 'purple' | 'blue' | 'green' | 'red' | 'orange' | 'gray' | 'white'

const THEME_COLORS = {
  blue: 'thinkingLow',
  gray: 'muted',
  green: 'success',
  orange: 'warning',
  purple: 'accent',
  red: 'error',
  white: 'text',
} satisfies Record<PaletteColor, ThemeColor>

const paint = (theme: SidebarTheme, color: PaletteColor, text: string) => {
  if (process.env.NO_COLOR !== undefined) {
    return text
  }
  return theme.fg(THEME_COLORS[color], text)
}

const bold = (theme: SidebarTheme, text: string) => theme.bold?.(text) ?? text

/* The left edge stays blank so a terminal selection of the chat or input area only ever picks up trimmable whitespace. */
const gutterRow = (content: string, width: number, panelWidth: number) => truncateToWidth(`  ${pad(content, panelWidth)}`, width, '')

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')
const sanitize = (text: string) =>
  Array.from(text.replace(ANSI_PATTERN, ''), (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  })
    .join('')
    .replaceAll(/\s+/g, ' ')
    .trim()

const pad = (text: string, width: number) => {
  const content = truncateToWidth(text, Math.max(0, width), '')
  return `${content}${' '.repeat(Math.max(0, width - visibleWidth(content)))}`
}

const spaced = (left: string, right: string, width: number) => {
  if (isEmptyString(right)) {
    return truncateToWidth(left, width, '')
  }
  const leftWidth = Math.min(visibleWidth(left), Math.max(0, Math.floor(width * 0.55)))
  const fittedLeft = truncateToWidth(left, leftWidth, '')
  const fittedRight = truncateToWidth(right, Math.max(0, width - visibleWidth(fittedLeft) - 1), '')
  const gap = ' '.repeat(Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight)))
  return truncateToWidth(`${fittedLeft}${gap}${fittedRight}`, width, '')
}

interface PanelOptions {
  title: string
  rows: readonly string[]
  width: number
  theme: SidebarTheme
  color: PaletteColor
  jewel?: string
}

const panel = ({ title, rows, width, theme, color, jewel = '✦' }: PanelOptions) => {
  if (width <= 0) {
    return []
  }
  const innerWidth = Math.max(0, width - 4)
  const safeTitle = sanitize(title).toUpperCase()
  const prefix = `╭─ ${jewel} `
  const fill = '─'.repeat(Math.max(0, width - visibleWidth(prefix) - visibleWidth(safeTitle) - 2))
  const top = truncateToWidth(
    `${paint(theme, color, prefix)}${bold(theme, paint(theme, color, safeTitle))} ${paint(theme, color, `${fill}╮`)}`,
    width,
    ''
  )
  const body = rows.map((row) => truncateToWidth(`${paint(theme, 'gray', '│')} ${pad(row, innerWidth)} ${paint(theme, 'gray', '│')}`, width, ''))
  const bottom = paint(theme, 'gray', `╰${'─'.repeat(Math.max(0, width - 2))}╯`)
  return [top, ...body, truncateToWidth(bottom, width, ''), '']
}

const contextColor = (percent: number | undefined): PaletteColor => {
  if (percent === undefined || !Number.isFinite(percent)) {
    return 'gray'
  }
  if (percent >= 90) {
    return 'red'
  }
  if (percent >= 70) {
    return 'orange'
  }
  return 'blue'
}

const agentRows = (state: SidebarState, width: number, theme: SidebarTheme) => {
  const working = state.activity === 'working'
  const status = bold(theme, paint(theme, working ? 'orange' : 'green', working ? '◆ Working' : '● Ready'))
  const model = paint(theme, 'white', sanitize(state.model.modelId) || 'no model')
  const metadata = [state.model.provider, state.model.thinking]
    .map((value) => sanitize(value).toUpperCase())
    .filter(Boolean)
    .join(` ${paint(theme, 'gray', '·')} `)
  return [spaced(status, model, width), paint(theme, 'gray', isEmptyString(metadata) ? '—' : metadata)]
}

const contextRows = (state: SidebarState, width: number, theme: SidebarTheme) => {
  const { contextPercent, contextTokens, contextWindow } = state.model
  if (contextPercent === undefined || contextTokens === undefined) {
    return [paint(theme, 'gray', 'Context unavailable')]
  }
  const color = contextColor(contextPercent)
  const usage = `${formatTokens(contextTokens)} / ${contextWindow > 0 ? formatTokens(contextWindow) : '—'}`
  const percent = `${contextPercent.toFixed(1)}%`
  const meterWidth = Math.max(1, Math.min(16, width - 2))
  const filled = Math.max(0, Math.min(meterWidth, Math.round((contextPercent / 100) * meterWidth)))
  const meter = `${paint(theme, 'gray', '[')}${paint(theme, color, '■'.repeat(filled))}${paint(
    theme,
    'gray',
    '·'.repeat(meterWidth - filled)
  )}${paint(theme, 'gray', ']')}`
  return [spaced(paint(theme, color, usage), paint(theme, color, percent), width), meter]
}

const profileColor = (profile: string | undefined): PaletteColor => {
  switch (profile) {
    case 'scout': {
      return 'blue'
    }
    case 'librarian': {
      return 'purple'
    }
    case 'reviewer': {
      return 'orange'
    }
    case 'implementer': {
      return 'green'
    }
    default: {
      return 'gray'
    }
  }
}

const inactivity = (lastActivityAt: number | undefined, now: number): string => {
  const elapsed = Math.max(0, now - (lastActivityAt ?? now))
  return `${Math.floor(elapsed / 60_000)}m idle`
}

const subagentRow = (agent: RunningAgent, width: number, theme: SidebarTheme, now: number) => {
  const marker = '▸ '
  const idle = inactivity(agent.lastActivityAt, now)
  const nameWidth = width - visibleWidth(marker) - visibleWidth(idle) - 1
  const name = truncateToWidth(sanitize(agent.name), Math.max(0, nameWidth), '…')
  const gap = ' '.repeat(Math.max(1, width - visibleWidth(marker) - visibleWidth(name) - visibleWidth(idle)))
  const coloredName = paint(theme, profileColor(agent.profile), name)
  return truncateToWidth(`${paint(theme, 'gray', marker)}${coloredName}${gap}${idle}`, width, '')
}

const subagentRows = (agents: readonly RunningAgent[], width: number, theme: SidebarTheme, now: number) => {
  const shown = agents.slice(0, MAX_AGENT_ROWS)
  const rows = shown.map((agent) => subagentRow(agent, width, theme, now))
  if (agents.length > shown.length) {
    rows.push(paint(theme, 'gray', `+${agents.length - shown.length} more`))
  }
  return rows
}

const workspaceRows = (state: SidebarState, theme: SidebarTheme, path: Path) => {
  const project = path.basename(state.cwd) || formatDirectory(state.cwd, path)
  const rows = [paint(theme, 'white', sanitize(project)), paint(theme, 'gray', formatDirectory(state.cwd, path))]
  if (state.git.branch === undefined) {
    rows.push(paint(theme, 'gray', 'not a Git repository'))
  } else {
    const fileLabel = state.git.changedFiles === 1 ? 'file' : 'files'
    const change = state.git.changedFiles > 0 ? `${state.git.changedFiles} ${fileLabel} changed` : 'clean'
    rows.push(
      `${paint(theme, 'purple', sanitize(state.git.branch))} ${paint(theme, 'gray', '·')} ${paint(
        theme,
        state.git.changedFiles > 0 ? 'orange' : 'green',
        change
      )}`
    )
  }
  if (state.git.pullRequest !== undefined) {
    rows.push(paint(theme, 'purple', `PR #${state.git.pullRequest.number}`))
  }
  return rows
}

const quotaPercent = (percent: number) => (Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0)

const quotaColor = (percent: number): PaletteColor => {
  if (percent >= 90) {
    return 'red'
  }
  if (percent >= 70) {
    return 'orange'
  }
  return 'blue'
}

const quotaWindowRows = (window: QuotaWindow, width: number, theme: SidebarTheme) => {
  const percent = quotaPercent(window.percent)
  const color = quotaColor(percent)
  const resetsIn = sanitize(window.resetsIn ?? '')
  const detail = sanitize(window.detail ?? '')
  const trailingWidth = visibleWidth(resetsIn) + (isEmptyString(detail) ? 0 : visibleWidth(detail) + 1)
  const meterWidth = Math.max(1, Math.min(12, width - (trailingWidth === 0 ? 0 : trailingWidth + 1)))
  const filled = Math.max(0, Math.min(meterWidth, Math.round((percent / 100) * meterWidth)))
  const meter = `${paint(theme, color, '■'.repeat(filled))}${paint(theme, 'gray', '·'.repeat(meterWidth - filled))}`
  const headerDetail = isNotEmptyString(detail) && isEmptyString(resetsIn) ? ` ${detail}` : ''
  const header = spaced(paint(theme, color, sanitize(window.label)), paint(theme, color, `${percent.toFixed(1)}%${headerDetail}`), width)
  if (isEmptyString(resetsIn)) {
    return [header, meter]
  }
  const gap = ' '.repeat(Math.max(1, width - meterWidth - trailingWidth))
  return [
    header,
    truncateToWidth(`${meter}${gap}${paint(theme, 'gray', resetsIn)}${isEmptyString(detail) ? '' : ` ${paint(theme, color, detail)}`}`, width, ''),
  ]
}

const quotaRows = (quota: ProviderQuota, width: number, theme: SidebarTheme) => {
  const windows: readonly QuotaWindow[] =
    quota.windows?.length === undefined || quota.windows.length === 0
      ? [{ label: quota.label === 'anthropic' ? 'Session' : 'Azure', percent: quota.percent }]
      : quota.windows
  const rows = windows.flatMap((window) => quotaWindowRows(window, width, theme))
  if ((quota.windows?.length ?? 0) === 0 && quota.detail !== undefined && isNotEmptyString(quota.detail)) {
    rows.push(paint(theme, 'gray', sanitize(quota.detail)))
  }
  return rows
}

const STATUS_TONE_COLORS = {
  error: 'red',
  info: 'blue',
  muted: 'gray',
  success: 'green',
  warning: 'orange',
} satisfies Record<StatusTone, PaletteColor>

const statusRows = (statuses: readonly StatusEntry[], theme: SidebarTheme) =>
  statuses
    .map((status) => ({ color: STATUS_TONE_COLORS[status.tone ?? 'muted'], text: sanitize(formatStatusText(status)) }))
    .filter(({ text }) => text)
    .map(({ color, text }) => paint(theme, color, text))

interface PanelGroup {
  name: string
  rows: string[]
  required: boolean
  dropRank: number
}

export interface RenderSidebarLinesOptions {
  state: SidebarState
  theme: SidebarTheme
  width: number
  height: number
  path: Path
  now?: number
}

export const renderSidebarLines = ({
  state,
  theme,
  width,
  height,
  path,
  now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
}: RenderSidebarLinesOptions) => {
  const safeWidth = Math.max(0, Math.trunc(width))
  const safeHeight = Math.max(0, Math.trunc(height))
  if (safeWidth === 0 || safeHeight === 0) {
    return []
  }
  const panelWidth = Math.max(0, safeWidth - 2)
  const rowWidth = Math.max(0, panelWidth - 4)
  const currentAgents = state.agents?.filter((agent) => state.sessionId === undefined || agent.sessionId === state.sessionId) ?? []
  const groups: PanelGroup[] = [
    {
      dropRank: Number.POSITIVE_INFINITY,
      name: 'agent',
      required: true,
      rows: panel({
        color: state.activity === 'working' ? 'orange' : 'green',
        jewel: state.activity === 'working' && Math.floor(now / 400) % 2 === 1 ? '✧' : '✦',
        rows: agentRows(state, rowWidth, theme),
        theme,
        title: 'AGENT',
        width: panelWidth,
      }),
    },
    {
      dropRank: Number.POSITIVE_INFINITY,
      name: 'context',
      required: true,
      rows: panel({
        color: contextColor(state.model.contextPercent),
        rows: contextRows(state, rowWidth, theme),
        theme,
        title: 'CONTEXT',
        width: panelWidth,
      }),
    },
    ...(currentAgents.length > 0
      ? [
          {
            dropRank: 40,
            name: 'subagents',
            required: false,
            rows: panel({
              color: 'purple',
              rows: subagentRows(currentAgents, rowWidth, theme, now),
              theme,
              title: 'SUBAGENTS',
              width: panelWidth,
            }),
          },
        ]
      : []),
    {
      dropRank: 30,
      name: 'workspace',
      required: false,
      rows: panel({
        color: 'purple',
        rows: workspaceRows(state, theme, path),
        theme,
        title: 'WORKSPACE',
        width: panelWidth,
      }),
    },
    ...(Object.keys(state.quotas).length > 0
      ? [
          {
            dropRank: 20,
            name: 'quota',
            required: false,
            rows: panel({
              color: quotaColor(Math.max(...Object.values(state.quotas).map((quota) => quotaPercent(quota.percent)))),
              rows: [state.quotas.anthropic, state.quotas.azure].flatMap((quota) => (quota === undefined ? [] : quotaRows(quota, rowWidth, theme))),
              theme,
              title: 'QUOTA',
              width: panelWidth,
            }),
          },
        ]
      : []),
  ]
  const mcp = statusRows(
    state.extensionStatuses.filter((status) => status.key === 'mcp').map((status) => ({ ...status, text: status.text.replace(/^MCP\s+/, '') })),
    theme
  )
  if (mcp.length > 0) {
    groups.push({
      dropRank: 15,
      name: 'mcp',
      required: false,
      rows: panel({ color: 'blue', rows: mcp, theme, title: 'MCP', width: panelWidth }),
    })
  }
  const statuses = statusRows(
    state.extensionStatuses.filter((status) => status.key !== 'mcp'),
    theme
  )
  if (statuses.length > 0) {
    groups.push({
      dropRank: 10,
      name: 'statuses',
      required: false,
      rows: panel({ color: 'gray', rows: statuses, theme, title: 'STATUS', width: panelWidth }),
    })
  }

  let visible = groups
  while (visible.flatMap((group) => group.rows).length > safeHeight) {
    const droppableGroups = visible
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => !group.required)
      .toSorted((left, right) => left.group.dropRank - right.group.dropRank)
    if (droppableGroups.length === 0) {
      break
    }
    const [droppable] = droppableGroups
    visible = visible.filter((_group, index) => index !== droppable.index)
  }
  const contentRows = visible.flatMap((group) => group.rows).slice(0, safeHeight)
  return Array.from({ length: safeHeight }, (_value, index) =>
    gutterRow(truncateToWidth(contentRows[index] ?? '', panelWidth, ''), safeWidth, panelWidth)
  )
}

export interface SidebarController {
  show: () => void
  hide: () => void
  isVisible: () => boolean
  requestRender: () => void
  dispose: () => void
}

interface SidebarControllerOptions {
  ctx: ExtensionContext
  getState: () => SidebarState
  path: Path
  onError?: (error: unknown) => void
}

export const createSidebarController = (options: SidebarControllerOptions): SidebarController => {
  let enabled = false
  let disposed = false
  let generation = 0
  let overlayHandle: OverlayHandle | undefined
  let requestOverlayRender: (() => void) | undefined
  const split: SplitPaneController = createSplitPaneController({ onError: options.onError })

  const hide = () => {
    if (!enabled && overlayHandle === undefined) {
      return
    }
    enabled = false
    generation += 1
    const handle = overlayHandle
    overlayHandle = undefined
    requestOverlayRender = undefined
    handle?.hide()
    split.hide()
  }

  const show = () => {
    if (disposed || enabled || options.ctx.mode !== 'tui') {
      return
    }
    enabled = true
    generation += 1
    const currentGeneration = generation
    const isCurrent = () => generation === currentGeneration
    split.show()
    try {
      const pending = options.ctx.ui.custom<void>(
        (tui, theme) => {
          const component = {
            invalidate() {
              /* Empty */
            },
            render: (sidebarWidth: number) =>
              renderSidebarLines({
                height: tui.terminal.rows,
                path: options.path,
                state: options.getState(),
                theme,
                width: sidebarWidth,
              }),
          } satisfies Component
          if (enabled && isCurrent()) {
            try {
              split.attach(tui, component)
              requestOverlayRender = () => tui.requestRender()
            } catch (error) {
              options.onError?.(error)
              enabled = false
              split.hide()
            }
          }
          return component
        },
        {
          onHandle: (handle) => {
            if (enabled && isCurrent()) {
              overlayHandle = handle
            } else {
              handle.hide()
            }
          },
          overlay: true,
          overlayOptions: () => split.overlayOptions(),
        }
      )
      void pending
        .catch((error: unknown) => options.onError?.(error))
        .finally(() => {
          if (!isCurrent()) {
            return
          }
          enabled = false
          overlayHandle = undefined
          requestOverlayRender = undefined
          split.hide()
        })
    } catch (error) {
      enabled = false
      split.hide()
      options.onError?.(error)
    }
  }

  return {
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      hide()
      split.dispose()
    },
    hide,
    isVisible: () => enabled,
    requestRender() {
      if (requestOverlayRender === undefined) {
        split.requestRender()
      } else {
        requestOverlayRender()
      }
    },
    show,
  }
}
