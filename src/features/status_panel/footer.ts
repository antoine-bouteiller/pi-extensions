import { type ThemeColor } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { type Path } from 'effect/Path'

import { formatDirectory, progressBar } from './render.js'
import { type GitInfoState, type ModelInfoState, type ProviderQuotas } from './state.js'

export interface FooterTheme {
  fg: (color: ThemeColor, text: string) => string
}

export interface FooterState {
  cwd: string
  model: ModelInfoState
  git: GitInfoState
  quotas: ProviderQuotas
}

export const renderFooterLines = (state: FooterState, theme: FooterTheme, width: number, path: Path): string[] => {
  const { model, git, quotas } = state
  const summary = (barWidth: number): string => {
    const gauge = (label: string, percent: number) => `${label} ${barWidth > 0 ? `${progressBar(percent, barWidth)} ` : ''}${Math.round(percent)}%`
    const segments = [theme.fg('text', gauge('Ctx', model.contextPercent ?? 0))]
    for (const quota of [quotas.anthropic, quotas.azure]) {
      if (quota === undefined) {
        continue
      }
      const windows = quota.windows ?? [{ label: quota.label === 'anthropic' ? 'Session' : 'Azure', percent: quota.percent }]
      for (const window of windows) {
        let { label } = window
        if (label === 'Session') {
          label = '5h'
        } else if (label === 'Weekly') {
          label = '7d'
        }
        const reset = window.label === 'Session' && window.resetsIn !== undefined ? ` ${window.resetsIn}` : ''
        segments.push(theme.fg(window.label === 'Weekly' ? 'thinkingHigh' : 'muted', `${gauge(label, window.percent)}${reset}`))
      }
    }
    segments.push(theme.fg('accent', `${model.modelId} · ${model.thinking}`))
    return segments.join(theme.fg('dim', ' | '))
  }
  const full = summary(4)
  const fileLabel = git.changedFiles === 1 ? 'file' : 'files'
  const location = git.branch === undefined ? formatDirectory(state.cwd, path) : `${git.branch} · ${git.changedFiles} ${fileLabel} changed`
  const details = [
    model.tokensPerSecond === undefined ? undefined : `${Math.round(model.tokensPerSecond)} tok/s`,
    model.cacheHitPercent === undefined ? undefined : `Cache hit ${model.cacheHitPercent.toFixed(1)}%`,
    location,
  ]
    .filter(Boolean)
    .join(' · ')
  return [truncateToWidth(visibleWidth(full) <= width ? full : summary(0), width), truncateToWidth(theme.fg('muted', details), width)]
}
