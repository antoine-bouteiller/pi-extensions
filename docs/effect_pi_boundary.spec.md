---
title: The Pi/Effect boundary
status: review
author: Antoine Bouteiller
date: 2026-08-14
related: [docs/project_structure.md]
---

## 2. Problem Statement

Pi is a callback-and-promise host; this package is an Effect program. Every crossing between
the two is written per feature today, and the fifteen features have drifted: some tool
callbacks link Pi's `AbortSignal` to the runtime and some drop it, commands bridge inline
with no shared helper, fibers are forked with no owner, and the runtime is re-entered from
inside effects that are already running on it. The defects this produces — a tool that keeps
working after the user cancels, a poll that outlives its session, a failure that reaches Pi
as a defect instead of a tool result — are all boundary defects, not feature defects. This
spec fixes the shape of that boundary so it is designed once instead of re-derived fifteen
times.

- `[G-1]` Every Pi callback kind (tool, event, command) has exactly one supported way to
  enter Effect, and one supported way for Effect to call back into Pi.
- `[G-2]` Cancellation propagates from Pi's `AbortSignal` to the executing fiber for every
  tool, including calls aborted before dispatch.
- `[G-3]` No fiber, child process, socket, or lock outlives the lifetime that owns it.
- `[G-4]` Expected failures reach Pi as tool failures; only bugs reach it as defects.
- `[G-5]` Existing divergences are enumerated rather than silently tolerated, so they cannot
  be cited as precedent by new code.

## 3. Key Design Decisions

| Decision                       | Choice                                                                                                                                                                       | Rationale                                                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[KD-1]` Runtime instances     | One lazily-memoized process-wide `ProcessRuntime`, threaded to every `register(pi, runtime)`                                                                                 | `ManagedRuntime.make` memoizes layers by reference, so a second runtime silently duplicates `StatusBar`, `AgentActivity`, and `McpGateway` — state that features assume is shared (`src/config/runtime.ts:11`)      |
| `[KD-2]` Boundary location     | Only `src/features/<name>/index.ts` may call `pi.registerTool`/`registerCommand`/`pi.on` or a bridge helper                                                                  | Confines Pi's callback signatures to one file per feature, which is why `effecttsgo/async-function` can be relaxed there alone (`oxlint.config.ts:30`); siblings then have a single return type, `Effect`           |
| `[KD-3]` Tool bridging         | `makeToolExecutor` is mandatory, never an inline `runtime.runPromise`                                                                                                        | It bundles three easily-forgotten steps — suspend before dispatch, pass `{ signal }` to `runPromise`, provide `PiCtx`/`Ui` per call — and every inline bridge in the repo today drops at least one                  |
| `[KD-4]` Event bridging        | `makeEventHandler`, deliberately generic in its error channel                                                                                                                | Some events must keep rejecting so Pi surfaces the failure (`rules` propagates discovery failures) while others are best-effort; fixing the channel in the helper would force one policy on both                    |
| `[KD-5]` Command bridging      | Add `makeCommandHandler`, typed to Pi's real command signature                                                                                                               | Commands need the same per-invocation `PiCtx`/`Ui` provisioning as tools, but four of them bridge inline today with no shared helper to reach for                                                                   |
| `[KD-6]` `Effect.runSync`      | Permitted only for in-memory state inside synchronous Pi/TUI callbacks                                                                                                       | Those callbacks must return a value synchronously and have no way to handle a defect; restricting the effect to non-suspending, non-failing state operations is what makes the bridge safe (`oxlint.config.ts:103`) |
| `[KD-7]` Fiber ownership       | Every fork names a `Scope` or a tracked `Fiber`; detached forks require a written justification                                                                              | An unowned fiber is a leak by construction. Scope ownership makes teardown automatic — session shutdown interrupts every poll with no bookkeeping (`src/features/background_poll/poll.ts:306`)                      |
| `[KD-8]` Runtime re-entry      | Never call `runtime.runPromise` from code already running on the runtime                                                                                                     | Re-entry detaches the inner work: interruption stops propagating, the outer `Scope` stops owning inner resources, and the abort signal stops meaning anything                                                       |
| `[KD-9]` Error channel         | Tagged errors in feature modules, mapped to `ToolFailure` at the boundary; `orDie` for broken invariants only; every `ignore`/`ignoreCause`/`orElseSucceed` carries a reason | Mapping early destroys the discrimination intermediate code needs; undocumented swallows convert Effect's main advantage back into `catch {}`                                                                       |
| `[KD-10]` Context lifetime     | `pi` may be captured at registration; `ExtensionContext` is never stored                                                                                                     | `ExtensionAPI` is process-stable, `ExtensionContext` is per-invocation — capturing it freezes the first call's context for every later one (`src/shared/effect/runtime.ts:9`)                                       |
| `[KD-11]` Cancellation         | Tool bodies receive `(params)` only and reach the signal through `withAbortSignal`                                                                                           | The fiber's signal is the one that interruption actually drives; handing the host signal to bodies invites `signal.aborted` polling and a second, unrelated controller                                              |
| `[KD-12]` Test boundary        | Feature logic tested as `Effect` under `it.effect`/`it.scoped` with `TestClock`; registration tested through the fake Pi                                                     | Virtual time keeps lifecycle tests deterministic, and driving the registered callback is the only way to catch a `[KD-3]` regression                                                                                |
| `[KD-13]` Existing divergences | Recorded in a conformance table, not migrated by this spec                                                                                                                   | Fifteen features' worth of rewriting is a separate, sequenced change; naming the divergences is what stops them propagating in the meantime                                                                         |
| `[KD-14]` Enforcement          | An oxlint rule bans `Effect.run*` and `pi.register*` outside `src/features/*/index.ts`                                                                                       | `[PI-5]` only holds if divergence is detected at the moment it is written; a review rule that fifteen features already violate will not survive the sixteenth                                                       |

## 4. Principles & Intents

- `[PI-1]` **One shape per crossing** — when two features solve the same boundary problem
  differently, at most one of them is right; the helper decides which.
- `[PI-2]` **Lifetimes are structural** — ownership is expressed by `Scope` and `ensuring`,
  never by a `finally` after an `await` or by remembering to clean up.
- `[PI-3]` **Effect is a concurrency runtime here, not a style** — a rule earns its place by
  preventing a leak, a lost cancellation, or a swallowed failure, not by being more
  idiomatic.
- `[PI-4]` **The host is the constraint** — Pi's signatures are fixed; helpers absorb the
  ugliness so feature code never sees it.
- `[PI-5]` **Divergence is visible or it is precedent** — an unlisted exception becomes the
  next feature's template.

## 5. Non-Goals

- `[NG-1]` Reducing Effect usage, or converting the promise-wrapper portions of features
  back to `async`/`await`.
- `[NG-2]` Migrating the existing divergences in §8.8; that is a plan, not this spec.
- `[NG-3]` Retrofitting the §8.8 divergences so they pass `[KD-14]`. They ship with per-site
  disable comments pointing at their conformance row until a plan migrates them.
- `[NG-4]` Changing the Pi SDK, its callback signatures, or the TypeBox schemas its tool
  registration requires.
- `[NG-5]` Prescribing internal Effect style — combinator choice, `gen` versus `pipe`,
  service granularity inside a feature.

## 6. Caveats

- `[C-1]` `src/shared/effect/bun_services.ts:12` builds a second `ManagedRuntime` and
  resolves `FileSystem`, `Path`, and `ChildProcessSpawner` eagerly, because that code runs
  before the process runtime exists. It is a deliberate exception to `[KD-1]` and is
  intended to remain the only one.
- `[C-2]` Neither runtime is ever disposed. Process exit is the teardown, which is why
  `[KD-7]` ties fibers to session and feature scopes rather than to runtime shutdown.
- `[C-3]` `makeEventHandler` and the proposed `makeCommandHandler` pass raw
  `ExtensionContext`/`ExtensionCommandContext` into their bodies as an argument. Only tool
  bodies see context exclusively as `PiCtx`/`Ui`; `[KD-10]` forbids _storing_ the context,
  not passing it down one call.
- `[C-4]` The line numbers in §8.8 are accurate as of `16020a5` and will drift. The rule
  each row cites, not the line, is the durable part.
- `[C-5]` Pi's command signature is assumed stable: one `string` of remaining command text
  plus an `ExtensionCommandContext`, awaited by the session. `[KD-5]`'s helper is typed to
  it, so an SDK change to that signature changes the helper.
- `[C-6]` `[KD-12]`'s abort test is stated as a per-tool obligation, but
  `tests/registration.spec.ts` derives its expectations from disk and could enforce it for
  every feature at once. Which of the two owns it is left to the implementer.

## 7. High-Level Components

```text
┌─ Pi zone ───────────────────────────────────────────────────────────┐
│  ExtensionAPI, ExtensionContext, AbortSignal, Promise, callbacks    │
│  Allowed in: src/features/<name>/index.ts, TUI component callbacks  │
└───────────────────────────┬─────────────────────────────────────────┘
              inbound       │       outbound
   makeToolExecutor         │         Pi / PiCtx / Ui
   makeEventHandler         │         withAbortSignal
   makeCommandHandler       │
┌───────────────────────────▼─────────────────────────────────────────┐
│  Effect zone                                                        │
│  Effect values, tagged errors, Scope, Fiber, Context services       │
│  Allowed in: every sibling module of a feature, all of src/shared/  │
└───────────────────────────┬─────────────────────────────────────────┘
                            │  ManagedRuntime
┌───────────────────────────▼─────────────────────────────────────────┐
│  Runtime zone: one process-wide ProcessRuntime, built lazily once   │
└─────────────────────────────────────────────────────────────────────┘
```

| Component            | Module type                                         | Responsibility                                                                              | Public API surface                                                                               |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Process runtime      | `src/config/runtime.ts`                             | Own the single `ManagedRuntime` and the layer set every feature shares                      | `ProcessRuntime`, `getOrCreateProcessRuntime`, `AppLayer`                                        |
| Inbound bridges      | `src/shared/effect/runtime.ts`                      | Turn an `Effect` into the callback shape Pi expects, with cancellation and per-call context | `makeToolExecutor`, `makeEventHandler`, `makeCommandHandler`, `perInvocation`, `HandlerServices` |
| Outbound bridges     | `src/shared/effect/pi_services.ts`                  | Expose Pi to Effect code as services instead of captured objects                            | `Pi`, `PiCtx`, `Ui`, `makeUi`, `withAbortSignal`                                                 |
| Failure boundary     | `src/shared/effect/errors.ts`                       | The one error type Pi understands as a failed tool call                                     | `ToolFailure`                                                                                    |
| Fiber ownership      | convention, no module                               | Bind every background fiber to a scope or a handle                                          | `Effect.forkIn`, `Effect.ensuring`, tracked `Fiber` refs                                         |
| Feature registration | `src/features/*/index.ts`, `src/config/features.ts` | Wire Pi to Effect once per feature, in registry order                                       | `register(pi, runtime)`, `registerFeatures`                                                      |
| Boundary lint rule   | `oxlint.config.ts`                                  | Fail the build when a crossing happens outside a bridge helper                              | `no-restricted-syntax` overrides keyed on `src/features/*/index.ts`                              |
| Test boundary        | `tests/utils/{bun_effect,fake_pi,runtime}.ts`       | Exercise Effect logic under virtual time and registration through a fake host               | `it.effect`, `it.scoped`, `it.live`, `createFakePi`, `testRuntime`                               |

## 8. Detailed Design

### 8.1 Process runtime

`getOrCreateProcessRuntime()` (`src/config/runtime.ts:33`) memoizes one
`ManagedRuntime<ProcessServices, never>` built from `AppLayer` — Bun filesystem and path,
`FetchHttpClient`, `StatusBarLive`, `AgentActivityLive`, `McpGatewayLive`. `src/index.ts`
calls it once and hands the result to `registerFeatures(pi, runtime)`.

A feature never calls `ManagedRuntime.make`, and never runs a bare effect that needs
application services. A service that must live for the whole process is added to `AppLayer`
as a `Layer`, not constructed on first use — `McpGatewayLive` is the precedent, and
`docs/project_structure.md` records why that one feature layer lives in `src/config/`.

### 8.2 Inbound bridge: tools

```ts
// src/features/<name>/index.ts
const executeTool = makeToolExecutor(runtime)

pi.registerTool({
  name: 'my_tool',
  parameters: MyToolParams,
  execute: executeTool((params: Static<typeof MyToolParams>) => runMyTool(params)),
})
```

`makeToolExecutor` (`src/shared/effect/runtime.ts:15`) is the only supported form. It:

1. wraps the body in `Effect.suspend` and returns `Effect.interrupt` when the signal has
   already fired, so a call cancelled before dispatch never runs the body's synchronous side
   effects;
2. passes `{ signal }` to `runPromise`, so an abort during execution interrupts the fiber;
3. provides `perInvocation(ctx)` — `PiCtx` and `Ui` rebuilt for this call.

The body's error channel is `ToolFailure`. Everything the user should see as a failed tool
call is a `ToolFailure`; everything else is a defect and should crash rather than be
formatted as a result.

### 8.3 Inbound bridge: events and commands

```ts
const handleEvent = makeEventHandler(runtime)

pi.on(
  'session_start',
  handleEvent((event, ctx) => onSessionStart(event, ctx))
)
pi.on(
  'session_shutdown',
  handleEvent(() => onSessionShutdown)
)
```

`makeEventHandler` keeps its error channel generic; recovery is chosen inside the body with
an explicit `catchAll`/`ignore`, never by widening the helper.

`makeCommandHandler` does not exist yet and is the one piece of new code this spec asks for
(authorized 2026-08-14). It belongs beside its two siblings, typed to Pi's command signature:

```ts
export const makeCommandHandler =
  <AppServices>(runtime: ManagedRuntime.ManagedRuntime<AppServices, never>) =>
  <Failure>(body: (args: string, ctx: ExtensionCommandContext) => Effect.Effect<void, Failure, AppServices | HandlerServices>) =>
  (args: string, ctx: ExtensionCommandContext): Promise<void> =>
    runtime.runPromise(Effect.suspend(() => body(args, ctx)).pipe(Effect.provide(perInvocation(ctx))))
```

Pi parses the remaining command text into one `string` and awaits `handler(args, ctx)`, so
the helper cannot be generic in its argument or result the way `makeEventHandler` is.

### 8.4 Outbound bridge: calling Pi from Effect

| Need                            | Use                                                 | Not                                             |
| ------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| Process-stable `ExtensionAPI`   | `Pi` service (`src/shared/effect/pi_services.ts:4`) | a module-level captured `pi`                    |
| Per-invocation context          | `PiCtx`, `Ui`                                       | a stored `ctx`                                  |
| A promise-returning Pi/Node API | `withAbortSignal`, `Effect.tryPromise`              | `Effect.promise` unless rejection is impossible |
| A synchronous Pi call           | `Effect.sync`                                       | direct call inside `gen`                        |

`withAbortSignal` (`src/shared/effect/runtime.ts:50`) keeps the rejection in the error
channel so callers can `catchAll` it, and supplies the _fiber's_ signal — which is what
makes `[G-2]` reach `fetch`, `pi.exec`, and `ctx.ui.confirm`. New Pi capabilities that
feature logic needs become methods on `Ui` or a sibling service rather than a `ctx`
parameter threaded down the call chain.

### 8.5 Synchronous callbacks

Status-bar renderers, completion providers, and `Component.render` must return a value
synchronously and bridge through `Effect.runSync`. The constraint is on what may be run:

- **Allowed** — `Ref.get`/`set`/`update`, pure derivation, and one-off construction of
  in-memory state at registration time.
- **Forbidden** — filesystem, HTTP, `pi.exec`, anything that can fail, anything that can
  suspend. `Effect.runSync` on a suspending effect throws a defect into a callback with no
  way to handle it.

When a synchronous callback needs data only an async effect can produce, a tracked fiber
publishes into a `Ref` and the callback reads that `Ref`.

### 8.6 Fiber and resource ownership

Every fork resolves to one of three cases:

```text
Effect.forkIn(scope)      preferred — closed by the owning lifetime, no bookkeeping
Fiber stored in a Ref     acceptable — a teardown path must call Fiber.interrupt
Effect.forkDetach         exceptional — fire-and-forget AND idempotent, with a comment
```

`src/features/background_poll/poll.ts:306` is the reference for the first case: polls fork
into the session scope, so session shutdown interrupts them. `src/features/sub_agents/peek.ts:846`
is the reference for the second. Resources acquired by a forked fiber are released with
`Effect.ensuring` or a `Scope` finalizer, never in a `finally` after an `await`.

### 8.7 Failure handling

```text
feature module          Data.TaggedError subclasses, discriminated by catchTag
        │
        │  map at the boundary only
        ▼
index.ts                ToolFailure  ──► Pi renders a failed tool call
                        defect       ──► crash; this is a bug in the package
```

`Effect.orDie` is for broken invariants — a state that indicates a bug here, not a hostile
filesystem or an offline server. `Effect.ignore`, `ignoreCause`, and `orElseSucceed` each
need a comment naming what is swallowed and why the caller cannot act on it; they should be
outnumbered by `catchTag`s.

### 8.8 Conformance

The design above is the target. These are the known divergences, listed so they are not
mistaken for precedent. Line numbers are as of `16020a5` (`[C-4]`).

| Rule     | Divergence                                                                                                                      | Sites                                                                                                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[KD-3]` | Tool callbacks bridge inline; each drops the pre-dispatch check, the `{ signal }` option, or both                               | `src/features/ask_user/index.ts:28`, `src/features/background_poll/index.ts:14`, `src/features/hashline/index.ts:25`, `src/features/safe_rm/index.ts:15`, `src/features/mcp/index.ts:21` (no pre-check), `src/features/webfetch/index.ts:12` (no `{ signal }`), `src/features/sub_agents/agents.ts:423`, `:571`, `:637`, `:683`, `:720`, `:774`, `:839` |
| `[KD-5]` | Commands bridge inline, with no helper to use                                                                                   | `src/features/prompt_rewind/index.ts:30`, `src/features/mcp/index.ts:39`, `src/features/sub_agents/agents.ts:1077`, `:1098` (one handler, two command names)                                                                                                                                                                                            |
| `[KD-7]` | Forked fibers with no interrupting owner; `core.ts:1454` is tracked and joined by `ready()` and shutdown, but never interrupted | `src/features/sub_agents/core.ts:1116`, `:1454`                                                                                                                                                                                                                                                                                                         |
| `[KD-8]` | Runtime re-entered from inside a running effect                                                                                 | `src/features/hashline/tools.ts:403`, `src/features/safe_rm/remove.ts:371`                                                                                                                                                                                                                                                                              |
| `[KD-9]` | Undocumented `orDie`                                                                                                            | `src/features/claude_code/discovery.ts:254`, `src/features/sub_agents/core.ts:480`, `:722`, `:877`                                                                                                                                                                                                                                                      |
| `[KD-9]` | Undocumented `ignoreCause`                                                                                                      | `src/features/status_panel/provider.ts:50`, `src/features/sub_agents/peek.ts:287`, `src/features/sub_agents/core.ts:2181`                                                                                                                                                                                                                               |
| `[KD-1]` | A second `ManagedRuntime`, resolved eagerly — the sanctioned exception of `[C-1]`                                               | `src/shared/effect/bun_services.ts:12`                                                                                                                                                                                                                                                                                                                  |

### 8.9 Test boundary

- Feature logic is tested as `Effect` values under `it.effect`/`it.scoped`, which supply
  `TestClock` (`tests/utils/bun_effect.ts:14`). `it.live` exists for cases that genuinely
  need a real clock and is the only place `Effect.sleep` may wait.
- Registration is tested through `createFakePi` (`tests/utils/fake_pi.ts:27`): events are
  dispatched with `emit()`, and registered tools and commands are captured in maps and
  invoked by the spec with the argument shape Pi uses.
- Each registered tool has a test that invokes its callback with an already-aborted signal
  and asserts nothing executed — the assertion that catches a `[KD-3]` regression.
- Feature tests use the process runtime via `tests/utils/runtime.ts`, or `testRuntime(layer)`
  for a feature-specific layer. Constructing a `ManagedRuntime` directly is reserved for the
  specs that test runtime and service wiring itself (`tests/config/runtime.spec.ts`,
  `tests/shared/effect/runtime.spec.ts`).

### 8.10 Checklist for a new feature

1. `index.ts` contains registration and bridge helpers, nothing else.
2. Tools go through `makeToolExecutor`, events through `makeEventHandler`, commands through
   `makeCommandHandler`.
3. No `Effect.run*` outside `index.ts`, except `runSync` on memory-only state in a
   synchronous callback (§8.5).
4. Every fork names a scope or a tracked fiber (§8.6).
5. Every resource is released by `ensuring`/`Scope`, not `finally`.
6. Errors are tagged, and each `ignore`/`orDie` carries a reason.
7. The feature is added to the registry in `src/config/features.ts`.

### 8.11 Enforcement

`[KD-14]` makes §8.10's first three items mechanical. `oxlint.config.ts` already carries the
inverse exemption — `effecttsgo/async-function` relaxed for `src/features/*/index.ts` alone
(`oxlint.config.ts:30`) — so the rule keys on the same path split:

```text
src/features/*/index.ts   allow: pi.register*, pi.on, runtime.runPromise via a bridge helper
src/features/*/!index.ts  deny:  Effect.run*, ManagedRuntime.make, pi.register*, pi.on
src/shared/**             deny:  pi.register*, pi.on
```

Two carve-outs are unavoidable: `Effect.runSync` in synchronous TUI callbacks (§8.5) and the
seven §8.8 rows. Both are expressed as per-site disable comments naming the rule and the
conformance row, so the count of disables is the migration backlog — visible in `git grep`
rather than in a document that drifts (`[PI-5]`, `[NG-3]`).

## 9. Open Questions

- `[OQ-2]` Does joining a tracked fiber satisfy `[KD-7]`, or must teardown interrupt it? The
  answer decides whether `src/features/sub_agents/core.ts:1454` is a divergence or
  conformant. — owner: @antoine
