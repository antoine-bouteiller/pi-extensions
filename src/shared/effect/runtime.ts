import { type AgentToolUpdateCallback, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { type Cause, Context, Effect, type ManagedRuntime } from 'effect'

import { makeUi, PiCtx, Ui } from './pi_services.js'

export type HandlerServices = PiCtx | Ui

/** One record rather than positional arguments because every body needs a different subset of it. */
export interface ToolInvocation<Params> {
  readonly ctx: ExtensionContext
  /** Left at the SDK's own default detail type: `execute` is contravariant here, so any narrower choice rejects tools whose details are concrete. */
  readonly onUpdate: AgentToolUpdateCallback | undefined
  readonly params: Params
  readonly signal: AbortSignal | undefined
  readonly toolCallId: string
}

/**
 * Per-invocation services. Rebuilt for every call because `ctx` differs per invocation; hoisting
 * these into the stable runtime would freeze the first invocation's context for all later ones.
 */
export const perInvocation = (ctx: ExtensionContext): Context.Context<HandlerServices> => Context.make(PiCtx, ctx).pipe(Context.add(Ui, makeUi(ctx)))

export const makeToolExecutor =
  <AppServices>(runtime: ManagedRuntime.ManagedRuntime<AppServices, never>) =>
  <Params, Result, Failure>(
    body: (invocation: ToolInvocation<Params>) => Effect.Effect<Result, Failure, AppServices | HandlerServices>,
    /*
     * `interruptOnAbort: false` hands cancellation entirely to the body: interrupting the fiber
     * would discard a cooperative "Cancelled" result or a tagged cancellation failure and reject
     * the tool call with a generic interrupted fiber instead. Such a body must observe `signal`.
     */
    options: { readonly interruptOnAbort?: boolean } = {}
  ) =>
  // Pi awaits the value returned by `execute`, so this boundary hands back the runtime's promise directly.
  (
    toolCallId: string,
    params: Params,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: ExtensionContext
  ): Promise<Result> => {
    const interruptOnAbort = options.interruptOnAbort ?? true
    return runtime.runPromise(
      /*
       * RunPromise inspects the signal only after it begins evaluating, and returns immediately for
       * an effect that completes synchronously -- so a call cancelled before dispatch would still
       * run the body's synchronous side effects. Suspending means the body is never constructed
       * when the signal has already fired.
       */
      Effect.suspend(() =>
        interruptOnAbort && signal !== undefined && signal.aborted ? Effect.interrupt : body({ ctx, onUpdate, params, signal, toolCallId })
      ).pipe(Effect.provide(perInvocation(ctx))),
      interruptOnAbort ? { signal } : undefined
    )
  }

export const makeCommandHandler =
  <AppServices>(runtime: ManagedRuntime.ManagedRuntime<AppServices, never>) =>
  <Failure>(body: (args: string, ctx: ExtensionCommandContext) => Effect.Effect<void, Failure, AppServices | HandlerServices>) =>
  // Pi awaits command handlers, so this boundary hands back the runtime's promise directly.
  (args: string, ctx: ExtensionCommandContext): Promise<void> =>
    /*
     * Suspended so that a handler throwing while its effect is still being built becomes a rejected
     * promise like every other failure, rather than a synchronous throw into Pi's command dispatch.
     */
    runtime.runPromise(Effect.suspend(() => body(args, ctx)).pipe(Effect.provide(perInvocation(ctx))))

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
