import { homedir } from 'node:os'

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { type Path } from 'effect/Path'

import { isEmptyString } from '@/shared/utils/predicates.js'

export const formatTokens = (tokens: number) => {
  if (tokens < 1000) {
    return `${tokens}`
  }
  if (tokens < 1_000_000) {
    return `${Math.round(tokens / 1000)}k`
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

export const progressBar = (percent: number, width: number): string => {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width)
  return `${'▓'.repeat(filled)}${'░'.repeat(width - filled)}`
}

export interface ProgressLineOptions {
  label: string
  percent: number
  detail: string
  width?: number
}

export const progressLine = ({ label, percent, detail, width = 10 }: ProgressLineOptions) =>
  `${label}: ${progressBar(percent, width)} ${percent.toFixed(1)}%${isEmptyString(detail) ? '' : `  ${detail}`}`

export const formatDirectory = (cwd: string, path: Path): string => {
  const home = homedir()
  if (cwd === home) {
    return '~'
  }
  if (cwd.startsWith(`${home}/`)) {
    return `~/${path.relative(home, cwd)}`
  }
  return cwd
}

export const columns = (left: string, right: string, width: number): string => {
  if (isEmptyString(right)) {
    return truncateToWidth(left, width)
  }
  const naturalGap = width - visibleWidth(left) - visibleWidth(right)
  if (naturalGap >= 1) {
    return `${left}${' '.repeat(naturalGap)}${right}`
  }
  const leftWidth = Math.max(1, Math.floor(width * 0.45))
  const fittedLeft = truncateToWidth(left, leftWidth)
  const fittedRight = truncateToWidth(right, Math.max(1, width - leftWidth - 1))
  const gap = Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight))
  return truncateToWidth(`${fittedLeft}${' '.repeat(gap)}${fittedRight}`, width)
}
