import { type ThemeColor } from '@earendil-works/pi-coding-agent'
import { truncateToWidth } from '@earendil-works/pi-tui'

import { formatStatusText, type StatusEntry } from '@/shared/state/status_bar.js'

import { columns, formatDirectory, formatTokens, progressBar, progressLine } from './render.js'
import { type GitInfoState, type ModelInfoState, type ProviderQuota } from './state.js'
import { STATUS_TONE_COLORS } from './statuses.js'

export interface FooterTheme {
  fg: (color: ThemeColor, text: string) => string
}

export interface FooterState {
  cwd: string
  model: ModelInfoState
  git: GitInfoState
  quota: ProviderQuota | undefined
  statuses: readonly StatusEntry[]
}

export const renderFooterLines = (state: FooterState, theme: FooterTheme, width: number): string[] => {
  const { model, git, quota } = state
  const percent = model.contextPercent ?? 0
  const tokens = formatTokens(model.contextTokens ?? 0)
  const window = model.contextWindow > 0 ? formatTokens(model.contextWindow) : '?'
  const muted = (text: string) => truncateToWidth(theme.fg('muted', text), width)
  const lines = [
    columns(theme.fg('text', formatDirectory(state.cwd)), theme.fg('muted', `${model.modelId} · ${model.thinking}`), width),
    muted(`Context: ${progressBar(percent, 8)} ${tokens}/${window} (${Math.round(percent)}%)`),
  ]

  if (git.branch) {
    const fileLabel = git.changedFiles === 1 ? 'file' : 'files'
    lines.push(muted(`${git.branch} · ${git.changedFiles} ${fileLabel} changed`))
  }

  if (quota) {
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

  for (const status of state.statuses) {
    lines.push(truncateToWidth(theme.fg(STATUS_TONE_COLORS[status.tone ?? 'muted'], formatStatusText(status)), width))
  }
  return lines
}
