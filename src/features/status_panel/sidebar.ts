import { basename } from 'node:path'

import { type ExtensionContext, type ThemeColor } from '@earendil-works/pi-coding-agent'
import { getCapabilities, truncateToWidth, visibleWidth, type Component, type OverlayHandle } from '@earendil-works/pi-tui'
import { Effect, Exit, Ref, Scope } from 'effect'

import { type RunningAgent } from '@/shared/state/agent_activity.js'
import { formatStatusText, type StatusEntry, type StatusTone } from '@/shared/state/status_bar.js'
import { isEmptyString, isNotEmptyString } from '@/shared/utils/predicates.js'

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
  agents: readonly RunningAgent[]
  extensionStatuses: readonly StatusEntry[]
}

const MAX_AGENT_ROWS = 5

type PaletteColor = 'purple' | 'blue' | 'green' | 'red' | 'orange' | 'gray' | 'white'
type Rgb = readonly [number, number, number]

const COLORS: Record<PaletteColor, Rgb> = {
  blue: [110, 168, 254],
  gray: [128, 128, 128],
  green: [95, 211, 148],
  orange: [255, 159, 67],
  purple: [177, 140, 255],
  red: [255, 93, 115],
  white: [212, 212, 212],
}

const THEME_FALLBACKS: Record<PaletteColor, ThemeColor> = {
  blue: 'thinkingLow',
  gray: 'muted',
  green: 'success',
  orange: 'warning',
  purple: 'accent',
  red: 'error',
  white: 'text',
}

const paint = (theme: SidebarTheme, color: PaletteColor, text: string) => {
  if (process.env.NO_COLOR !== undefined) {
    return text
  }
  if (!getCapabilities().trueColor) {
    return theme.fg(THEME_FALLBACKS[color], text)
  }
  const [red, green, blue] = COLORS[color]
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`
}

const bold = (theme: SidebarTheme, text: string) => theme.bold?.(text) ?? text

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

const subagentRow = (agent: RunningAgent, width: number, theme: SidebarTheme) => {
  const marker = '▸ '
  const profile = truncateToWidth(sanitize(agent.profile ?? ''), Math.floor(width * 0.4), '…')
  const nameWidth = width - visibleWidth(marker) - (isEmptyString(profile) ? 0 : visibleWidth(profile) + 1)
  const name = truncateToWidth(sanitize(agent.name), Math.max(0, nameWidth), '…')
  const gap = ' '.repeat(Math.max(isEmptyString(profile) ? 0 : 1, width - visibleWidth(marker) - visibleWidth(name) - visibleWidth(profile)))
  const coloredName = process.env.NO_COLOR === undefined ? theme.fg(agent.color, name) : name
  return truncateToWidth(`${paint(theme, 'gray', marker)}${coloredName}${gap}${paint(theme, 'gray', profile)}`, width, '')
}

const subagentRows = (agents: readonly RunningAgent[], width: number, theme: SidebarTheme) => {
  const shown = agents.slice(0, MAX_AGENT_ROWS)
  const rows = shown.map((agent) => subagentRow(agent, width, theme))
  if (agents.length > shown.length) {
    rows.push(paint(theme, 'gray', `+${agents.length - shown.length} more`))
  }
  return rows
}

const workspaceRows = (state: SidebarState, theme: SidebarTheme) => {
  const project = basename(state.cwd) || formatDirectory(state.cwd)
  const rows = [paint(theme, 'white', sanitize(project)), paint(theme, 'gray', formatDirectory(state.cwd))]
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

const STATUS_TONE_COLORS: Record<StatusTone, PaletteColor> = {
  error: 'red',
  info: 'blue',
  muted: 'gray',
  success: 'green',
  warning: 'orange',
}

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
    ...(state.agents.length > 0
      ? [
          {
            dropRank: 40,
            name: 'subagents',
            required: false,
            rows: panel({
              color: 'purple',
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
        color: 'purple',
        rows: workspaceRows(state, theme),
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
  const divider = paint(theme, 'gray', '│')
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
  redrawMs?: number
}

const getRef = <Value>(ref: Ref.Ref<Value>): Value => Effect.runSync(Ref.get(ref))
const setRef = <Value>(ref: Ref.Ref<Value>, value: Value): void => Effect.runSync(Ref.set(ref, value))

const unrefSleep = (milliseconds: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), milliseconds)
    timer.unref?.()
    return Effect.sync(() => clearTimeout(timer))
  })

export const createSidebarController = (options: SidebarControllerOptions): SidebarController => {
  const enabledRef = Ref.makeUnsafe(false)
  const disposedRef = Ref.makeUnsafe(false)
  const generationRef = Ref.makeUnsafe(0)
  const overlayHandleRef = Ref.makeUnsafe<OverlayHandle | undefined>(undefined)
  const requestOverlayRenderRef = Ref.makeUnsafe<(() => void) | undefined>(undefined)
  const redrawScopeRef = Ref.makeUnsafe<Scope.Closeable | undefined>(undefined)
  const split: SplitPaneController = createSplitPaneController({ onError: options.onError })

  const stopRedraw = () => {
    const scope = getRef(redrawScopeRef)
    if (scope === undefined) {
      return
    }
    setRef(redrawScopeRef, undefined)
    Effect.runFork(Scope.close(scope, Exit.void))
  }

  const startRedraw = (requestRender: () => void, currentGeneration: number) => {
    if (getRef(redrawScopeRef) !== undefined || options.getState().activity !== 'working') {
      return
    }
    const scope = Scope.makeUnsafe()
    setRef(redrawScopeRef, scope)
    Effect.runFork(
      Effect.forkScoped(
        Effect.gen(function* () {
          while (getRef(enabledRef) && getRef(generationRef) === currentGeneration && options.getState().activity === 'working') {
            yield* unrefSleep(options.redrawMs ?? 400)
            if (getRef(enabledRef) && getRef(generationRef) === currentGeneration && options.getState().activity === 'working') {
              requestRender()
            }
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (getRef(redrawScopeRef) === scope) {
                setRef(redrawScopeRef, undefined)
              }
            })
          )
        )
      ).pipe(Effect.provideService(Scope.Scope, scope))
    )
  }

  const hide = () => {
    if (!getRef(enabledRef) && getRef(overlayHandleRef) === undefined) {
      return
    }
    setRef(enabledRef, false)
    Effect.runSync(Ref.update(generationRef, (value) => value + 1))
    stopRedraw()
    const handle = getRef(overlayHandleRef)
    setRef(overlayHandleRef, undefined)
    setRef(requestOverlayRenderRef, undefined)
    handle?.hide()
    split.hide()
  }

  const show = () => {
    if (getRef(disposedRef) || getRef(enabledRef) || options.ctx.mode !== 'tui') {
      return
    }
    setRef(enabledRef, true)
    const currentGeneration = Effect.runSync(Ref.updateAndGet(generationRef, (value) => value + 1))
    const isCurrent = () => getRef(generationRef) === currentGeneration
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
                state: options.getState(),
                theme,
                width: sidebarWidth,
              }),
          } satisfies Component
          if (getRef(enabledRef) && isCurrent()) {
            try {
              split.attach(tui, component)
              const requestRender = () => tui.requestRender()
              setRef(requestOverlayRenderRef, requestRender)
              startRedraw(requestRender, currentGeneration)
            } catch (error) {
              options.onError?.(error)
              setRef(enabledRef, false)
              stopRedraw()
              split.hide()
            }
          }
          return component
        },
        {
          onHandle: (handle) => {
            if (getRef(enabledRef) && isCurrent()) {
              setRef(overlayHandleRef, handle)
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
          setRef(enabledRef, false)
          stopRedraw()
          setRef(overlayHandleRef, undefined)
          setRef(requestOverlayRenderRef, undefined)
          split.hide()
        })
    } catch (error) {
      setRef(enabledRef, false)
      stopRedraw()
      split.hide()
      options.onError?.(error)
    }
  }

  return {
    dispose() {
      if (getRef(disposedRef)) {
        return
      }
      setRef(disposedRef, true)
      hide()
      split.dispose()
    },
    hide,
    isVisible: () => getRef(enabledRef),
    requestRender() {
      const requestOverlayRender = getRef(requestOverlayRenderRef)
      if (requestOverlayRender === undefined) {
        split.requestRender()
      } else {
        requestOverlayRender()
        if (options.getState().activity === 'working') {
          startRedraw(requestOverlayRender, getRef(generationRef))
        } else {
          stopRedraw()
        }
      }
    },
    show,
  }
}
