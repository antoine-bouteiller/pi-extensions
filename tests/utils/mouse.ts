import { type TuiMouseEvent } from '@earendil-works/pi-tui'

import { asNarrowed } from './casts.js'

/** A mouse event at a column and row local to the receiving component. */
export const mouseEvent = (
  type: TuiMouseEvent['type'],
  button: TuiMouseEvent['button'],
  column: number,
  row: number,
  wheelDelta?: number
): TuiMouseEvent =>
  asNarrowed<TuiMouseEvent, object>({
    alt: false,
    button,
    ctrl: false,
    height: 8,
    screenX: column,
    screenY: row,
    shift: false,
    type,
    width: 80,
    // Pi names the local coordinates `x` and `y`.
    ...Object.fromEntries([
      ['x', column],
      ['y', row],
    ]),
    ...(wheelDelta !== undefined && { wheelDelta }),
  })
