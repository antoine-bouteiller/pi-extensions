import { stripVTControlCharacters } from 'node:util'

import { type ThemeColor } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { type StatusEntry } from '#shared/state/status_bar'

import { columns, formatTokens } from './render.js'
import { type ModelInfoState } from './state.js'

export interface StatusTheme {
  fg: (color: ThemeColor, text: string) => string
  bold: (text: string) => string
}

const CONTEXT_BAR_WIDTH = 10

const TONE_COLORS = {
  error: 'error',
  info: 'accent',
  muted: 'muted',
  success: 'success',
  warning: 'warning',
} satisfies Record<NonNullable<StatusEntry['tone']>, ThemeColor>

const contextColor = (percent: number): ThemeColor => {
  if (percent >= 90) {
    return 'error'
  }
  if (percent >= 70) {
    return 'warning'
  }
  return 'muted'
}

/**
 * Activity, model and thinking level, embedded in the editor's top border and drawn in its color.
 * `activity` renders Pi's working indicator into whatever width the model leaves; without it the agent is ready.
 */
export const renderStatusLine = (
  model: ModelInfoState,
  theme: StatusTheme,
  width: number,
  color: (text: string) => string,
  activity?: (width: number) => string
): string => {
  const tail = color(` › ${model.modelId} · ${model.thinking}`)
  const head =
    activity === undefined ? theme.bold(color('● Ready')) : color(stripVTControlCharacters(activity(Math.max(1, width - visibleWidth(tail)))))
  return truncateToWidth(`${head}${tail}`, width)
}

/** Context usage on the left; shared status entries, then last-turn cache hit and throughput, on the right. */
export const renderFooterLine = (model: ModelInfoState, statuses: readonly StatusEntry[], theme: StatusTheme, width: number): string => {
  const { cacheHitPercent, contextPercent, contextTokens, contextWindow, tokensPerSecond } = model
  const window = contextWindow > 0 ? formatTokens(contextWindow) : '—'
  const known = contextPercent !== undefined && contextTokens !== undefined
  const color = known ? contextColor(contextPercent) : 'muted'
  const filled = known ? Math.round((Math.max(0, Math.min(100, contextPercent)) / 100) * CONTEXT_BAR_WIDTH) : 0
  const bar = `${theme.fg(color, '■'.repeat(filled))}${theme.fg('dim', '·'.repeat(CONTEXT_BAR_WIDTH - filled))}`
  const values = known ? `${contextPercent.toFixed(1)}% · ${formatTokens(contextTokens)} / ${window}` : `— / ${window}`
  const context = `${theme.fg(color, 'ctx')} ${bar} ${theme.fg(color, values)}`
  const metrics = [
    cacheHitPercent === undefined ? undefined : `cache ${cacheHitPercent.toFixed(0)}%`,
    tokensPerSecond === undefined ? undefined : `${Math.round(tokensPerSecond)} tok/s`,
  ]
    .filter((value) => value !== undefined)
    .join(' · ')
  const right = [
    ...statuses.map((entry) => theme.fg(TONE_COLORS[entry.tone ?? 'muted'], entry.text)),
    ...(metrics === '' ? [] : [theme.fg('muted', metrics)]),
  ].join(' · ')
  return columns(context, right, width)
}
