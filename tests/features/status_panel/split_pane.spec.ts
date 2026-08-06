import { describe, expect, test } from 'bun:test'

import { type TUI } from '@earendil-works/pi-tui'
import { asTui } from '@tests/utils/casts.js'

import { createSplitPaneController, DEFAULT_SIDEBAR_WIDTH, MIN_MAIN_WIDTH, MIN_SIDEBAR_WIDTH } from '@/features/status_panel/split_pane.js'

const renderMainPane = (width: number) => [`main:${width}`]

const fakeTui = () => {
  let renders = 0
  const renderer = asTui({
    render: renderMainPane,
    requestRender: () => {
      renders += 1
    },
    terminal: { columns: 120 },
  })
  const tui: TUI = new Proxy(asTui({}), {
    get(_target, property) {
      if (property === 'render') {
        return (width: number) => renderer.render(width)
      }
      return Reflect.get(renderer, property, renderer)
    },
    getPrototypeOf: () => ({ render: renderMainPane }),
    set(_target, property, value) {
      return Reflect.set(renderer, property, value, renderer)
    },
  })
  return { renderCount: () => renders, tui }
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
    const { tui } = fakeTui()
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
  })
})
