import { basename } from 'node:path'

import { type ExtensionContext, type ThemeColor } from '@earendil-works/pi-coding-agent'
import { getCapabilities, truncateToWidth, visibleWidth, type Component, type OverlayHandle } from '@earendil-works/pi-tui'

import { type RunningAgent } from '../shared/agent_activity'
import { formatStatusText, type StatusEntry, type StatusTone } from '../shared/status_bar'
import { formatDirectory, formatTokens } from './render'
import { createSplitPaneController, type SplitPaneController } from './split_pane'
import { type GitInfoState, type ModelInfoState, type ProviderQuota, type QuotaWindow } from './state'

export interface SidebarTheme {
  fg: (color: ThemeColor, text: string) => string
  bold?: (text: string) => string
}

export interface SidebarState {
  activity: 'ready' | 'working'
  cwd: string
  model: ModelInfoState
  git: GitInfoState
  quota: ProviderQuota | undefined
  agents: readonly RunningAgent[]
  extensionStatuses: readonly StatusEntry[]
}

const MAX_AGENT_ROWS = 5

type PaletteRole = 'accent' | 'primary' | 'muted' | 'dim' | 'ready' | 'working' | 'context' | 'warning' | 'error'
type Rgb = readonly [number, number, number]

const COLORS: Record<PaletteRole, Rgb> = {
  accent: [177, 140, 255],
  context: [110, 168, 254],
  dim: [102, 102, 102],
  error: [255, 93, 115],
  muted: [128, 128, 128],
  primary: [212, 212, 212],
  ready: [110, 168, 254],
  warning: [255, 159, 67],
  working: [255, 159, 67],
}

const THEME_ROLES: Record<PaletteRole, ThemeColor> = {
  accent: 'accent',
  context: 'thinkingLow',
  dim: 'dim',
  error: 'error',
  muted: 'muted',
  primary: 'text',
  ready: 'success',
  warning: 'warning',
  working: 'warning',
}

const paint = (theme: SidebarTheme, role: PaletteRole, text: string) => {
  if (process.env.NO_COLOR !== undefined || !getCapabilities().trueColor) {
    return theme.fg(THEME_ROLES[role], text)
  }
  const [red, green, blue] = COLORS[role]
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`
}

const bold = (theme: SidebarTheme, text: string) => theme.bold?.(text) ?? text

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

const sanitize = (text: string) =>
  [...text.replace(ANSI_PATTERN, '')]
    .map((character) => {
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
  if (!right) {
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
  role: PaletteRole
  jewel?: string
}

const panel = ({ title, rows, width, theme, role, jewel = '✦' }: PanelOptions) => {
  if (width <= 0) {
    return []
  }
  const innerWidth = Math.max(0, width - 4)
  const safeTitle = sanitize(title).toUpperCase()
  const prefix = `╭─ ${jewel} `
  const fill = '─'.repeat(Math.max(0, width - visibleWidth(prefix) - visibleWidth(safeTitle) - 2))
  const top = truncateToWidth(
    `${paint(theme, role, prefix)}${bold(theme, paint(theme, role, safeTitle))} ${paint(theme, role, `${fill}╮`)}`,
    width,
    ''
  )
  const body = rows.map((row) => truncateToWidth(`${paint(theme, 'dim', '│')} ${pad(row, innerWidth)} ${paint(theme, 'dim', '│')}`, width, ''))
  const bottom = paint(theme, 'dim', `╰${'─'.repeat(Math.max(0, width - 2))}╯`)
  return [top, ...body, truncateToWidth(bottom, width, ''), '']
}

const contextRole = (percent: number | undefined): PaletteRole => {
  if (percent === undefined || !Number.isFinite(percent)) {
    return 'dim'
  }
  if (percent >= 90) {
    return 'error'
  }
  if (percent >= 70) {
    return 'warning'
  }
  return 'context'
}

const agentRows = (state: SidebarState, width: number, theme: SidebarTheme) => {
  const working = state.activity === 'working'
  const status = bold(theme, paint(theme, working ? 'working' : 'ready', `${working ? '◆ Working' : '● Ready'}`))
  const model = paint(theme, 'primary', sanitize(state.model.modelId) || 'no model')
  const metadata = [state.model.provider, state.model.thinking]
    .map((value) => sanitize(value).toUpperCase())
    .filter(Boolean)
    .join(` ${paint(theme, 'dim', '·')} `)
  return [spaced(status, model, width), metadata ? paint(theme, 'muted', metadata) : paint(theme, 'dim', '—')]
}

const contextRows = (state: SidebarState, width: number, theme: SidebarTheme) => {
  const { contextPercent, contextTokens, contextWindow } = state.model
  if (contextPercent === undefined || contextTokens === undefined) {
    return [paint(theme, 'dim', 'Context unavailable')]
  }
  const role = contextRole(contextPercent)
  const usage = `${formatTokens(contextTokens)} / ${contextWindow > 0 ? formatTokens(contextWindow) : '—'}`
  const percent = `${contextPercent.toFixed(1)}%`
  const meterWidth = Math.max(1, Math.min(16, width - 2))
  const filled = Math.max(0, Math.min(meterWidth, Math.round((contextPercent / 100) * meterWidth)))
  const meter = `${paint(theme, 'dim', '[')}${paint(theme, role, '■'.repeat(filled))}${paint(
    theme,
    'dim',
    '·'.repeat(meterWidth - filled)
  )}${paint(theme, 'dim', ']')}`
  return [spaced(paint(theme, role, usage), paint(theme, role, percent), width), meter]
}

const subagentRow = (agent: RunningAgent, width: number, theme: SidebarTheme) => {
  const marker = '▸ '
  const profile = truncateToWidth(sanitize(agent.profile ?? ''), Math.floor(width * 0.4), '…')
  const nameWidth = width - visibleWidth(marker) - (profile ? visibleWidth(profile) + 1 : 0)
  const name = truncateToWidth(sanitize(agent.name), Math.max(0, nameWidth), '…')
  const gap = ' '.repeat(Math.max(profile ? 1 : 0, width - visibleWidth(marker) - visibleWidth(name) - visibleWidth(profile)))
  return truncateToWidth(`${paint(theme, 'dim', marker)}${theme.fg(agent.color, name)}${gap}${paint(theme, 'muted', profile)}`, width, '')
}

const subagentRows = (agents: readonly RunningAgent[], width: number, theme: SidebarTheme) => {
  const shown = agents.slice(0, MAX_AGENT_ROWS)
  const rows = shown.map((agent) => subagentRow(agent, width, theme))
  if (agents.length > shown.length) {
    rows.push(paint(theme, 'dim', `+${agents.length - shown.length} more`))
  }
  return rows
}

const workspaceRows = (state: SidebarState, theme: SidebarTheme) => {
  const project = basename(state.cwd) || formatDirectory(state.cwd)
  const rows = [paint(theme, 'primary', sanitize(project)), paint(theme, 'muted', formatDirectory(state.cwd))]
  if (state.git.branch) {
    const fileLabel = state.git.changedFiles === 1 ? 'file' : 'files'
    const change = state.git.changedFiles > 0 ? `${state.git.changedFiles} ${fileLabel} changed` : 'clean'
    rows.push(
      `${paint(theme, 'accent', sanitize(state.git.branch))} ${paint(theme, 'dim', '·')} ${paint(
        theme,
        state.git.changedFiles > 0 ? 'warning' : 'ready',
        change
      )}`
    )
  } else {
    rows.push(paint(theme, 'dim', 'not a Git repository'))
  }
  if (state.git.pullRequest) {
    rows.push(paint(theme, 'accent', `PR #${state.git.pullRequest.number}`))
  }
  return rows
}

const quotaPercent = (percent: number) => (Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0)

const quotaRole = (percent: number): PaletteRole => {
  if (percent >= 90) {
    return 'error'
  }
  if (percent >= 70) {
    return 'warning'
  }
  return 'context'
}

const quotaWindowRows = (window: QuotaWindow, width: number, theme: SidebarTheme) => {
  const percent = quotaPercent(window.percent)
  const role = quotaRole(percent)
  const resetsIn = sanitize(window.resetsIn ?? '')
  const meterWidth = Math.max(1, Math.min(12, width - (resetsIn ? visibleWidth(resetsIn) + 1 : 0)))
  const filled = Math.max(0, Math.min(meterWidth, Math.round((percent / 100) * meterWidth)))
  const meter = `${paint(theme, role, '■'.repeat(filled))}${paint(theme, 'dim', '·'.repeat(meterWidth - filled))}`
  const header = spaced(paint(theme, role, sanitize(window.label)), paint(theme, role, `${percent.toFixed(1)}%`), width)
  if (!resetsIn) {
    return [header, meter]
  }
  const gap = ' '.repeat(Math.max(1, width - meterWidth - visibleWidth(resetsIn)))
  return [header, truncateToWidth(`${meter}${gap}${paint(theme, 'muted', resetsIn)}`, width, '')]
}

const quotaRows = (quota: ProviderQuota, width: number, theme: SidebarTheme) => {
  const windows: readonly QuotaWindow[] = quota.windows?.length
    ? quota.windows
    : [{ label: quota.label === 'anthropic' ? 'Session' : 'Azure', percent: quota.percent }]
  const rows = windows.flatMap((window) => quotaWindowRows(window, width, theme))
  if (!quota.windows?.length && quota.detail) {
    rows.push(paint(theme, 'muted', sanitize(quota.detail)))
  }
  return rows
}

const STATUS_TONE_ROLES: Record<StatusTone, PaletteRole> = {
  error: 'error',
  info: 'context',
  muted: 'muted',
  success: 'ready',
  warning: 'warning',
}

const statusRows = (statuses: readonly StatusEntry[], theme: SidebarTheme) =>
  statuses
    .map((status) => ({ role: STATUS_TONE_ROLES[status.tone ?? 'muted'], text: sanitize(formatStatusText(status)) }))
    .filter(({ text }) => text)
    .map(({ role, text }) => paint(theme, role, text))

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
  now?: number
}

export const renderSidebarLines = ({ state, theme, width, height, now = Date.now() }: RenderSidebarLinesOptions) => {
  const safeWidth = Math.max(0, Math.trunc(width))
  const safeHeight = Math.max(0, Math.trunc(height))
  if (safeWidth === 0 || safeHeight === 0) {
    return []
  }
  const panelWidth = Math.max(0, safeWidth - 2)
  const rowWidth = Math.max(0, panelWidth - 4)
  const groups: PanelGroup[] = [
    {
      dropRank: Number.POSITIVE_INFINITY,
      name: 'agent',
      required: true,
      rows: panel({
        jewel: state.activity === 'working' && Math.floor(now / 400) % 2 ? '✧' : '✦',
        role: state.activity === 'working' ? 'working' : 'ready',
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
        role: contextRole(state.model.contextPercent),
        rows: contextRows(state, rowWidth, theme),
        theme,
        title: 'CONTEXT',
        width: panelWidth,
      }),
    },
    ...(state.agents.length > 0
      ? [
          {
            dropRank: 40,
            name: 'subagents',
            required: false,
            rows: panel({
              role: 'accent',
              rows: subagentRows(state.agents, rowWidth, theme),
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
        role: 'accent',
        rows: workspaceRows(state, theme),
        theme,
        title: 'WORKSPACE',
        width: panelWidth,
      }),
    },
    ...(state.quota
      ? [
          {
            dropRank: 20,
            name: 'quota',
            required: false,
            rows: panel({
              role: quotaRole(quotaPercent(state.quota.percent)),
              rows: quotaRows(state.quota, rowWidth, theme),
              theme,
              title: 'QUOTA',
              width: panelWidth,
            }),
          },
        ]
      : []),
  ]
  const statuses = statusRows(state.extensionStatuses, theme)
  if (statuses.length > 0) {
    groups.push({
      dropRank: 10,
      name: 'statuses',
      required: false,
      rows: panel({ role: 'muted', rows: statuses, theme, title: 'STATUS', width: panelWidth }),
    })
  }

  let visible = groups
  while (visible.flatMap((group) => group.rows).length > safeHeight) {
    const [droppable] = visible
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => !group.required)
      .toSorted((left, right) => left.group.dropRank - right.group.dropRank)
    if (!droppable) {
      break
    }
    visible = visible.filter((_group, index) => index !== droppable.index)
  }
  const contentRows = visible.flatMap((group) => group.rows).slice(0, safeHeight)
  const divider = paint(theme, 'dim', '│')
  return Array.from({ length: safeHeight }, (_value, index) => {
    const content = truncateToWidth(contentRows[index] ?? '', panelWidth, '')
    return truncateToWidth(`${divider} ${pad(content, panelWidth)}`, safeWidth, '')
  })
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
  onError?: (error: unknown) => void
}

export const createSidebarController = (options: SidebarControllerOptions): SidebarController => {
  let enabled = false
  let disposed = false
  let generation = 0
  let overlayHandle: OverlayHandle | undefined
  let requestOverlayRender: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const split: SplitPaneController = createSplitPaneController({ onError: options.onError })

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer)
    }
    timer = undefined
  }

  const startTimer = () => {
    if (timer || options.getState().activity !== 'working') {
      return
    }
    timer = setInterval(() => requestOverlayRender?.(), 400)
    timer.unref?.()
  }

  const hide = () => {
    if (!enabled && !overlayHandle) {
      return
    }
    enabled = false
    generation += 1
    stopTimer()
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
    const currentGeneration = ++generation
    split.show()
    try {
      const pending = options.ctx.ui.custom<void>(
        (tui, theme) => {
          let attached = true
          try {
            split.attach(tui)
          } catch (error) {
            attached = false
            options.onError?.(error)
            enabled = false
            split.hide()
          }
          if (attached && enabled && generation === currentGeneration) {
            requestOverlayRender = () => tui.requestRender()
            startTimer()
          }
          return {
            invalidate() {
              /* Empty */
            },
            render: (sidebarWidth: number) =>
              renderSidebarLines({
                height: tui.terminal.rows,
                state: options.getState(),
                theme,
                width: sidebarWidth,
              }),
          } satisfies Component
        },
        {
          onHandle: (handle) => {
            if (enabled && generation === currentGeneration) {
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
          if (generation !== currentGeneration) {
            return
          }
          enabled = false
          stopTimer()
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
      if (requestOverlayRender) {
        requestOverlayRender()
      } else {
        split.requestRender()
      }
      if (options.getState().activity === 'working') {
        startTimer()
      } else {
        stopTimer()
      }
    },
    show,
  }
}
