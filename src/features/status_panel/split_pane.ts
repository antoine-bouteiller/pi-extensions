import { type OverlayOptions, type TUI } from '@earendil-works/pi-tui'

export const DEFAULT_SIDEBAR_WIDTH = 44
export const MIN_SIDEBAR_WIDTH = 28
const MAX_SIDEBAR_WIDTH = 72
export const MIN_MAIN_WIDTH = 64

type RenderFunction = TUI['render']

export interface SplitPaneController {
  attach: (tui: TUI) => void
  show: () => void
  hide: () => void
  isEnabled: () => boolean
  overlayOptions: () => OverlayOptions
  requestRender: () => void
  dispose: () => void
}

interface SplitPaneOptions {
  sidebarWidth?: number
  minSidebarWidth?: number
  minMainWidth?: number
  onError?: (error: unknown) => void
}

const finiteInteger = (value: number, fallback: number) => (Number.isFinite(value) ? Math.trunc(value) : fallback)

export const createSplitPaneController = (options: SplitPaneOptions = {}): SplitPaneController => {
  const minSidebarWidth = Math.max(1, finiteInteger(options.minSidebarWidth ?? MIN_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH))
  const sidebarWidth = Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.max(minSidebarWidth, finiteInteger(options.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH))
  )
  const minMainWidth = Math.max(1, finiteInteger(options.minMainWidth ?? MIN_MAIN_WIDTH, MIN_MAIN_WIDTH))
  let tui: TUI | undefined
  let originalRender: RenderFunction | undefined
  let wrappedRender: RenderFunction | undefined
  let enabled = false
  let disposed = false

  const isVisible = (terminalWidth: number) => enabled && Number.isFinite(terminalWidth) && terminalWidth >= minMainWidth + minSidebarWidth
  const effectiveWidth = (terminalWidth: number) => (isVisible(terminalWidth) ? Math.min(sidebarWidth, terminalWidth - minMainWidth) : 0)
  const overlayLayout: OverlayOptions = {
    anchor: 'top-right',
    margin: 0,
    maxHeight: '100%',
    nonCapturing: true,
    visible: (terminalWidth) => isVisible(terminalWidth),
    width: sidebarWidth,
  }

  const syncOverlayWidth = (terminalWidth = tui?.terminal.columns) => {
    const width = terminalWidth === undefined ? 0 : effectiveWidth(terminalWidth)
    overlayLayout.width = width > 0 ? width : sidebarWidth
  }

  const requestRender = () => {
    tui?.requestRender()
  }

  return {
    attach(nextTui) {
      if (disposed) {
        throw new Error('Cannot attach a disposed status panel')
      }
      if (tui === nextTui) {
        return
      }
      if (tui !== undefined) {
        throw new Error('Status panel is already attached to another TUI')
      }
      tui = nextTui
      // oxlint-disable-next-line typescript/unbound-method -- deliberate render swizzle: the original is kept to restore on dispose and is only ever invoked with an explicit receiver.
      const previousRender = nextTui.render
      originalRender = previousRender
      wrappedRender = function (this: TUI, terminalWidth: number): string[] {
        const reservedWidth = effectiveWidth(terminalWidth)
        syncOverlayWidth(terminalWidth)
        try {
          return previousRender.call(nextTui, terminalWidth - reservedWidth)
        } catch (error) {
          options.onError?.(error)
          return previousRender.call(nextTui, terminalWidth)
        }
      }
      nextTui.render = wrappedRender
      requestRender()
    },
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      enabled = false
      if (tui !== undefined && originalRender !== undefined && tui.render === wrappedRender) {
        tui.render = originalRender
      }
      requestRender()
      tui = undefined
      originalRender = undefined
      wrappedRender = undefined
    },
    hide() {
      if (!enabled) {
        return
      }
      enabled = false
      requestRender()
    },
    isEnabled: () => enabled,
    overlayOptions: () => overlayLayout,
    requestRender,
    show() {
      if (disposed || enabled) {
        return
      }
      enabled = true
      syncOverlayWidth()
      requestRender()
    },
  }
}
