import { type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Function } from 'effect'

import { createKeyedStore } from './store.js'

export type StatusTone = 'muted' | 'info' | 'success' | 'warning' | 'error'

export interface StatusItem {
  text: string
  tone?: StatusTone
  icon?: string
  /** Lower sorts first in the status bar; equal priorities fall back to key order. */
  priority?: number
}

export interface StatusEntry extends StatusItem {
  key: string
}

const DEFAULT_PRIORITY = 100

const statuses = createKeyedStore<StatusItem>()

export const statusBar = {
  has: (key: string) => statuses.has(key),
  list: (): readonly StatusEntry[] =>
    statuses
      .entries()
      .map(([key, item]) => ({ ...item, key }))
      .toSorted((left, right) => (left.priority ?? DEFAULT_PRIORITY) - (right.priority ?? DEFAULT_PRIORITY) || left.key.localeCompare(right.key)),
  subscribe: statuses.subscribe,
}

export const formatStatusText = (item: StatusItem): string => (item.icon === undefined ? item.text : `${item.icon} ${item.text}`)

/** Store-only write, for callers that mirror into Pi's registry themselves. */
export const publishStatus: {
  (item: StatusItem | undefined): (key: string) => void
  (key: string, item: StatusItem | undefined): void
} = Function.dual(2, (key: string, item: StatusItem | undefined): void => {
  statuses.publish(key, item)
})

export interface StatusChannel {
  set: (ctx: ExtensionContext, item: StatusItem) => void
  clear: (ctx: ExtensionContext) => void
}

/**
 * Gives a feature one named slot in the status bar. The feature supplies text and a
 * semantic tone; the status panel owns every rendering decision (colour, order, width).
 * Plain text is mirrored into pi's own status registry so the stock footer still shows
 * the entry when the status panel is not installed.
 */
export const createStatusChannel: {
  (defaults?: Partial<StatusItem>): (key: string) => StatusChannel
  (key: string, defaults?: Partial<StatusItem>): StatusChannel
} = Function.dual(
  (args) => typeof args[0] === 'string',
  (key: string, defaults: Partial<StatusItem> = {}): StatusChannel => ({
    clear(ctx) {
      statuses.publish(key, undefined)
      if (ctx.hasUI) {
        ctx.ui.setStatus(key, undefined)
      }
    },
    set(ctx, item) {
      const entry = { ...defaults, ...item }
      statuses.publish(key, entry)
      if (ctx.hasUI) {
        ctx.ui.setStatus(key, formatStatusText(entry))
      }
    },
  })
)
