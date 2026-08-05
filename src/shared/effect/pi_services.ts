import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Context, Effect } from 'effect'

export class Pi extends Context.Service<Pi, ExtensionAPI>()('pi-extensions/shared/effect/pi_services/Pi') {}

export class PiCtx extends Context.Service<PiCtx, ExtensionContext>()('pi-extensions/shared/effect/pi_services/PiCtx') {}

type NotifyLevel = NonNullable<Parameters<ExtensionContext['ui']['notify']>[1]>

export interface UiShape {
  readonly confirm: (title: string, message: string) => Effect.Effect<boolean>
  readonly notify: (message: string, level: NotifyLevel) => Effect.Effect<void>
  readonly setStatus: (key: string, text: string | undefined) => Effect.Effect<void>
  readonly hasUI: Effect.Effect<boolean>
}

export class Ui extends Context.Service<Ui, UiShape>()('pi-extensions/shared/effect/pi_services/Ui') {}

export const piContext = (pi: ExtensionAPI): Context.Context<Pi> => Context.make(Pi, pi)

export const makeUi = (ctx: ExtensionContext): UiShape => ({
  /*
   * Pi accepts an AbortSignal to dismiss the dialog. Passing the fiber-linked signal from
   * Effect.promise is what closes the dialog on interruption instead of leaving it on screen.
   */
  confirm: (title, message) => Effect.promise((signal) => ctx.ui.confirm(title, message, { signal })),
  hasUI: Effect.sync(() => ctx.hasUI),
  notify: (message, level) =>
    Effect.sync(() => {
      ctx.ui.notify(message, level)
    }),
  setStatus: (key, text) =>
    Effect.sync(() => {
      ctx.ui.setStatus(key, text)
    }),
})
