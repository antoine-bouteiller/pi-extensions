import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { isEmptyString } from '#shared/utils/predicates'

export const formatTokens = (tokens: number) => {
  if (tokens < 1000) {
    return `${tokens}`
  }
  if (tokens < 1_000_000) {
    return `${Math.round(tokens / 1000)}k`
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`
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
