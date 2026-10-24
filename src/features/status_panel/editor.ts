import { CustomEditor, type KeybindingsManager } from '@earendil-works/pi-coding-agent'
import { type EditorTheme, truncateToWidth, type TUI, visibleWidth } from '@earendil-works/pi-tui'

type StatusIndicator = Parameters<CustomEditor['setWorkingStatusIndicator']>[0]
type RenderStatus = (width: number, color: (text: string) => string, activity?: (width: number) => string) => string

/** Border and one column of padding on each side. */
const FRAME_CHROME = 4
const FRAME_MIN_WIDTH = 8
const STATUS_MIN_WIDTH = 12

const fit = (line: string, width: number) => {
  const content = truncateToWidth(line, width, '')
  return `${content}${' '.repeat(Math.max(0, width - visibleWidth(content)))}`
}

/** Pi's editor in a rounded frame whose top border shows the status line, with Pi's working indicator as its activity. */
export class StatusEditor extends CustomEditor {
  readonly #renderStatus: RenderStatus
  #indicator: StatusIndicator
  #bottomBorder: string | undefined

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, renderStatus: RenderStatus) {
    super(tui, theme, keybindings, { embedWorkingStatus: true })
    this.#renderStatus = renderStatus
  }

  override setWorkingStatusIndicator(indicator: StatusIndicator): void {
    this.#indicator = indicator
    super.setWorkingStatusIndicator(indicator)
  }

  override render(width: number): string[] {
    if (width < FRAME_MIN_WIDTH) {
      return super.render(width)
    }
    const innerWidth = width - FRAME_CHROME
    this.#bottomBorder = undefined
    const lines = super.render(innerWidth)
    // Autocomplete renders below the bottom border; it moves inside the frame.
    const bottomIndex = this.#bottomBorder === undefined ? -1 : lines.lastIndexOf(this.#bottomBorder)
    const [top = '', ...rest] = lines
    const body = bottomIndex > 0 ? rest.filter((_line, index) => index + 1 !== bottomIndex) : rest
    const bottom = bottomIndex > 0 ? lines[bottomIndex] : this.borderColor('─'.repeat(innerWidth))
    return [
      `${this.borderColor('╭─')}${top}${this.borderColor('─╮')}`,
      ...body.map((line) => `${this.borderColor('│')} ${fit(line, innerWidth)} ${this.borderColor('│')}`),
      `${this.borderColor('╰─')}${bottom}${this.borderColor('─╯')}`,
    ]
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    // " " before the status and " ─" after it.
    const statusWidth = width - 3
    if (hiddenLineCount > 0 || statusWidth < STATUS_MIN_WIDTH) {
      return super.renderTopBorder(width, hiddenLineCount)
    }
    const indicator = this.#indicator
    const status = this.#renderStatus(
      statusWidth,
      this.borderColor,
      indicator === undefined ? undefined : (available) => indicator.renderInBorder(available) || indicator.renderSpinnerInBorder(available)
    )
    const fill = width - 2 - visibleWidth(status)
    if (visibleWidth(status) === 0 || fill < 1) {
      return super.renderTopBorder(width, hiddenLineCount)
    }
    return `${this.borderColor(' ')}${status}${this.borderColor(` ${'─'.repeat(fill)}`)}`
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    this.#bottomBorder = super.renderBottomBorder(width, hiddenLineCount)
    return this.#bottomBorder
  }
}
