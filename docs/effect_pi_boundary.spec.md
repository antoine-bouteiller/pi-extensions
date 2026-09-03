---
title: The Pi/Effect boundary
status: amended
author: Antoine Bouteiller
date: 2026-08-14
related: [docs/project_structure.md]
---

## 2. Problem Statement

Pi is a callback-and-promise host; this package is an Effect program. Crossings have drifted:
some tools drop Pi cancellation, commands enter the runtime inline, fibers have no owner, and
the current process runtime imports and initializes MCP even when MCP is disabled. This spec
defines one boundary and one independently enabled feature contract.

- `[G-1]` Every Pi callback kind (tool, event, command) has one supported Effect entry and
  one supported Effect-to-Pi service boundary.
- `[G-2]` Pi `AbortSignal` cancellation reaches every tool fiber, including a call aborted
  before dispatch.
- `[G-3]` No fiber, child process, socket, lock, or session context outlives its owner.
- `[G-4]` Expected failures reach Pi as tool failures; only bugs are defects.
- `[G-5]` Existing divergences are enumerated rather than silently becoming precedent.
- `[G-6]` Features are independent plugins. Their only enablement surface is one explicit
  import and one registry entry in `src/config/features.ts`.
- `[G-7]` Every enabled feature has a persistent, distinct icon/name health status.
- `[G-8]` A failed external check registers no callbacks for its feature, reports a persistent
  error, and retries in the next session without delaying `session_start`.
- `[G-9]` Disabling MCP removes its import, service initialization, and resource acquisition.

## 3. Key Design Decisions

| Decision                             | Choice                                                                                                                                                                                                                                                            | Rationale                                                                                                                                                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[KD-1]` Runtime instances           | `ManagedRuntime.make` has exactly two construction owners: the lazily memoized process-wide `AppRuntime` in `src/config/runtime.ts`, containing only shared `AppServices`, and the sub-agents runtime in `src/features/sub_agents/runtime.ts`.                    | `AppRuntime` is already the shared runtime type in `src/shared/effect/app_services.ts:83`; it must not import a feature merely to build its base layer, while sub-agents owns its isolated feature runtime. No third construction owner is allowed. |
| `[KD-2]` Boundary location           | **Amended by `[KD-2a]`.** Feature indexes own feature registrations; the coordinator alone owns extension lifecycle registration.                                                                                                                                 | Keeps Pi callback signatures at explicit owners.                                                                                                                                                                                                    |
| `[KD-2a]` Registration owners        | `src/features/<name>/index.ts` may register that descriptor's tools, commands, and non-lifecycle events; `src/config/feature_coordinator.ts` alone registers `session_start`/`session_shutdown`.                                                                  | Feature callbacks remain local, while one coordinator makes bootstrap and session ownership deterministic.                                                                                                                                          |
| `[KD-3]` Tool bridging               | `makeToolExecutor` is mandatory, never inline `runtime.runPromise`.                                                                                                                                                                                               | It suspends before dispatch, forwards `{ signal }`, and provides `PiCtx`/`Ui` per invocation (`src/shared/effect/runtime.ts:15-29`).                                                                                                                |
| `[KD-4]` Event bridging              | `makeEventHandler`, deliberately generic in its error channel.                                                                                                                                                                                                    | Event policy belongs to the event body, not a shared helper.                                                                                                                                                                                        |
| `[KD-5]` Command bridging            | Add `makeCommandHandler`, typed to Pi's actual command signature.                                                                                                                                                                                                 | Commands need the same per-invocation services as tools.                                                                                                                                                                                            |
| `[KD-6]` `Effect.runSync`            | Only memory-only, non-failing, non-suspending state in synchronous Pi/TUI callbacks.                                                                                                                                                                              | A synchronous callback cannot recover a defect from a suspended effect.                                                                                                                                                                             |
| `[KD-7]` Fiber ownership             | Every fork names a `Scope` or a tracked `Fiber`; detached forks need a written justification.                                                                                                                                                                     | An unowned fiber is a leak by construction.                                                                                                                                                                                                         |
| `[KD-8]` Runtime re-entry            | Never call `runtime.runPromise` from work already running on that runtime.                                                                                                                                                                                        | Re-entry loses structural interruption and resource ownership.                                                                                                                                                                                      |
| `[KD-9]` Error channel               | Feature modules use tagged errors; an index maps expected tool errors to `ToolFailure`; `orDie` is only for broken invariants.                                                                                                                                    | Mapping early destroys useful error discrimination.                                                                                                                                                                                                 |
| `[KD-10]` Context lifetime           | **Amended by `[KD-10a]`.** A process may capture `ExtensionAPI`; it never stores an `ExtensionContext`.                                                                                                                                                           | `PiCtx` is intentionally rebuilt from the invocation context by `perInvocation` (`src/shared/effect/runtime.ts:9-13`).                                                                                                                              |
| `[KD-10a]` Session context retention | The coordinator may retain `ExtensionContext` only in the current session record and fibers scoped to that session; it clears it after interrupting/awaiting that scope at shutdown. It never enters process runtime, descriptor, or process service state.       | Late preparation needs the current session's activation/UI context, but a later session must never use it.                                                                                                                                          |
| `[KD-11]` Cancellation               | Tool bodies receive `(params)` only and use `withAbortSignal` for host promises.                                                                                                                                                                                  | The fiber signal, not a separately polled host signal, is what interruption drives.                                                                                                                                                                 |
| `[KD-12]` Test boundary              | Logic is tested as `Effect` with `it.effect`/`it.scoped`; registration is tested through fake Pi.                                                                                                                                                                 | Virtual time and registered callbacks expose lifecycle regressions.                                                                                                                                                                                 |
| `[KD-13]` Existing divergences       | Record them in a conformance table; do not migrate them in this spec.                                                                                                                                                                                             | Visible exceptions cannot be cited as normal practice.                                                                                                                                                                                              |
| `[KD-14]` Enforcement                | **Amended by `[KD-14a]`.** An oxlint rule bans unsupported registration, bridge, runtime construction, and runtime entry locations.                                                                                                                               | The boundary must fail at author time, not in later review.                                                                                                                                                                                         |
| `[KD-14a]` Enforcement owners        | The rule allows lifecycle `pi.on` only in the coordinator; descriptor registration and bridge calls only in a feature index; managed-runtime entry only in shared bridge implementations; `ManagedRuntime.make` only in config runtime or the sub-agents runtime. | This matches `[KD-2a]` and has no broad “feature directory” exception.                                                                                                                                                                              |
| `[KD-15]` Feature contract           | `FeaturePlugin` is a discriminated union: eager descriptors expose an implementation; background preparation returns one.                                                                                                                                         | Prepared artifacts flow into registration/callback closures without shared-to-config types.                                                                                                                                                         |
| `[KD-16]` Explicit enablement        | `src/config/features.ts` has one explicit import and one stable ordered registry entry per enabled feature. Commenting **both** lines disables it.                                                                                                                | There is no auto-discovery or side-effect enablement.                                                                                                                                                                                               |
| `[KD-17]` Mixed bootstrap            | Eager descriptors validate/register synchronously in registry order at extension load. Only comment-checker and Meridian background-prepare and late-register; eager activation is awaited in registry order per session.                                         | One-shot handlers cannot be missed; only external checks are nonblocking.                                                                                                                                                                           |
| `[KD-18]` Feature health             | The coordinator owns one `FeatureHealth` enum (`checking`, `healthy`, `error`) and persistently publishes it for every enabled descriptor using §8.12 metadata.                                                                                                   | Generic, distinct status makes independent failures observable without a second poisoned health state.                                                                                                                                              |
| `[KD-19]` MCP ownership              | The base runtime has no MCP import or `McpGateway` service. The eager MCP module constructs a plain feature-owned gateway value and provides it to its callback effects.                                                                                          | Commenting MCP's two config lines fully disables MCP.                                                                                                                                                                                               |

## 4. Principles & Intents

- `[PI-1]` **One shape per crossing** — helpers, not individual features, choose the bridge.
- `[PI-2]` **Lifetimes are structural** — use `Scope`, `ensuring`, and tracked fibers, not
  `finally` after an `await`.
- `[PI-3]` **Effect is a concurrency runtime** — rules prevent leaks, lost cancellation, and
  swallowed errors rather than enforce a style.
- `[PI-4]` **The host is the constraint** — Pi signatures stay at owners; Effect code sees services.
- `[PI-5]` **Divergence is visible or it is precedent** — every exception is listed and lint-disabled.
- `[PI-6]` **Features fail independently** — no feature imports another or blocks a sibling;
  eager activation may be awaited for compatibility, but external preparation never delays startup.
- `[PI-7]` **Enablement is complete** — disabled code is neither imported into the base runtime nor
  allowed to acquire process resources indirectly.

## 5. Non-Goals

- `[NG-1]` Reducing Effect usage or converting Effect code to `async`/`await`.
- `[NG-2]` Migrating the unrelated tool/command/ownership/error divergences in §8.8; lifecycle
  migrations required by `[KD-2a]` are explicitly in scope.
- `[NG-3]` Retrofitting those divergences to pass `[KD-14a]`; each retained a one-site disable
  naming its conformance row until migration. Moot since 2026-09-03: §8.8 lists no remaining site.
- `[NG-4]` Changing Pi SDK signatures or its TypeBox registration requirements.
- `[NG-5]` Prescribing internal combinator, `gen`, or service-granularity style.
- `[NG-6]` A configuration UI/file for enablement; imports and registry entries are the mechanism.

## 6. Caveats

- `[C-2]` Process runtimes are not disposed. Process exit tears them down; session resources and
  fibers must therefore be structurally owned by session scopes.
- `[C-3]` Event and command bodies may receive a raw context for the duration of that call.
  `[KD-10a]` permits retention only by the current coordinator session record/scope and forbids
  process-lifetime retention.
- `[C-4]` §8.8 cites current symbols and checked locations; line numbers may drift, while the
  symbol/rule is durable.
- `[C-5]` Pi commands are assumed to receive remaining text and `ExtensionCommandContext`; an SDK
  signature change updates `makeCommandHandler`.
- `[C-6]` **Amended by `[C-6a]`.** The synthetic aborted-tool regression remains owned by fake Pi
  and boundary enforcement; existing tool migration remains backlog.
- `[C-6a]` It must additionally cover coordinator bootstrap: eager descriptors are registered before
  the first emitted one-shot event, while failed background descriptors never appear in fake Pi's
  registration maps. This tests `[KD-17]`, not every legacy callback.
- `[C-7]` Pi loads the extension synchronously. Eager validation/registration completes during that
  call; only the coordinator's lifecycle hooks are additionally installed there.
- `[C-8]` Pi has no unregister transaction. `register` is synchronous and must not throw. A throw
  is a poisoned invariant: report it, do not retry in-process, and require restart.
- `[C-9]` Meridian uses Effect `HttpClient`, not `withAbortSignal`, for a non-redirecting `GET`
  to the normalized `/health` URL. It accepts only 2xx, discards its scoped body, and uses a
  TestClock-compatible three-second timeout; every other outcome retries next session.
- `[C-10]` Eager registration order is exactly registry order. Background prepare completion and
  late registration order are intentionally unspecified; descriptors must be independent.
- `[C-11]` Pi 0.84.2 supports late registration (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:206-230`). The coordinator is the only lifecycle listener so a late descriptor cannot miss coordinator-managed activation.

## 7. High-Level Components

```text
Pi callbacks ── feature index/coordinator ── shared bridges ── AppRuntime
                    │                             │
                    └── FeaturePlugin ── feature-owned prepare/resources
                                      (no shared -> config or shared -> feature dependency)
```

| Component            | Module                                            | Responsibility / public surface                                                                                                       |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Shared runtime types | `src/shared/effect/app_services.ts`               | `AppServices`, `AppRuntime`, shared status/activity services (`AppServices` is currently defined at :81 and `AppRuntime` at :83).     |
| Base runtime         | `src/config/runtime.ts`                           | Build the one `AppRuntime` from Bun FS/path, HTTP, status, and activity layers; after this amendment it imports no `#features/mcp/*`. |
| Inbound bridges      | `src/shared/effect/runtime.ts`                    | `makeToolExecutor`, `makeEventHandler`, proposed `makeCommandHandler`, `perInvocation`, `HandlerServices`.                            |
| Outbound services    | `src/shared/effect/pi_services.ts` / `runtime.ts` | `PiCtx`, `Ui`, `makeUi`; generic `withAbortSignal` remains in `runtime.ts:46-51`. `PiCtx` is invocation-local at `pi_services.ts:4`.  |
| Feature contract     | `src/shared/effect/feature.ts`                    | Generic descriptor types only. It imports shared types/Pi SDK types, never config types.                                              |
| Coordinator          | `src/config/feature_coordinator.ts`               | Validate, register, maintain state, publish statuses, own session scopes/lifecycle.                                                   |
| Registry             | `src/config/features.ts`                          | Explicit descriptor imports and ordered `features`; `registerFeatures` delegates to coordinator.                                      |
| Feature index        | `src/features/*/index.ts`                         | Export `feature`; own callback registrations and feature-owned preparation/resources.                                                 |

## 8. Detailed Design

### 8.1 Base runtime and feature-owned resources

`AppServices` and `AppRuntime` are the public shared types in
`src/shared/effect/app_services.ts:81-83`. `AppLayer` is **not** public: the current
`src/config/runtime.ts:18` module constant is an implementation detail. The only config runtime
public API after this change is `getOrCreateAppRuntime(): AppRuntime` (an old
`getOrCreateProcessRuntime` name may be a compatibility alias, but must return `AppRuntime`).

That private layer merges only Bun filesystem/path, `FetchHttpClient`, `StatusBarLive`, and
`AgentActivityLive` (the current composition is `src/config/runtime.ts:18-24`). Effectful platform
services—`FileSystem`, `Path`, and `ChildProcessSpawner`—come from `AppServices` through context;
the pure path helpers belong in `src/shared/utils/path.ts`, not in a service. Remove the current
`#features/mcp/gateway` import at :5, `ProcessServices`/`ProcessRuntime` widening at :8-9, and
`McpGatewayLive` at :24. `src/index.ts:3-8` obtains the shared runtime once and delegates to
`registerFeatures`; it imports no feature.

An implementation owns non-shared values. Eager MCP constructs a plain `McpGatewayApi` value when
`src/features/mcp/index.ts` is imported, captures it in its `FeatureImplementation`, and each MCP
callback effect is explicitly provided that value with the `McpGateway` service tag. It does not use
`McpGatewayLive` or add `McpGateway` to `AppServices`. A feature needing a session resource acquires
and releases it in its activation effect/scope. Therefore commenting MCP's import and registry entry
means neither its module nor gateway value/config/socket resources are evaluated or acquired.

### 8.2 Inbound bridges

Tools use `makeToolExecutor(runtime)` exactly as implemented at
`src/shared/effect/runtime.ts:15-29`: it suspends construction, returns `Effect.interrupt` for an
already-aborted signal, provides invocation services, and passes `{ signal }` to `runPromise`.
Expected errors are `ToolFailure`; defects remain defects.

Events use generic `makeEventHandler` (`src/shared/effect/runtime.ts:35-44`). Add the adjacent
command helper, using actual Pi command types rather than the stale generic `ProcessRuntime` name:

```ts
export const makeCommandHandler =
  (runtime: AppRuntime) =>
  <Failure>(body: (args: string, ctx: ExtensionCommandContext) => Effect.Effect<void, Failure, AppServices | HandlerServices>) =>
  (args: string, ctx: ExtensionCommandContext): Promise<void> =>
    runtime.runPromise(Effect.suspend(() => body(args, ctx)).pipe(Effect.provide(perInvocation(ctx))))
```

The installed SDK defines `ExtensionCommandContext extends ExtensionContext`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:250-254`), so the
existing `perInvocation(ctx: ExtensionContext)` at `src/shared/effect/runtime.ts:13` accepts command
contexts directly.

### 8.3 Outbound bridge, sync work, and ownership

Use `PiCtx`/`Ui` for invocation state. `withAbortSignal` belongs
in `src/shared/effect/runtime.ts:46-51`, not `pi_services.ts`: it is a generic bridge helper around
an arbitrary host promise and delegates to `Effect.tryPromise`, which supplies the executing fiber's
signal. Callers use it only for host APIs that accept an `AbortSignal`; Effect `HttpClient` owns its
own cancellation and must not be wrapped with it. `Effect.runSync` is limited to in-memory state in
synchronous render/completion callbacks; suspended, failing, filesystem, HTTP, or `pi.exec` work is
forbidden there.

Every fork is `forkIn(sessionScope)`, a tracked fiber with an interrupting teardown, or the rare
documented `forkDetach`. Release resources through `Scope`/`ensuring`, never `finally` after
`await`. Do not re-enter the runtime from an Effect already running on it.

### 8.4 Generic feature contract

`src/shared/effect/feature.ts` defines this generic, config-independent discriminated union. It
imports `AppRuntime`/`AppServices` from shared and Pi SDK types, never a config type. The registry
sees only the union; implementation artifacts remain feature-private.

```ts
interface FeatureImplementation {
  readonly register: (pi: ExtensionAPI, runtime: AppRuntime) => void
  readonly activate?: (
    event: SessionStartEvent,
    ctx: ExtensionContext
  ) => Effect.Effect<void, FeatureActivationError, AppServices | HandlerServices | Scope.Scope>
  readonly deactivate?: (
    ctx: ExtensionContext,
    reason: 'shutdown' | 'replaced'
  ) => Effect.Effect<void, FeatureActivationError, AppServices | HandlerServices>
}

interface FeatureIdentity {
  readonly id: string
  readonly status: FeatureStatusMetadata
}

interface EagerFeaturePlugin extends FeatureIdentity {
  readonly bootstrap: 'eager'
  readonly implementation: FeatureImplementation
}

interface BackgroundFeaturePlugin extends FeatureIdentity {
  readonly bootstrap: 'background'
  readonly prepare: Effect.Effect<FeatureImplementation, FeaturePreflightError, AppServices>
}

type FeaturePlugin = EagerFeaturePlugin | BackgroundFeaturePlugin
```

Eager descriptors have no `prepare`: validation and `implementation.register` happen synchronously
at extension load. Background descriptors have no direct implementation: successful `prepare`
returns the exact implementation that is registered and retained for later sessions. Only
`comment-checker` and `meridian-session-affinity` are background. `FeaturePreflightError` and
`FeatureActivationError` are tagged, concise, safe-to-display contract errors; resource and artifact
representations never enter `AppServices`. Session resources are acquired in `activate` with the
provided session `Scope` or released explicitly by `deactivate`; the coordinator invokes
`deactivate` in registry order before closing the scope.

Comment-checker is constructed with injected `which` (production passes `Bun.which`; tests pass a
fake). Its preparation resolves `comment-checker` once, rejects a missing/non-absolute result, and
returns an implementation that closes over that resolved absolute path. Its runtime checker runner
uses that captured path, never repeats PATH lookup. This is why `prepare` returns an implementation
rather than `void`.

The coordinator validates before any registration: nonempty unique ID, unique `feature:<id>` key,
nonempty metadata, exactly the matching union fields, no duplicate descriptor object, and
`bootstrap: 'background'` only for `comment-checker` or `meridian-session-affinity`. Invalid
configuration is a load-time invariant defect with an explicit feature/config diagnostic; it is
never silently skipped. Validation has no I/O and follows registry order.

### 8.5 Registry, deterministic bootstrap, and one-shot lifecycle

`src/config/features.ts` is the sole enabled-feature list. It imports descriptor exports, not old
`register` functions, and contains one ordered entry for each import:

```ts
import { feature as commentChecker } from '#features/comment_checker/index'
// import { feature as meridian } from '#features/meridian_session_affinity/index'

export const features = [
  commentChecker,
  // meridian,
] satisfies readonly FeaturePlugin[]
```

Commenting both matching lines disables that feature. In particular, the MCP import and its array
entry are both removed/commented, so no MCP initialization occurs (§8.1).

At extension load the coordinator validates the complete list, creates process-level records, and
registers every eager descriptor's direct implementation synchronously in list order. It then
installs its single `session_start` and `session_shutdown` listeners. This order is mandatory: a tool
or feature event registered by an eager descriptor exists before Pi can emit a one-shot lifecycle
event. A descriptor may not register `session_start` or `session_shutdown` itself.

Registration is exactly once per process. A `register` throw transitions only that descriptor to
`poisoned`; it is never retried because Pi offers no rollback. An eager descriptor with no throw is
registered even if a sibling is poisoned. Only comment-checker and Meridian are background
descriptors; each registers only the implementation returned by its successful prepare, never after
a failed preflight.

### 8.6 Session state, concurrency, and failures

The public coordinator factory and registration entry point are exact:

```ts
export const makeFeatureCoordinator = (input: {
  readonly pi: ExtensionAPI
  readonly runtime: AppRuntime
  readonly features: readonly FeaturePlugin[]
}): FeatureCoordinator

export const registerFeatures = (pi: ExtensionAPI, runtime: AppRuntime): void =>
  makeFeatureCoordinator({ pi, runtime, features }).install()
```

`FeatureCoordinator` alone installs `session_start` and `session_shutdown` through
`makeEventHandler(runtime)`. Its start/shutdown state transitions run as Effects with
`perInvocation(ctx)` supplied. Each activation is evaluated as `Effect.suspend(() =>
implementation.activate(event, ctx))` in that session's scope with the same invocation services;
background preparation needs only `AppServices`. It owns a serialized state cell `{ nextGeneration,
session, records }`. A record is `{ plugin, implementation?, registration, health }`, where
`registration` is `unregistered | registered | poisoned` and the only health enum is
`FeatureHealth = { _tag: 'checking' } | { _tag: 'healthy' } | { _tag: 'error', reason: SafeReason
}`. `poisoned` is registration state, mapped to `error` health with the fixed restart-required
reason; it is not a fourth health value.

A session is `{ key, generation, phase, scope, ctx, lifecycleFibers }`, with `phase` of `starting |
active | stopping`. `key` is the nonempty `ctx.sessionManager.getSessionId()` captured at start;
shutdown affects the current record only when its context yields the same key. This record and its scope-owned fibers are the **only** places an
`ExtensionContext` may live under `[KD-10a]`; no record survives shutdown and no descriptor,
implementation, process runtime/service, or callback closure retains it.

At load, validation creates records. Each eager record takes its direct implementation, calls
`register(pi, runtime)` synchronously in config order, and becomes `registered`; a throw makes only
that record `poisoned/error`. A background record stays `unregistered` until a current-session
prepare returns an implementation. Its successful fiber first verifies that its generation is current and phase is `starting` or
`active`, atomically installs the implementation, calls `register` once, then activates it. After
successful activation—or immediately after registration when no activation exists—it rechecks the
same generation/phase guard, commits `healthy`, and publishes success. If any guard fails it discards
the implementation or completion and makes no later Pi/status call.

On `session_start`, the coordinator serializes lifecycle transitions. A second start first marks
the old session `stopping` and invalidates its generation, interrupts and awaits its tracked prepare
and activation fibers, runs every registered implementation's `deactivate(oldCtx, 'replaced')` in
registry order, closes/awaits its remaining scope, clears its context/fibers, and only then creates
the next generation; old lifecycle work cannot overlap deactivation. The new session enters `starting`, republishes fixed
`error` for poisoned records, publishes `checking` for other enabled records, and awaits every
already-registered implementation's `activate(event, ctx)` one at a time in registry order,
regardless of eager/background origin. Each successful activation—or registered implementation with
no activation—commits and publishes `healthy` before the next descriptor; failure commits `error`.
It then forks prepare only for unregistered background records, marks the session `active`, and returns. Thus eager and previously prepared activation is
ordered and awaited; external preparation is concurrent and nonblocking.

On `session_shutdown`, the coordinator derives the session key from the callback context. A missing
current session or unequal key is stale and does nothing. A match atomically marks the generation
`stopping` and invalid, interrupts and awaits tracked prepare/activation fibers, runs every registered
implementation's `deactivate(ctx, 'shutdown')` in registry order with per-feature failure isolation,
then closes remaining scope resources and clears the session. Prepare completion, registration,
activation, and their status writes require the current generation in `starting`/`active` immediately
before each visible step. Coordinator-owned deactivation may publish an error while `stopping` only
when both session key and generation still match; replacement completes that publication before
installing the next generation. No stale completion can register, activate, or overwrite newer status.

Prepare typed failure is reduced to a `SafeReason`, leaves the record `unregistered`, and transitions
health to `error`; it retries only in a later session. A prepare defect is logged diagnostically,
gets a fixed safe `error` reason, and has the same retry policy. Registration throw is
`poisoned/error` and never retried. Activation or deactivation typed failure leaves registration
intact and sets `error` for that session; deactivation may publish it during the guarded `stopping`
phase, and the next session retries lifecycle work. Their defects are logged, converted to fixed
`error`, and do not affect siblings or unregister callbacks. Interruption
caused by replacement/stopping publishes nothing and performs no retry work in that session; the
next session starts fresh. No feature failure cancels a sibling.

### 8.7 Status semantics and security

Every enabled descriptor has persistent key `feature:<id>`. The coordinator updates the in-memory
record first, then attempts both status-store and stock-Pi publication through `StatusBar`/`Ui`.
Publication failure is best-effort: catch/log a safe diagnostic, retain the state transition, do not
block registration/activation or change health, and retry publication on the next transition and next
session. Status is never cleared merely because checking ends. The sole health mapping is:

```text
checking  muted    <icon> <name>: checking
healthy   success  <icon> <name>
error     error    <icon> <name>: <concise reason>
```

Reasons are fixed/allowlisted summaries or normalized categories. Never include tokens,
authorization headers, URLs with credentials/query strings, raw response bodies, executable command
output, stack traces, or arbitrary exception text in status/notifications. Diagnostic logs may retain
causes only under the package's existing local logging policy.

Meridian preparation directly uses Effect `HttpClient` from `AppServices`, not `withAbortSignal`.
It parses `MERIDIAN_BASE_URL` (default `http://127.0.0.1:3456`) with the URL API, permits only
`http:`/`https:`, clears credentials, `search`, and `hash`, and replaces the path with exactly
`/health`. The
HttpClient request disables redirects and sends no credentials. Its response is acquired in a scope
and its body is discarded before the scope exits, including non-2xx responses. The request is wrapped
in TestClock-compatible `Effect.timeout`/`timeoutFail` of three seconds and only 200–299 succeeds.
Invalid URL/protocol, DNS/connect/TLS/timeout, redirect, and non-2xx failures map to safe typed
reasons; URL credentials/query/hash, response body, and raw exception text are never exposed.

### 8.8 Conformance

Lifecycle/bootstrap and runtime-composition migrations are complete. The rows below are current
unrelated divergences that remain non-goals under `[NG-2]`. Citations name current symbols/checked
lines; the symbol is durable when a line drifts (`[C-4]`).

| Scope     | Rule       | Divergence                                               | Current sites/symbols                                                                                                                                                                            |
| --------- | ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Non-goal  | `[KD-3]`   | Inline tool bridges omit the standard executor behavior. | None. Every site is migrated: `makeToolExecutor` now passes a `ToolInvocation` record and takes `interruptOnAbort` for cooperative bodies.                                                       |
| Non-goal  | `[KD-5]`   | Inline command bridges.                                  | None. `prompt_rewind` and `mcp` now use `makeCommandHandler`.                                                                                                                                    |
| Exception | `[KD-6]`   | Verified memory-only synchronous Effect execution.       | None. Memory-only state is built with `Ref.makeUnsafe`/`Semaphore.makeUnsafe` and read with `Ref.getUnsafe`; the status panel holds its state in a `MutableRef` and the sidebar in plain locals. |
| Non-goal  | `[KD-7]`   | Existing fork policies.                                  | None. Every status-panel fork names the session scope (`Effect.forkIn`), and the synchronous footer callback enters Effect through `Queue.offerUnsafe` on a session-scoped queue.                |
| Non-goal  | `[KD-8]`   | Runtime re-entry from effectful code.                    | None. `mutationQueueSlot` (`src/shared/effect/mutation_queue.ts`) acquires Pi's queue as a scoped resource, so the guarded work stays on the calling fiber.                                      |
| Non-goal  | `[KD-14a]` | Direct runtime adapters outside approved owners.         | None. `KeychainOAuthProvider` builds its promise-returning SDK members with `toPromiseMethod` from the bridge module, and the status panel resolves its services inside `sessionStart`.          |

### 8.9 Test boundary

- Test Effect logic with `it.effect`/`it.scoped` and `TestClock` (`tests/utils/bun_effect.ts:14`);
  use `it.live` only for real-clock behavior.
- Test descriptors/coordinator through `createFakePi` (`tests/utils/fake_pi.ts:27`). Assert eager
  validation/registration and eager activation in stable registry order; a one-shot event emitted
  immediately after load reaches the eager registration.
- With deferred/TestClock preparation, assert `session_start` awaits every registered activation but
  returns before unregistered background preparation; no callback is registered before prepare
  returns its implementation, none after failure, and later sessions activate retained background
  implementations without preparing again.
- Cover start/start replacement, matching/stale shutdown keys, interrupt-and-await before
  deactivation, deactivation-before-final-scope-close, stale-generation completion guards, one fiber
  per background record/generation, sibling independence, status-publication failure, and typed
  failure/defect/interruption lifecycle policy.
- Comment-checker tests inject `which`, assert the absolute resolved path is captured and used by the
  runner, and cover missing/relative paths. Meridian tests use a TestClock timeout and assert URL
  normalization, non-redirecting 2xx-only behavior, body discard, and redaction.
- Build an isolated test entry that imports the base runtime and a registry with no MCP descriptor;
  inspect Bun's build metafile and assert no `src/features/mcp/` input is reachable. With MCP enabled,
  spy on its gateway factory to assert one construction and explicit callback-effect provision,
  never a widened `AppServices` member.
- Invoke a `makeToolExecutor` tool with an already-aborted signal and prove its body was not built.

### 8.10 Checklist for a new feature

1. Export one discriminated `feature: FeaturePlugin` from its index. Eager features expose an
   implementation; only comment-checker/Meridian prepare and return one.
2. Give it the unique §8.12 ID, icon, and display name; use safe tagged failures.
3. Use bridge helpers; migrate lifecycle behavior into `implementation.activate`/`deactivate` and
   do not register lifecycle events from the feature index.
4. Make values/resources feature-owned; provide captured feature services to callback effects and
   scope session resources to activation.
5. Add one import and one ordered entry in `src/config/features.ts`; verify commenting both disables it.
6. Test descriptor validation, bootstrap/implementation artifacts, status, failure, retry, and race
   behavior independently.

### 8.11 Enforcement

`[KD-14a]` is enforced with this binding-aware owner matrix. Its two `ManagedRuntime.make`
construction slots match `isRuntimeConstructionModule`; no third construction owner is allowed:

```text
src/features/*/index.ts            allow: descriptor registration, non-lifecycle pi.on, bridge helpers
src/config/feature_coordinator.ts  allow: lifecycle pi.on and event bridge; deny direct runtime entry
src/shared/effect/runtime.ts       allow: managed-runtime execution inside bridge implementations
src/config/runtime.ts              allow: canonical ManagedRuntime.make for AppRuntime only
src/features/sub_agents/runtime.ts allow: feature-owned ManagedRuntime.make for sub-agents only
all other src/**                   deny: pi.register*, pi.on, bridge helpers, runtime construction/entry
```

`toPromiseMethod` in `src/shared/effect/runtime.ts` is the sanctioned adapter for third-party
contracts that declare promise-returning members, such as the MCP SDK's `OAuthClientProvider`: the
logic stays in Effect and only the outermost method crosses. Memory-only synchronous state uses the
`*Unsafe` constructors and readers instead of runtime entry, so no §8.8 site governed by
`no-effect-pi-boundary` carries a disable comment. `[KD-9]` remains outside this rule. The lint rule also rejects
`session_start`/`session_shutdown` registration from a feature index and rejects config runtime
imports matching `#features/*`.

### 8.12 Enabled feature status metadata

Every enabled descriptor uses exactly this metadata and its `feature:<id>` key:

| ID                          | Icon | Display name      |
| --------------------------- | ---- | ----------------- |
| `ask-user`                  | ❓   | `ask-user`        |
| `auto-theme`                | 🎨   | `auto-theme`      |
| `background-poll`           | ⏳   | `background-poll` |
| `caffeinate`                | ☕   | `caffeinate`      |
| `claude-code`               | 🤖   | `claude-code`     |
| `comment-checker`           | 💬   | `comment-checker` |
| `hashline`                  | #️⃣   | `hashline`        |
| `mcp`                       | 🔌   | `mcp`             |
| `meridian-session-affinity` | 🧭   | `meridian`        |
| `prompt-rewind`             | ↩️   | `prompt-rewind`   |
| `rules`                     | 📜   | `rules`           |
| `status-panel`              | 📊   | `status-panel`    |
| `sub-agents`                | 🧑‍🤝‍🧑   | `sub-agents`      |
| `webfetch`                  | 🌐   | `webfetch`        |

## 9. Open Questions

N/A

## Changelog

| Date       | Amendment                                                                                                                                                          | Sections affected | Reason                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-14 | Initial boundary specification                                                                                                                                     | 2–9               | Define the Effect/Pi crossing and conformance target.                                                                                                                                                                                                                                               |
| 2026-08-24 | Add independent feature plugins, background preflight, and generic persistent health                                                                               | 2–8               | Make features independently enabled, registered, checked, and observable without blocking session startup.                                                                                                                                                                                          |
| 2026-08-24 | Amend boundary ownership, runtime composition, discriminated plugin contract, bootstrap, coordinator races/state, status/security behavior, conformance, and tests | 2–8               | Resolve all review blockers: implementation-returning preparation, synchronous eager registration/ordered activation, only comment-checker/Meridian background prepare, session-only context, resilient status policy, Meridian HTTP security, full MCP disablement, and lifecycle migration scope. |
| 2026-08-24 | Complete descriptor-only registry composition and remove completed lifecycle/runtime migrations from conformance                                                   | 8                 | Make configuration the sole enablement surface and retain only active divergence inventory.                                                                                                                                                                                                         |
| 2026-09-03 | Close the `[KD-6]`, `[KD-7]`, and `[KD-14a]` divergences and name `toPromiseMethod` as the SDK-adapter bridge                                                      | 8.8, 8.11         | Unsafe constructors, `MutableRef`, session-scoped forks, and one bridge adapter replace every inline boundary disable.                                                                                                                                                                              |
