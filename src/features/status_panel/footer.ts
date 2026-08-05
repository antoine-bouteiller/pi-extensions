import { type ThemeColor } from '@earendil-works/pi-coding-agent'
import { truncateToWidth } from '@earendil-works/pi-tui'
import { Function } from 'effect'

import { formatStatusText, type StatusEntry } from '@/shared/state/status_bar.js'

import { columns, formatDirectory, formatTokens, progressBar, progressLine } from './render.js'
import { type GitInfoState, type ModelInfoState, type ProviderQuotas } from './state.js'
import { STATUS_TONE_COLORS } from './statuses.js'

export interface FooterTheme {
  fg: (color: ThemeColor, text: string) => string
}

export interface FooterState {
  cwd: string
  model: ModelInfoState
  git: GitInfoState
  quotas: ProviderQuotas
  statuses: readonly StatusEntry[]
}

export const renderFooterLines: {
  (theme: FooterTheme, width: number): (state: FooterState) => string[]
  (state: FooterState, theme: FooterTheme, width: number): string[]
} = Function.dual(3, (state: FooterState, theme: FooterTheme, width: number): string[] => {
  const { model, git, quotas } = state
  const percent = model.contextPercent ?? 0
  const tokens = formatTokens(model.contextTokens ?? 0)
  const window = model.contextWindow > 0 ? formatTokens(model.contextWindow) : '?'
  const muted = (text: string) => truncateToWidth(theme.fg('muted', text), width)
  const lines = [
    columns(theme.fg('text', formatDirectory(state.cwd)), theme.fg('muted', `${model.modelId} · ${model.thinking}`), width),
    muted(`Context: ${progressBar(percent, 8)} ${tokens}/${window} (${Math.round(percent)}%)`),
  ]

  if (git.branch !== undefined) {
    const fileLabel = git.changedFiles === 1 ? 'file' : 'files'
    lines.push(muted(`${git.branch} · ${git.changedFiles} ${fileLabel} changed`))
  }

  for (const quota of [quotas.anthropic, quotas.azure]) {
    if (quota !== undefined) {
      lines.push(
        muted(
          progressLine({
            detail: quota.detail ?? '',
            label: quota.label === 'anthropic' ? 'Session' : 'Azure',
            percent: quota.percent,
            width: 8,
          })
        )
      )
    }
  }

  for (const status of state.statuses) {
    lines.push(truncateToWidth(theme.fg(STATUS_TONE_COLORS[status.tone ?? 'muted'], formatStatusText(status)), width))
  }
  return lines
})
