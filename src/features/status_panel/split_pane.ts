import { HStack, type Component, type OverlayOptions, type TUI } from '@earendil-works/pi-tui'

export const DEFAULT_SIDEBAR_WIDTH = 44
export const MIN_SIDEBAR_WIDTH = 28
const MAX_SIDEBAR_WIDTH = 72
export const MIN_MAIN_WIDTH = 64

const REGULAR_RENDER_ADAPTER = Symbol('status-panel.regular-render-adapter')
const FULLSCREEN_LAYOUT_ADAPTER = Symbol('status-panel.fullscreen-layout-adapter')

interface RegularRenderAdapterState {
  owner: object
  baseRender: TUI['render']
  adapter: TUI['render']
  renderer?: TUI
}

interface FullscreenLayoutAdapterState {
  owner: object
  originalRoot: Component
  splitRoot: Component
}

const isRenderFunction = (value: unknown): value is TUI['render'] => typeof value === 'function'
const isObject = (value: unknown): value is object => Object(value) === value && typeof value !== 'function'

const isComponent = (value: unknown): value is Component =>
  isObject(value) && typeof Reflect.get(value, 'render') === 'function' && typeof Reflect.get(value, 'invalidate') === 'function'

const isTui = (value: unknown): value is TUI =>
  isObject(value) && isRenderFunction(Reflect.get(value, 'render')) && typeof Reflect.get(value, 'requestRender') === 'function'

const prototypeOf = (value: object): object | undefined => {
  const prototype: unknown = Object.getPrototypeOf(value)
  return isObject(prototype) ? prototype : undefined
}

const constructorName = (value: object | undefined): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  const constructor: unknown = Reflect.get(value, 'constructor')
  return typeof constructor === 'function' ? constructor.name : undefined
}

const findPrototypeRender = (tui: TUI): TUI['render'] | undefined => {
  let prototype = prototypeOf(tui)
  if (constructorName(prototype) !== 'TuiMainScreen') {
    return undefined
  }
  while (prototype !== undefined) {
    const render: unknown = Object.getOwnPropertyDescriptor(prototype, 'render')?.value
    if (isRenderFunction(render)) {
      return render
    }
    prototype = prototypeOf(prototype)
  }
  return undefined
}

const regularAdapterState = (tui: TUI): RegularRenderAdapterState | undefined => {
  const state: unknown = Reflect.get(tui, REGULAR_RENDER_ADAPTER)
  if (!isObject(state)) {
    return undefined
  }
  const owner: unknown = Reflect.get(state, 'owner')
  const baseRender: unknown = Reflect.get(state, 'baseRender')
  const adapter: unknown = Reflect.get(state, 'adapter')
  const renderer: unknown = Reflect.get(state, 'renderer')
  if (!isObject(owner) || !isRenderFunction(baseRender) || !isRenderFunction(adapter)) {
    return undefined
  }
  return { adapter, baseRender, owner, ...(isTui(renderer) ? { renderer } : {}) }
}

const fullscreenAdapterState = (tui: TUI): FullscreenLayoutAdapterState | undefined => {
  const state: unknown = Reflect.get(tui, FULLSCREEN_LAYOUT_ADAPTER)
  if (!isObject(state)) {
    return undefined
  }
  const owner: unknown = Reflect.get(state, 'owner')
  const originalRoot: unknown = Reflect.get(state, 'originalRoot')
  const splitRoot: unknown = Reflect.get(state, 'splitRoot')
  return isObject(owner) && isComponent(originalRoot) && isComponent(splitRoot) ? { originalRoot, owner, splitRoot } : undefined
}

const setLayoutRoot = (tui: TUI, component: Component) => {
  const setter: unknown = Reflect.get(tui, 'setLayoutRoot')
  if (typeof setter !== 'function') {
    return false
  }
  Reflect.apply(setter, tui, [component])
  return true
}

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
  let enabled = false
  let disposed = false
  const adapterOwner = {}

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

  const syncRegularRenderAdapter = () => {
    if (tui === undefined || tui.mode !== 'regular') {
      return
    }
    const currentState = regularAdapterState(tui)
    if (currentState !== undefined) {
      return
    }
    const baseRender = findPrototypeRender(tui)
    if (baseRender === undefined) {
      return
    }
    const state: RegularRenderAdapterState = { adapter: baseRender, baseRender, owner: adapterOwner }
    const adapter = function adapter(this: TUI, terminalWidth: number) {
      state.renderer = this
      const reservedWidth = effectiveWidth(terminalWidth)
      syncOverlayWidth(terminalWidth)
      try {
        return Reflect.apply(baseRender, this, [terminalWidth - reservedWidth])
      } catch (error) {
        options.onError?.(error)
        return Reflect.apply(baseRender, this, [terminalWidth])
      }
    }
    state.adapter = adapter
    Reflect.set(tui, REGULAR_RENDER_ADAPTER, state)
    tui.render = adapter
  }

  const restoreRegularRenderAdapter = () => {
    if (tui === undefined) {
      return
    }
    const currentState = regularAdapterState(tui)
    if (currentState?.owner !== adapterOwner) {
      return
    }
    const { renderer } = currentState
    if (renderer === undefined) {
      tui.render = currentState.baseRender
    } else if (Reflect.get(renderer, 'render') === currentState.adapter) {
      renderer.render = currentState.baseRender
    } else if (Reflect.get(tui, 'render') === currentState.adapter) {
      tui.render = currentState.baseRender
    }
    Reflect.set(tui, REGULAR_RENDER_ADAPTER, undefined)
  }

  const createFullscreenSplitRoot = (originalRoot: Component): Component =>
    new HStack([
      { basis: 0, component: originalRoot, grow: 1, minSize: minMainWidth, shrink: 1 },
      {
        basis: sidebarWidth,
        component: { invalidate: () => undefined, render: () => [] },
        grow: 0,
        maxSize: MAX_SIDEBAR_WIDTH,
        minSize: minSidebarWidth,
        shrink: 1,
        visible: ({ width }) => isVisible(width),
      },
    ])

  const syncFullscreenLayoutAdapter = () => {
    if (tui === undefined || tui.mode !== 'fullscreen') {
      return
    }
    const prototype = prototypeOf(tui)
    if (constructorName(prototype) !== 'TuiAltScreen') {
      return
    }
    const currentState = fullscreenAdapterState(tui)
    if (currentState !== undefined && currentState.owner !== adapterOwner) {
      return
    }
    const originalRoot: unknown = Reflect.get(tui, 'layoutRoot')
    if (currentState?.splitRoot === originalRoot || !isComponent(originalRoot)) {
      return
    }
    const splitRoot = createFullscreenSplitRoot(originalRoot)
    if (setLayoutRoot(tui, splitRoot)) {
      Reflect.set(tui, FULLSCREEN_LAYOUT_ADAPTER, { originalRoot, owner: adapterOwner, splitRoot })
    }
  }

  const restoreFullscreenLayoutAdapter = () => {
    if (tui === undefined) {
      return
    }
    const currentState = fullscreenAdapterState(tui)
    if (currentState?.owner !== adapterOwner) {
      return
    }
    if (Reflect.get(tui, 'layoutRoot') === currentState.splitRoot) {
      setLayoutRoot(tui, currentState.originalRoot)
    }
    Reflect.set(tui, FULLSCREEN_LAYOUT_ADAPTER, undefined)
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
      syncOverlayWidth(nextTui.terminal.columns)
      syncRegularRenderAdapter()
      syncFullscreenLayoutAdapter()
      requestRender()
    },
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      enabled = false
      restoreRegularRenderAdapter()
      restoreFullscreenLayoutAdapter()
      requestRender()
      tui = undefined
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
      syncRegularRenderAdapter()
      syncFullscreenLayoutAdapter()
      requestRender()
    },
  }
}
