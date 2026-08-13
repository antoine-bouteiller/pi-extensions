import { type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { type Cause, Context, Effect, type ManagedRuntime } from 'effect'

import { type ToolFailure } from './errors.js'
import { makeUi, PiCtx, Ui } from './pi_services.js'

export type HandlerServices = PiCtx | Ui

/**
 * Per-invocation services. Rebuilt for every call because `ctx` differs per invocation; hoisting
 * these into the stable runtime would freeze the first invocation's context for all later ones.
 */
export const perInvocation = (ctx: ExtensionContext): Context.Context<HandlerServices> => Context.make(PiCtx, ctx).pipe(Context.add(Ui, makeUi(ctx)))

export const makeToolExecutor =
  <AppServices>(runtime: ManagedRuntime.ManagedRuntime<AppServices, never>) =>
  <Params, Result>(body: (params: Params) => Effect.Effect<Result, ToolFailure, AppServices | HandlerServices>) =>
  // Pi awaits the value returned by `execute`, so this boundary hands back the runtime's promise directly.
  (_toolCallId: string, params: Params, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<Result> =>
    runtime.runPromise(
      /*
       * RunPromise inspects the signal only after it begins evaluating, and returns immediately for
       * an effect that completes synchronously -- so a call cancelled before dispatch would still
       * run the body's synchronous side effects. Suspending means the body is never constructed
       * when the signal has already fired.
       */
      Effect.suspend(() => (signal !== undefined && signal.aborted ? Effect.interrupt : body(params))).pipe(Effect.provide(perInvocation(ctx))),
      { signal }
    )

/**
 * Deliberately generic in its error channel: some Pi events must keep rejecting (`rules` propagates
 * discovery failures) while others are best-effort. Recovery is chosen per event, not here.
 */
export const makeEventHandler =
  <AppServices>(runtime: ManagedRuntime.ManagedRuntime<AppServices, never>) =>
  <Event, Result, Failure>(body: (event: Event, ctx: ExtensionContext) => Effect.Effect<Result, Failure, AppServices | HandlerServices>) =>
  // Pi awaits event listeners, so this boundary hands back the runtime's promise directly.
  (event: Event, ctx: ExtensionContext): Promise<Result> =>
    /*
     * Suspended so that a handler throwing while its effect is still being built becomes a rejected
     * promise like every other failure, rather than a synchronous throw into Pi's event dispatch.
     */
    runtime.runPromise(Effect.suspend(() => body(event, ctx)).pipe(Effect.provide(perInvocation(ctx))))

/**
 * Keeps the rejection in the error channel instead of dying, so callers can `catchAll` it and map
 * it onto their own extension error rather than losing it as a defect.
 */
export const withAbortSignal = <Value>(run: (signal: AbortSignal) => Promise<Value>): Effect.Effect<Value, Cause.UnknownError> =>
  Effect.tryPromise(run)
