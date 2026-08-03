import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Context, Effect, Layer } from 'effect'

export class Pi extends Context.Service<Pi, ExtensionAPI>()('@pi/Pi') {}

export class PiCtx extends Context.Service<PiCtx, ExtensionContext>()('@pi/PiCtx') {}

type NotifyLevel = NonNullable<Parameters<ExtensionContext['ui']['notify']>[1]>

export interface UiShape {
  readonly confirm: (title: string, message: string) => Effect.Effect<boolean>
  readonly notify: (message: string, level: NotifyLevel) => Effect.Effect<void>
  readonly setStatus: (key: string, text: string | undefined) => Effect.Effect<void>
  readonly hasUI: Effect.Effect<boolean>
}

export class Ui extends Context.Service<Ui, UiShape>()('@pi/Ui') {}

export const piLayer = (pi: ExtensionAPI): Layer.Layer<Pi> => Layer.succeed(Pi)(pi)

export const UiLive: Layer.Layer<Ui, never, PiCtx> = Layer.effect(Ui)(
  Effect.gen(function* () {
    const ctx = yield* PiCtx
    return {
      /*
       * Pi accepts an AbortSignal to dismiss the dialog. Passing the fiber-linked signal from
       * tryPromise is what closes the dialog on interruption instead of leaving it on screen.
       */
      confirm: (title, message) =>
        Effect.tryPromise({
          catch: (cause) => cause,
          try: (signal) => ctx.ui.confirm(title, message, { signal }),
        }).pipe(Effect.orDie),
      hasUI: Effect.sync(() => ctx.hasUI),
      notify: (message, level) =>
        Effect.sync(() => {
          ctx.ui.notify(message, level)
        }),
      setStatus: (key, text) =>
        Effect.sync(() => {
          ctx.ui.setStatus(key, text)
        }),
    }
  })
)
