import { describe, expect, test } from 'bun:test'

import { TuiAltScreen, TuiMainScreen as PiTuiMainScreen, type Terminal, type TUI } from '@earendil-works/pi-tui'
import { asTui } from '@tests/utils/casts.js'

import { createSplitPaneController, DEFAULT_SIDEBAR_WIDTH, MIN_MAIN_WIDTH, MIN_SIDEBAR_WIDTH } from '@/features/status_panel/split_pane.js'

class TuiMainScreen {
  readonly mode = 'regular' as const
  readonly terminal = { columns: 120 }
  renders = 0

  render(width: number) {
    return [`main:${width}`]
  }

  requestRender() {
    this.renders += 1
  }
}

const stableTuiReference = (getRenderer: () => TUI): TUI =>
  new Proxy(asTui({}), {
    get(_target, property) {
      const renderer = getRenderer()
      const value: unknown = Reflect.get(renderer, property, renderer)
      if (typeof value !== 'function') {
        return value
      }
      return (...args: unknown[]) => {
        const currentRenderer = getRenderer()
        const method: unknown = Reflect.get(currentRenderer, property, currentRenderer)
        if (typeof method !== 'function') {
          throw new TypeError(`${String(property)} is not callable`)
        }
        return Reflect.apply(method, currentRenderer, args)
      }
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(getRenderer()),
    set(_target, property, value) {
      const renderer = getRenderer()
      return Reflect.set(renderer, property, value, renderer)
    },
  })

const fakeTui = () => {
  const renderer = new TuiMainScreen()
  const tui = stableTuiReference(() => asTui(renderer))
  return { renderCount: () => renderer.renders, renderer, tui }
}

const fakeTerminal = (): Terminal => ({
  clearFromCursor: () => undefined,
  clearLine: () => undefined,
  clearScreen: () => undefined,
  columns: 120,
  drainInput: () => Promise.resolve(),
  hideCursor: () => undefined,
  kittyProtocolActive: false,
  moveBy: () => undefined,
  rows: 36,
  setProgress: () => undefined,
  setTitle: () => undefined,
  showCursor: () => undefined,
  start: () => undefined,
  stop: () => undefined,
  write: () => undefined,
})

const unsupportedRender = (width: number) => [`main:${width}`]
const laterRender = (width: number) => [`later:${width}`]

const fullscreenRenderer = () => {
  const renderer = new TuiAltScreen(fakeTerminal())
  const widths: number[] = []
  const root = {
    invalidate: () => undefined,
    render(width: number) {
      widths.push(width)
      return [`main:${width}`]
    },
  }
  renderer.requestRender = () => undefined
  renderer.setLayoutRoot(root)
  return { renderer, root, widths }
}

describe('status panel split pane', () => {
  test('reserves space while preserving a usable main pane', () => {
    const { tui } = fakeTui()
    const split = createSplitPaneController()
    split.show()
    split.attach(tui)

    expect(tui.render(120)).toEqual([`main:${120 - DEFAULT_SIDEBAR_WIDTH}`])
    expect(tui.render(MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH)).toEqual([`main:${MIN_MAIN_WIDTH}`])
  })

  test('auto-hides in narrow terminals and matches overlay visibility', () => {
    const { tui } = fakeTui()
    const split = createSplitPaneController()
    split.show()
    split.attach(tui)
    const overlay = split.overlayOptions()

    expect(tui.render(MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH - 1)).toEqual([`main:${MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH - 1}`])
    expect(overlay.visible?.(MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH - 1, 30)).toBeFalse()
    expect(overlay.visible?.(MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH, 30)).toBeTrue()
  })

  test('keeps the overlay width aligned with the reserved gutter', () => {
    const { tui } = fakeTui()
    const split = createSplitPaneController()
    split.show()
    split.attach(tui)
    const overlay = split.overlayOptions()

    tui.render(100)
    expect(overlay.width).toBe(36)
    tui.render(120)
    expect(overlay.width).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(split.overlayOptions()).toBe(overlay)
  })

  test('hide and dispose restore full-width rendering', () => {
    const { tui, renderCount } = fakeTui()
    const split = createSplitPaneController()
    split.show()
    split.attach(tui)

    split.hide()
    expect(tui.render(120)).toEqual(['main:120'])
    split.show()
    expect(tui.render(120)).toEqual([`main:${120 - DEFAULT_SIDEBAR_WIDTH}`])
    split.dispose()
    expect(tui.render(120)).toEqual(['main:120'])
    expect(renderCount()).toBeGreaterThan(0)
  })

  test('rejects invalid attachment lifecycles', () => {
    const first = fakeTui().tui
    const second = fakeTui().tui
    const split = createSplitPaneController()
    split.attach(first)

    expect(() => split.attach(second)).toThrow('another TUI')
    split.dispose()
    expect(() => split.attach(second)).toThrow('disposed')
  })

  test('show, hide, attach, and dispose are idempotent', () => {
    const { renderer, tui } = fakeTui()
    const split = createSplitPaneController()

    split.show()
    split.show()
    split.attach(tui)
    split.attach(tui)
    split.hide()
    split.hide()
    split.dispose()
    split.dispose()

    expect(tui.render(120)).toEqual(['main:120'])
    expect(Object.is(Reflect.get(renderer, 'render'), Reflect.get(TuiMainScreen.prototype, 'render'))).toBeTrue()
  })

  test('reserves width on Pi 0.84 concrete regular renderers without proxy recursion', () => {
    const renderer = new PiTuiMainScreen(fakeTerminal())
    const widths: number[] = []
    renderer.requestRender = () => undefined
    renderer.addChild({
      invalidate: () => undefined,
      render(width) {
        widths.push(width)
        return [`main:${width}`]
      },
    })
    const split = createSplitPaneController()
    const tui = stableTuiReference(() => renderer)

    split.attach(tui)
    split.show()

    expect(tui.render(120)).toEqual(['main:76'])
    expect(widths).toEqual([76])
    split.dispose()
    expect(renderer.render(120)).toEqual(['main:120'])
  })

  test('reserves fullscreen columns through the Pi 0.84 layout root and restores it', () => {
    const { renderer, root, widths } = fullscreenRenderer()
    const hadOwnRender = Object.hasOwn(renderer, 'render')
    const split = createSplitPaneController()

    split.attach(stableTuiReference(() => renderer))
    split.show()
    renderer.render(120)

    expect(widths.at(-1)).toBe(76)
    expect(Object.hasOwn(renderer, 'render')).toBe(hadOwnRender)
    split.hide()
    renderer.render(120)
    expect(widths.at(-1)).toBe(120)

    const laterWidths: number[] = []
    const laterRoot = {
      invalidate: () => undefined,
      render(width: number) {
        laterWidths.push(width)
        return [`later:${width}`]
      },
    }
    renderer.setLayoutRoot(laterRoot)
    split.show()
    renderer.render(120)
    expect(laterWidths.at(-1)).toBe(76)

    split.dispose()
    expect(Reflect.get(renderer, 'layoutRoot')).toBe(laterRoot)
    expect(Reflect.get(renderer, 'layoutRoot')).not.toBe(root)
  })

  test('reconciles a replaced fullscreen renderer after hide and show', () => {
    let current = fullscreenRenderer()
    const tui = stableTuiReference(() => current.renderer)
    const split = createSplitPaneController()
    split.attach(tui)
    split.show()
    current.renderer.render(120)
    expect(current.widths.at(-1)).toBe(76)

    split.hide()
    current = fullscreenRenderer()
    split.show()
    current.renderer.render(120)
    expect(current.widths.at(-1)).toBe(76)

    split.dispose()
    expect(Reflect.get(current.renderer, 'layoutRoot')).toBe(current.root)
  })

  test('does not overwrite a regular renderer installed after the split adapter', () => {
    const { renderer, tui } = fakeTui()
    const split = createSplitPaneController()
    split.attach(tui)
    split.show()
    tui.render(120)
    renderer.render = laterRender

    split.dispose()

    expect(Reflect.get(renderer, 'render')).toBe(laterRender)
    expect(renderer.render(120)).toEqual(['later:120'])
  })

  test('uses the non-overlapping adapter only for supported Pi renderers', () => {
    const tui = asTui({ mode: 'regular', render: unsupportedRender, requestRender: () => undefined, terminal: { columns: 120 } })
    const split = createSplitPaneController()

    split.attach(tui)
    split.show()

    expect(tui.render(120)).toEqual(['main:120'])
    expect(Reflect.get(tui, 'render')).toBe(unsupportedRender)
  })
})
