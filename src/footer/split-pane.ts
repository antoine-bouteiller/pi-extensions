import type { OverlayOptions, TUI } from "@earendil-works/pi-tui";

export const DEFAULT_SIDEBAR_WIDTH = 44;
export const MIN_SIDEBAR_WIDTH = 28;
export const MAX_SIDEBAR_WIDTH = 72;
export const MIN_MAIN_WIDTH = 64;

type RenderFunction = TUI["render"];

export interface SplitPaneController {
  attach(tui: TUI): void;
  show(): void;
  hide(): void;
  isEnabled(): boolean;
  overlayOptions(): OverlayOptions;
  requestRender(): void;
  dispose(): void;
}

interface SplitPaneOptions {
  sidebarWidth?: number;
  minSidebarWidth?: number;
  minMainWidth?: number;
  onError?(error: unknown): void;
}

function finiteInteger(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function createSplitPaneController(options: SplitPaneOptions = {}): SplitPaneController {
  const minSidebarWidth = Math.max(
    1,
    finiteInteger(options.minSidebarWidth ?? MIN_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH),
  );
  const sidebarWidth = Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.max(
      minSidebarWidth,
      finiteInteger(options.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH),
    ),
  );
  const minMainWidth = Math.max(
    1,
    finiteInteger(options.minMainWidth ?? MIN_MAIN_WIDTH, MIN_MAIN_WIDTH),
  );
  let tui: TUI | undefined;
  let originalRender: RenderFunction | undefined;
  let wrappedRender: RenderFunction | undefined;
  let enabled = false;
  let disposed = false;

  const isVisible = (terminalWidth: number) =>
    enabled && Number.isFinite(terminalWidth) && terminalWidth >= minMainWidth + minSidebarWidth;
  const effectiveWidth = (terminalWidth: number) =>
    isVisible(terminalWidth) ? Math.min(sidebarWidth, terminalWidth - minMainWidth) : 0;
  const overlayLayout: OverlayOptions = {
    anchor: "top-right",
    width: sidebarWidth,
    maxHeight: "100%",
    margin: 0,
    nonCapturing: true,
    visible: (terminalWidth) => isVisible(terminalWidth),
  };

  function syncOverlayWidth(terminalWidth = tui?.terminal.columns) {
    const width = terminalWidth === undefined ? 0 : effectiveWidth(terminalWidth);
    overlayLayout.width = width > 0 ? width : sidebarWidth;
  }

  function requestRender() {
    tui?.requestRender();
  }

  return {
    attach(nextTui) {
      if (disposed) throw new Error("Cannot attach a disposed footer sidebar");
      if (tui === nextTui) return;
      if (tui) throw new Error("Footer sidebar is already attached to another TUI");
      tui = nextTui;
      originalRender = nextTui.render;
      const previousRender = nextTui.render;
      wrappedRender = function (this: TUI, terminalWidth: number): string[] {
        const reservedWidth = effectiveWidth(terminalWidth);
        syncOverlayWidth(terminalWidth);
        try {
          return previousRender.call(nextTui, terminalWidth - reservedWidth);
        } catch (error) {
          options.onError?.(error);
          return previousRender.call(nextTui, terminalWidth);
        }
      };
      nextTui.render = wrappedRender;
      requestRender();
    },
    show() {
      if (disposed || enabled) return;
      enabled = true;
      syncOverlayWidth();
      requestRender();
    },
    hide() {
      if (!enabled) return;
      enabled = false;
      requestRender();
    },
    isEnabled: () => enabled,
    overlayOptions: () => overlayLayout,
    requestRender,
    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      if (tui && originalRender && tui.render === wrappedRender) tui.render = originalRender;
      requestRender();
      tui = undefined;
      originalRender = undefined;
      wrappedRender = undefined;
    },
  };
}
