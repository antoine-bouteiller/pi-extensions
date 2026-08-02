import { type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Effect, Layer, type ManagedRuntime } from 'effect'

import { type ToolFailure } from './errors.js'
import { PiCtx, type Ui, UiLive } from './services.js'

export type HandlerServices = PiCtx | Ui

/**
 * Per-invocation services. Rebuilt for every call because `ctx` differs per invocation; hoisting
 * these into the stable runtime would freeze the first invocation's context for all later ones.
 */
export const perInvocation = (ctx: ExtensionContext): Layer.Layer<HandlerServices> => {
  const piCtx = Layer.succeed(PiCtx)(ctx)
  return Layer.mergeAll(piCtx, UiLive.pipe(Layer.provide(piCtx)))
}

export const makeToolExecutor =
  <AppServices>(runtime: ManagedRuntime.ManagedRuntime<AppServices, never>) =>
  <Params, Result>(body: (params: Params) => Effect.Effect<Result, ToolFailure, AppServices | HandlerServices>) =>
  async (_toolCallId: string, params: Params, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<Result> =>
    runtime.runPromise(
      body(params).pipe(
        Effect.provide(perInvocation(ctx)),
        /*
         * A tool failure is expected, not a defect: reject with the same plain Error the
         * pre-Effect code threw, because the message is the contract Pi renders to the model.
         */
        Effect.catchTag('ToolFailure', (failure) => Effect.fail(new Error(failure.message)))
      ),
      { signal }
    )

/**
 * Deliberately generic in its error channel: some Pi events must keep rejecting (`rules` propagates
 * discovery failures) while others are best-effort. Recovery is chosen per event, not here.
 */
export const makeEventHandler =
  <AppServices>(runtime: ManagedRuntime.ManagedRuntime<AppServices, never>) =>
  <Event, Result, Failure>(body: (event: Event, ctx: ExtensionContext) => Effect.Effect<Result, Failure, AppServices | HandlerServices>) =>
  async (event: Event, ctx: ExtensionContext): Promise<Result> =>
    runtime.runPromise(body(event, ctx).pipe(Effect.provide(perInvocation(ctx))))

export const withAbortSignal = <Value>(run: (signal: AbortSignal) => Promise<Value>): Effect.Effect<Value> =>
  Effect.tryPromise({ catch: (cause) => cause, try: run }).pipe(Effect.orDie)
