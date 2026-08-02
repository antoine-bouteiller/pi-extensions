import { type ReadonlyFooterDataProvider, type ThemeColor } from '@earendil-works/pi-coding-agent'

import { formatStatusText, statusBar, type StatusEntry, type StatusTone } from '../shared/status_bar'

export const STATUS_TONE_COLORS: Record<StatusTone, ThemeColor> = {
  error: 'error',
  info: 'text',
  muted: 'muted',
  success: 'success',
  warning: 'warning',
}

/**
 * Merges statuses published through the shared channel with those any other extension
 * registered directly with pi. Keys owned by the shared channel are skipped because it
 * mirrors its plain text into pi's registry, which would otherwise render them twice.
 */
export const collectStatuses = (footerData: ReadonlyFooterDataProvider | undefined): readonly StatusEntry[] => {
  const external = [...(footerData?.getExtensionStatuses().entries() ?? [])]
    .filter(([key]) => !statusBar.has(key))
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, text]) => text.split('\n').map((line): StatusEntry => ({ key, text: line, tone: 'muted' })))
  return [...statusBar.list(), ...external]
}

export const statusLines = (entries: readonly StatusEntry[]): readonly string[] => entries.map(formatStatusText).filter(Boolean)
