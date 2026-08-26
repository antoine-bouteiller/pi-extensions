---
title: Orchestration engine
status: amended
author: Antoine Bouteiller
date: 2026-08-17
parent-spec: src/features/sub_agents/spec/sub-agents.spec.md
---

## 2. Problem Statement

One component owns the hard part of delegation: starting a child process, keeping its record durable,
resolving exactly one delivery route for its settlement, and guaranteeing that nothing is left running
or pending afterwards. It is where `[G-2.1]`, `[G-3]`, and `[G-6.1]` are either true or not.

Goals are owned by the umbrella.

## 3. Key Design Decisions

| Decision                           | Choice                                                                                                                                                                                                                                                                                                                                                                   | Rationale                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[KD-1]` Lifecycle states          | `starting`, `running`, `completed`, `failed`, `interrupted`, with the last three terminal                                                                                                                                                                                                                                                                                | Five states cover every question a caller or the operator asks, and separating `interrupted` from `failed` is what makes a deliberate stop legible in a listing                                                     |
| `[KD-2]` Delivery arbitration      | A settlement is first durably recorded, then represented by an in-memory queued notice for one delivery claim; omitted waits, completed-agent-resume and explicit-API-interrupt synchronous claims, and notifications arbitrate it, while explicit target waits are repeatable reads                                                                                     | One arbitration point prevents duplicate automatic delivery without withholding durable inspection or explicit access; notices are never a durable queue                                                            |
| `[KD-3.1]` Late and early waits    | Explicit waits read the newest observed turn repeatably; an omitted wait snapshots only queued settlement notices and live eligible unclaimed turns that exist at invocation, while injection-only warning notices never enter wait snapshots and invalid or empty snapshots refuse immediately                                                                          | This separates durable inspection from one-shot notification delivery without awaiting work that did not exist when the call began                                                                                  |
| `[KD-4.1]` Follow-up admission     | Steering a running turn needs no capacity claim; resuming a completed agent requires ownership, an existing profile, no in-flight follow-up, context below its ceiling, and available capacity                                                                                                                                                                           | Only a resumed turn creates a process and consumes capacity; an 8,192-token fallback reserves useful response when model output capacity is unavailable                                                             |
| `[KD-5.1]` Admission order         | Profile resolution precedes one atomic session claim of task-name uniqueness and capacity, then provisional process start; no durable/public record exists until `ready` commits admission                                                                                                                                                                               | Resolving cheap failures first avoids records for work that never ran, while one claim prevents racing spawns from duplicating names or exceeding live-agent limits                                                 |
| `[KD-6]` Record store              | One JSON info file per agent sits beside its session file and log under `${PI_SUBAGENT_TEMP_DIR ?? tmpdir()}/pi-codex-subagents/<username>/runs`                                                                                                                                                                                                                         | Reusing the package's existing private temporary-state root avoids another configuration surface; per-agent files isolate corruption and support transcript inspection                                              |
| `[KD-7]` Startup reaping           | Startup prunes aged/unparseable records; verified orphans are interrupted, while PID identity mismatch deletes artifacts and releases claims without signalling                                                                                                                                                                                                          | An orphan's stdio belongs to a dead parent, a recycled PID must never be signalled, and seven-day cleanup balances inspection against disk use                                                                      |
| `[KD-8.2]` Signalling safety       | A stop first requests cooperative protocol interruption. After five seconds, or during startup reaping, the adapter may terminate the process group/tree only while the worker's recorded platform creation marker still matches; observed worker exit releases ownership, and surviving descendants are left alone rather than signalling an unverified reused group ID | Most stops need no OS signal, marker verification protects forced cleanup from PID reuse, and best-effort descendants avoid adding a permanent supervisor process per turn                                          |
| `[KD-9]` Child channel             | Length-bounded JSONL frames over the child's stdin and stdout; the transcript is read from the child's own session file on disk                                                                                                                                                                                                                                          | One channel for control and none for history; a 1 MiB bound protects the parser while allowing large tasks, and five minutes warns before the 30-minute deadline                                                    |
| `[KD-10]` Stop semantics           | Interrupt waits for normal durable delivery; panic is separate and suppresses only outcomes it creates, preserving earlier queued notices                                                                                                                                                                                                                                | Deliberate interruption remains observable without allowing panic cleanup to erase prior work                                                                                                                       |
| `[KD-11]` Freeze at the ceiling    | An agent whose conversation reaches its context ceiling stays settled and readable, with further follow-ups refused rather than the agent terminated                                                                                                                                                                                                                     | The accumulated work is the valuable part; terminating to enforce a bound would destroy exactly what the bound was protecting                                                                                       |
| `[KD-12.2]` Capacity admission     | A session holds at most three worker slots, including at most one `implementer`; `starting`, `running`, and terminal workers awaiting verified exit retain slots. A still-live worker handed to cleanup keeps its slot, while observed worker exit releases it even if untracked descendants may remain                                                                  | Counting owned workers through cleanup preserves the bounded worker contract without pretending the extension can safely own descendants after their verifiable group leader disappears                             |
| `[KD-13]` Turn deadline            | Every initial or resumed turn receives a monotonic 30-minute deadline; steering a running turn does not reset it, and expiry terminates the child and settles it `failed` with `turn_timeout`                                                                                                                                                                            | Thirty minutes bounds every foreground spawn and wait without treating additional guidance as additional execution budget; the 30-second readiness bound aligns with repository process/connect bounds              |
| `[KD-14.2]` Worker lifetime        | One worker runs one initial or resumed turn as process-group/tree leader. Stop and outcome paths request protocol interruption/exit and allow five seconds before marker-verified best-effort tree termination; observed worker exit is terminal even if descendants escaped cleanup, and a follow-up starts a new worker from the stored session                        | Cooperative shutdown handles the normal path, bounded fallback cleans ordinary descendants, and accepting the detached-descendant ceiling avoids a second supervisor process                                        |
| `[KD-15]` Effect ownership         | `SubagentOrchestrator` is an Effect service in the stable runtime; it owns one closeable child scope per Pi session, and host operations are injected services while public adapters only interpret its typed effects                                                                                                                                                    | Structural concurrency keeps ordinary background ownership bounded by its session and retains failed cleanup for supervised retry, while replaceable host ports make every race and deadline deterministic in tests |
| `[KD-16]` Worker/session ownership | The package worker is launched with the current Bun executable at an entrypoint resolved from `import.meta.url`. It creates the initial persistent Pi session in the owner-only run directory, includes its validated session path in `ready`, and a resumed turn opens that exact file with `SessionManager.open` as its sole writer                                    | The parent owns durable location and validation while exactly one turn worker writes the Pi session at a time; a parent restart remains non-continuable                                                             |
| `[KD-17]` Worker protocol adapter  | The worker owns a strict-LF, 1 MiB JSONL state machine over concurrent stdin/stdout and translates accepted SDK lifecycle events to bounded protocol frames; it never forwards native Pi events verbatim                                                                                                                                                                 | A small stable protocol prevents reasoning, transcript, tool arguments, and tool output from crossing the child boundary                                                                                            |

## 4. Principles & Intents

- `[PI-1]` One owner per settlement — supports umbrella `[G-2.1]`: at any instant a settlement is owed
  to at most one automatic destination, and the transition between destinations is atomic.

## 5. Non-Goals

- `[NG-1]` Cross-session operations of any kind — refines umbrella `[NG-5]`: every call, reading or
  mutating, filters on the owning session before doing anything.
- `[NG-2]` Resuming or adopting a child's conversation after a restart — follows umbrella `[C-9]`: the
  conclusion is durable, the live process is not.
- `[NG-3.1]` Queuing excess children, configurable limits, or per-profile limits beyond the single
  `implementer` bound — refines umbrella `[KD-11.2]`; admission either succeeds immediately or refuses.
- `[NG-4]` Windows support — spawning, termination, worker startup, and descriptor-based path
  validation refuse on Windows; its process-tree and PowerShell creation-time mechanisms remain for a
  future port.

## 6. Caveats

- `[C-2]` All settled artifacts are retained for seven days from `settledAt`, then pruned; live records are never pruned.
- `[C-4]` Capacity is session-local, not a machine-wide provider quota; separate sessions can each
  run three children.
- `[C-5]` Deadline scheduling uses Effect's clock and each turn also stores its wall-clock deadline.
  The engine compares that instant after wake or any observed event, so host suspension consumes the
  budget and may time out immediately after resume. While the host is running, termination resolves
  within 30m05s; no elapsed-time guarantee is possible while the machine itself is suspended.
- `[C-6]` PID-identity mismatch cleanup intentionally deletes prior settled history when it belongs to
  the same resumed agent record. This is the accepted stale-ownership safety policy: never signal an
  unverified process, even though the cleanup is an exception to normal seven-day retention.
- `[C-7]` A background child is scoped to its owning Pi session, not to the tool call that admitted it.
  Closing that session performs bounded identity-verified termination without affecting another session;
  if the OS refuses termination, the stable service retains the process and durable lease for retry and
  startup reaping rather than claiming it stopped. Cancelling an admitted caller releases only that
  caller's delivery claim.
- `[C-8]` The injected write/chmod/rename/lease-removal failure matrix and temporary-file cleanup,
  descriptor replacement and file mutation between open and validation, real-child resource-ownership
  paths (marker-capture failure, write failure, reader failure, and normal and forced exit), concurrent
  steer-versus-settlement arbitration, create-versus-resume session-file collisions and header timing,
  duplicate-task and command-ID echo permutations, `closeSession` aggregation of several independent
  cleanup failures, and a pinned settlement winner for every racing pair rather than either outcome
  lack automated evidence. Descriptor isolation guards extension stdout, but no fixture proves the
  protocol channel remains clean.
- `[C-9]` Windows is outside the supported contract: sub-agent process spawning, termination, worker
  startup, and descriptor-based path validation refuse there rather than advertise unverified support.
  Windows process-tree and PowerShell creation-time mechanisms remain specified for a future port.

## 7. High-Level Components

N/A — the component inventory is owned by the umbrella.

## 8. Detailed Design

### Effect service architecture

The engine exposes one service; it does not expose its `Ref`, `Deferred`, `Queue`, `Fiber`, scopes,
process handles, or persistence adapters. Every operation carries an opaque `SessionKey`, derived by
the Pi adapter from the current invocation, so the stable process runtime may safely serve multiple
sessions. The public result shapes remain the ones specified below; these additional aliases make the
service boundary complete:

```ts
import { Context, Effect, Schema } from 'effect'

import { ToolErrorCodeSchema, type AgentResult, type PersistedResolvedProfile } from './model.js'

type SessionKey = string // opaque host session identity
type TaskName = string // validated before this boundary
type ProfileKey = 'scout' | 'librarian' | 'reviewer' | 'implementer'
type AgentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'interrupted'
type VisibleAgentStatus = Exclude<AgentStatus, 'starting'>
type AdmissionSnapshot = {
  cwd: string
  agent_dir: string
  project_trusted: boolean
  parent_model?: { provider: string; model: string }
  registered_tools: readonly string[]
  environment: Readonly<Record<string, string>>
} // immutable, invocation-scoped, never persisted
type SpawnRequest = { task_name: TaskName; agent_type: ProfileKey; message: string; run_in_background: boolean }
type RunningAcceptance = { task_name: TaskName; profile: ProfileKey; turn: number; status: 'running' }
type AgentListEntry = { task_name: TaskName; profile: string; status: VisibleAgentStatus; current_turn: number; follow_up_available: boolean }
type AgentRecordView = { task_name: TaskName; profile: string; status: VisibleAgentStatus; turns: readonly AgentResult[] }
// Internal only: every durable turn retains both its admission-time profile and outcome.
type AgentTurnRecord = { profile: PersistedResolvedProfile; result: AgentResult }
type SteeringAck = { task_name: TaskName; turn: number; status: 'running'; accepted: true }
type CommandError =
  | { task_name: TaskName; turn: number; status: 'running'; accepted: false; error: { code: 'queue_rejected'; message: string } }
  | {
      task_name: TaskName
      turn: number
      status: 'completed' | 'failed' | 'interrupted' // actual terminal status
      accepted: false
      error: { code: 'turn_settled'; message: string }
    }
type SettledInterruptNoop = { task_name: TaskName; turn: number; status: Exclude<VisibleAgentStatus, 'running'>; interrupted: false }
class PublicRefusalError extends Schema.TaggedError<PublicRefusalError>()('PublicRefusalError', {
  code: ToolErrorCodeSchema,
  message: Schema.String,
  task_name: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

class LifecycleError extends Schema.TaggedError<LifecycleError>()('LifecycleError', {
  operation: Schema.Literals(['initialize', 'open_session', 'close_session']),
  reason: Schema.Literals(['session_not_open', 'cleanup_incomplete', 'host_failure']),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

type OrchestrationError = PublicRefusalError | LifecycleError

interface SubagentOrchestratorApi {
  readonly initialize: Effect.Effect<void, OrchestrationError>
  readonly openSession: (session: SessionKey) => Effect.Effect<number, OrchestrationError>
  readonly closeSession: (session: SessionKey) => Effect.Effect<void, OrchestrationError>
  readonly spawn: (
    session: SessionKey,
    admission: AdmissionSnapshot,
    request: SpawnRequest
  ) => Effect.Effect<AgentResult | RunningAcceptance, OrchestrationError>
  readonly waitOne: (session: SessionKey, targets?: readonly TaskName[]) => Effect.Effect<AgentResult, OrchestrationError>
  readonly waitAll: (session: SessionKey, targets?: readonly TaskName[]) => Effect.Effect<readonly AgentResult[], OrchestrationError>
  readonly list: (session: SessionKey) => Effect.Effect<readonly AgentListEntry[], OrchestrationError>
  readonly read: (session: SessionKey, target: TaskName) => Effect.Effect<AgentRecordView, OrchestrationError>
  readonly send: (
    session: SessionKey,
    admission: AdmissionSnapshot,
    target: TaskName,
    message: string
  ) => Effect.Effect<SteeringAck | CommandError | AgentResult, OrchestrationError>
  readonly interrupt: (session: SessionKey, target: TaskName) => Effect.Effect<AgentResult | SettledInterruptNoop, OrchestrationError>
  readonly interruptAll: (session: SessionKey) => Effect.Effect<void, OrchestrationError>
}

class SubagentOrchestrator extends Context.Service<SubagentOrchestrator, SubagentOrchestratorApi>()(
  'pi-extensions/features/sub_agents/SubagentOrchestrator'
) {}
```

The Pi adapter constructs `AdmissionSnapshot` at each `spawn` and `send_message` invocation from
`ctx.cwd`, the configured agent directory, `ctx.isProjectTrusted()`, `ctx.model`, `pi.getAllTools()`, and
a string-only copy of `process.env`. The orchestrator/profile resolver uses only that immutable snapshot
for initial or resumed admission; it neither retains `PiCtx` nor reads a later invocation's host state.
Running steering accepts the snapshot for one uniform adapter path but does not consult it.

`PublicRefusalError` carries one canonical `ToolErrorCode` and is mapped by the delegation adapter to the public `Refusal`. A post-readiness child, timeout, protocol, process, or storage failure first settles durably and remains a successful Effect value containing a failed/interrupted `AgentResult`; it is not also an Effect failure. A failure that prevents durable settlement uses `PublicRefusalError` (`startup_failed` before readiness, `agent_failed` afterward). `LifecycleError` is reserved for initialization/session-hook failures and never enters a tool result. Notification injection failure is logged and consumed as already specified. Cleanup finalizers catch and aggregate failures after making every remaining release attempt, then hand any still-live process and lease to the stable cleanup registry, so their own error channel is `never`; `closeSession` reports the handoff and cleanup never replaces the turn's first winning outcome. Unknown thrown values are wrapped as
`Cause.UnknownError` at the host adapter that catches them. Defects are reserved for broken internal
invariants, never routine process or filesystem failure. This follows the package's tagged-error boundary
(`src/shared/effect/errors.ts:7`) without changing the assistant-facing schema.

The live layer depends on narrow replaceable ports:

| Service                      | Ownership and contract                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProfileResolver`            | Effect port over the profile leaf's pure resolver; returns a redacted persisted profile before admission.                                             |
| `SubagentStore`              | Creates owner-only directories, leases, records, logs, and full results; performs atomic replacement, reads, and pruning.                             |
| `ChildProcess`               | Spawns one turn, streams bounded frames, captures and revalidates `ProcessIdentity`, and signals only a verified process.                             |
| `NotificationSink`           | Accepts FIFO settlement/warning batches for one `pi.sendUserMessage` attempt, using normal idle delivery or running steer; it is not durable storage. |
| Effect `Clock`               | Supplies scheduling, monotonic time, and wall-clock deadline instants; no orchestration path installs a raw timer.                                    |
| `AgentActivity`              | Publishes the ready-running projection already shared with the status sidebar (`src/shared/effect/app_services.ts:29`).                               |
| Effect `FileSystem` / `Path` | Supply portable storage operations beneath `SubagentStore`; host-specific no-follow and process-identity operations stay in their adapters.           |

These dependencies are provided to `SubagentOrchestratorLive` through layers. The orchestration core
must not import the eager Bun service singletons because those cannot be substituted per test
(`src/shared/effect/bun_services.ts:5`). Host filesystem behavior absent from Effect `FileSystem`, such
as no-follow metadata or descriptor ownership, belongs in the dedicated adapter, following the existing
boundary documented at `src/shared/effect/bun_host_file_system.ts:1`.

The stable layer holds a map of session generations, each with one state: `opening`, `open`, `closing`,
or `closed`, and an `open` generation owns a `Scope.Closeable`. The asynchronous `initialize` effect
performs process-wide prune/reap once, guarded by a shared `Deferred`; concurrent callers await the same
result. The feature descriptor's `activate` effect awaits `initialize`, then `openSession`, whose returned
generation binds notifications to that exact session generation; its `deactivate` effect calls `closeSession`; every spawn also awaits that barrier defensively. The feature
coordinator supplies the per-session `ExtensionContext`, scope, and replacement ordering, so this service
registers no session lifecycle hook of its own. `openSession` creates a new generation only from absent/`closed`.

`closeSession` takes the same per-session semaphore used by admission, marks the generation `closing`,
and prevents new spawn, send, or readiness commits. A tool operation that observes absent, `opening`, `closing`, or `closed` maps that generation race to
public `session_unavailable`; initialization and session-hook failures remain `LifecycleError` host failures. A provisional launch whose ready
transition loses to closure is terminated and cleaned without a public record; if readiness commits
first, closure owns and interrupts the admitted child. Closure then closes only that scope, discards its
undeliverable notices, and removes its activity. Successfully terminated children settle `interrupted`;
any child still alive after bounded attempts remains in a process-wide cleanup registry with its durable
lease and causes `closeSession` to fail visibly. A supervised retry fiber retains ownership until exit,
and the next initialization also reaps the lease. The generation becomes `closed` only after all
admission/readiness transfers have resolved, so a replacement can open a fresh scope without receiving a
late child from its predecessor. Layer disposal makes the same bounded attempts without discarding
failed-cleanup tracking. Construction itself stays synchronous, preserving existing synchronous runtime
consumers.

A provisional launch uses nested brackets. The capacity/name claim gets a release immediately. `ChildProcess.spawn` atomically returns a capability-safe process handle together with the `ProcessIdentity` captured for that exact child; the successful spawn immediately gets an identity-verifying termination release before lease writing or frame handling can fail. Only then does the engine atomically write the private lease; each later acquisition step has compensating cleanup. Readiness
atomically transfers those resources into the session's child scope and replaces the lease with the
public running record. The child also exits on parent-channel EOF, closing the unavoidable OS-crash
window between spawn and durable lease creation. The descriptor-safety precedent is
`src/shared/effect/bun_host_file_system.ts:105`.

Service-owned state uses Effect concurrency primitives with these semantics:

- A per-session `Semaphore(1)` serializes multi-field admission and delivery transitions; a `Ref`
  stores each session's immutable state snapshot. No check-then-set occurs on an unguarded `Map`.
- One `Deferred` per accepted turn publishes its single durable settlement to any number of repeatable
  readers. A FIFO `Queue` holds only ephemeral notification notices.
- Supervised `Fiber`s in the session scope own child frame readers, deadline/inactivity timers, and exit
  observation. Exit, timeout, malformed frame, and explicit interrupt converge on one idempotent
  settlement effect under the session lock. Post-readiness caller cancellation instead performs the
  specified atomic delivery-claim release and leaves the child turn supervised.
- Racing effects are losers only after their finalizers run. Interruption is masked while installing or
  transferring resource ownership, then restored while waiting on child I/O, deadlines, or delivery.
- Startup (30 seconds), inactivity (5 minutes), turn deadline (30 minutes), and termination grace
  (5 seconds) are named durations evaluated through Effect `Clock`. Each turn also stores its wall-clock
  deadline and checks it after scheduler wake or child activity. Tests advance a test clock; they do not
  sleep in wall time.

The stable application `ManagedRuntime` constructs `SubagentOrchestratorLive` once. Tool and lifecycle
handlers return effects to `makeToolExecutor`/`makeEventHandler`, which provide invocation-specific
`PiCtx` and `Ui` (`src/shared/effect/runtime.ts:13`). They do not create a nested runtime, call
`Effect.runSync`, or convert an effect to a promise before that outer Pi boundary. This keeps session
context per invocation while the per-session scope lets accepted background work outlive the admitting
call; session close either reaps it or retains explicit process-wide cleanup ownership until the OS does.

### Data model and persistence

`taskName` is exact and case-sensitive and must match `/^[A-Za-z0-9_.-]{1,64}$/`. Task names are
unique within a session for the record's lifetime. Each record has an integer `turn`, beginning at
`1` for the initial dispatch and increasing for each accepted completed-agent resume. It stores the
current status, `settledAt`, ordered durable `AgentTurnRecord`s (each pairing that turn's
`PersistedResolvedProfile` with its `AgentResult`), private diagnostic log/session paths, and the
ownership-verified PID identity while live. Public views project results only, never internal turn-profile
pairs, and never expose IDs, paths
other than a completed full-result path, owner session IDs, PIDs, or diagnostics.

An outcome is atomically written by rename before any waiter is resolved or notification is queued.
This is crash durable after a process crash, but makes no `fsync` promise. Its public projection is:

```ts
import { Schema } from 'effect'

export const ToolErrorCodeSchema = Schema.Literals([
  'unknown_profile',
  'duplicate_task_name',
  'capacity_exceeded',
  'missing_provider',
  'missing_model',
  'unavailable_tool',
  'unsafe_tool',
  'startup_timeout',
  'startup_failed',
  'frame_too_large',
  'protocol_error',
  'unknown_agent',
  'empty_targets',
  'duplicate_target',
  'not_ready',
  'follow_up_used',
  'not_resumable',
  'context_limit',
  'agent_failed',
  'turn_timeout',
  'interrupted',
  'result_too_large',
  'session_unavailable',
] as const)

export type ToolErrorCode = typeof ToolErrorCodeSchema.Type

type AgentResult =
  | { task_name: string; turn: number; status: 'completed'; conclusion: string; truncated?: never; full_result_path?: never }
  | { task_name: string; turn: number; status: 'completed'; conclusion: string; truncated: true; full_result_path: string }
  | { task_name: string; turn: number; status: 'failed' | 'interrupted'; error: { code: ToolErrorCode; message: string } }

type Refusal = { error: { code: ToolErrorCode; message: string } }
// The public resolution boundary maps an absent selected model to `missing_model`.
type ProfileResolution =
  | { ok: true; profile: PersistedResolvedProfile }
  | {
      ok: false
      error: {
        code: Extract<ToolErrorCode, 'unknown_profile' | 'missing_provider' | 'missing_model' | 'unavailable_tool' | 'unsafe_tool'>
        message: string
      }
    }

type ProcessIdentity = { pid: number; birth_marker: string } // opaque platform-adapter marker
```

The same `Refusal` shape is used for every refusal. Public error codes are exactly
`unknown_profile`, `duplicate_task_name`, `capacity_exceeded`, `missing_provider`, `missing_model`,
`unavailable_tool`, `unsafe_tool`, `startup_timeout`, `startup_failed`, `frame_too_large`,
`protocol_error`, `unknown_agent`, `empty_targets`, `duplicate_target`, `not_ready`,
`follow_up_used`, `not_resumable`, `context_limit`, `agent_failed`, `turn_timeout`, `interrupted`,
`result_too_large`, and `session_unavailable`. Schema validation errors remain TypeBox/Pi errors. Notification injection failure is
not an agent failure.

All record artifacts, including session, info, log, and full-result files, are created below
`${PI_SUBAGENT_TEMP_DIR ?? tmpdir()}/pi-codex-subagents/<username>/runs` in an owner-only directory
and pruned seven days after `settledAt`. Logs (including stderr) and diagnostics are private. On
startup, an unparseable record is pruned. Each POSIX worker starts as its own process-group leader;
Windows termination targets the process tree best-effort while the worker remains verifiable. The platform adapter captures opaque
`ProcessIdentity` `{ pid, birth_marker }` at spawn: Linux uses boot ID plus `/proc/<pid>/stat` start
ticks, macOS uses `proc_pidinfo(PROC_PIDTBSDINFO)` start seconds plus microseconds through Bun FFI, and
Windows uses the UTC creation timestamp from PowerShell `Get-Process`. It re-reads the same marker before every forced signal
or reap. A stop first sends the protocol `interrupt` frame and waits the common five-second grace. If the
worker remains alive with a matching marker, POSIX invokes `kill(-pid, signal)` for the process group and
Windows invokes `taskkill /PID <pid> /T /F`; failure to read or match the marker signals nothing. Under
the accepted stale-ownership policy, mismatch deletes all artifacts—including prior settled turns in a
resumed record—and releases its task-name and capacity claim.

### Lifecycle and transport

Profile resolution (including canonical `missing_model` where no selected model is available) and closed
config/task pre-encoding precede one session-locked claim of exact task-name uniqueness and capacity. A
session holds at most three worker slots and at most one `implementer` slot; a terminal worker keeps its
slot until verified worker exit or remains charged while the cleanup registry owns that still-live worker. Startup holds an in-memory
reservation plus a private, atomically written launch lease containing the owning session and
`ProcessIdentity`; the lease is not an agent record, listing entry, activity entry, or durable turn.
Startup reaping uses the lease to stop an ownership-verified child after a parent crash. The child must
send a valid `ready` frame within 30 seconds; `ready` means its initial task has started without an
immediate error. Readiness atomically replaces the launch lease with the public/durable running record.
An oversized frame detected before spawn deletes provisional artifacts, releases name/capacity, and
returns `frame_too_large`. Initial pre-ready failure, timeout, or caller cancellation returns its refusal
without creating a public record or notice, then makes every bounded cleanup attempt. Verified worker exit
removes the private lease and releases name/capacity; a still-live worker instead moves with its lease and
claims to the stable cleanup registry until observed exit. Caller cancellation linearizes against readiness
under the session lock. If cancellation wins, both foreground and background spawn follow that same private
cleanup path. If readiness wins, background spawn is
accepted and remains in the session scope even if response delivery is then cancelled; foreground spawn
keeps the admitted child running, releases its settlement claim to the notice queue, and returns no
result to the cancelled caller. A background spawn returns only after readiness:

```ts
{ task_name, profile, turn: 1, status: 'running' }
```

A foreground spawn waits for and returns its `AgentResult`. Both the 30-second startup timer and the
30-minute per-turn timer start when the task is dispatched, so they overlap during startup. Every
initial or resumed turn is one process. A completed-agent resume likewise starts provisionally: before
its new `ready`, the prior durable history remains intact, the send allowance is not consumed, and it
returns `startup_timeout`, `startup_failed`, or `frame_too_large` as applicable; it never deletes the
prior agent. Only `ready` creates/marks the new running turn and consumes the allowance. The 30-minute clock is monotonic and steering never resets
it. A uniform five-second termination grace applies after an outcome, timeout, interrupt, protocol
failure, or startup failure before force termination of an ownership-verified process.

Child stdin/stdout uses strict-LF JSONL lifecycle/control frames, each bounded to 1 MiB including its
single trailing `\n`; CRLF, unterminated input at EOF, duplicate configuration, unknown fields, and any
frame outside its state are protocol errors. Before `task`, stdin carries exactly one `config` frame at
protocol version 1. It contains closed, JSON-serializable `WorkerConfig`, owner-only run directory, and the create expected
session directory or exact canonical open path; no sensitive setup is in argv. The child inherits the parent
environment after all `PI_SUBAGENT*` values are replaced with its own identity and optional
`PI_SUBAGENT_READONLY=1` posture marker. Every config,
task, and steer frame is JSON-encoded with escaping and its LF before
spawn/write; if encoded bytes exceed 1 MiB, `frame_too_large` refuses before any capacity or send allowance
is consumed. Config-generation failure is likewise pre-start. Concrete frames are:

```ts
type ParentConfigFrame = {
  type: 'config'
  version: 1
  agent_id: string
  turn: number
  run_dir: string
  session: { mode: 'create'; expected_dir: string } | { mode: 'open'; canonical_path: string }
  worker: WorkerConfig
} // closed JSON schema; unknown fields rejected
type ParentTaskFrame = { type: 'task'; agent_id: string; turn: number; command_id: string; message: string }
type ParentSteerFrame = { type: 'steer'; agent_id: string; turn: number; command_id: string; message: string }
type ParentInterruptFrame = { type: 'interrupt'; agent_id: string; turn: number; command_id: string }
type ChildReadyFrame = { type: 'ready'; agent_id: string; turn: number; command_id: string; session_path: string }
type ChildProgressFrame = {
  type: 'progress'
  agent_id: string
  turn: number
  command_id: string
  activity: 'agent_started' | 'assistant_activity' | 'tool_started' | 'tool_finished'
}
type ChildSteerAckFrame = { type: 'steer_ack'; agent_id: string; turn: number; command_id: string }
type ChildCommandErrorFrame =
  | {
      type: 'command_error'
      agent_id: string
      turn: number
      command_id: string
      code: 'queue_rejected'
      status: 'running'
      error: string
    }
  | {
      type: 'command_error'
      agent_id: string
      turn: number
      command_id: string
      code: 'turn_settled'
      status: 'completed' | 'failed' | 'interrupted' // the actual winning terminal status
      error: string
    }
type ChildResultFrame =
  | {
      type: 'result'
      agent_id: string
      turn: number
      command_id: string
      status: 'completed'
      conclusion: string // UTF-8 <= 50 KiB and <= 2,000 lines
      conclusion_preview?: never
      conclusion_artifact?: never
      conclusion_bytes?: never
    }
  | {
      type: 'result'
      agent_id: string
      turn: number
      command_id: string
      status: 'completed'
      conclusion?: never
      conclusion_preview: string // bounded UTF-8 preview: <= 50 KiB and <= 2,000 lines
      conclusion_artifact: string // relative owner-only artifact
      conclusion_bytes: number // UTF-8 byte count, > 50 KiB and <= 10 MiB
    }
  | {
      type: 'result'
      agent_id: string
      turn: number
      command_id: string
      status: 'failed'
      error: { code: 'agent_failed' | 'result_too_large'; message: string }
    }
  | {
      type: 'result'
      agent_id: string
      turn: number
      command_id: string
      status: 'interrupted'
      error: { code: 'interrupted'; message: string }
    }
```

The worker entrypoint is a package distribution artifact, not a repository-relative development path;
its launcher resolves that artifact from its own `import.meta.url` and invokes it through the current Bun
executable. The worker state machine is `awaiting_config → awaiting_task → starting → running → settled → exiting`.
It accepts concurrent stdin while running: matching `steer` commands queue into the SDK only while running,
and `interrupt` requests abort. In create mode the worker first creates a unique owner-only empty file beneath
`expected_dir` with exclusive creation, opens it through `SessionManager.open`, and requires the SDK to
materialize its session header there; open mode uses only `canonical_path`. `ready` is emitted only after that
file exists, prompt preflight, and `agent_start` acceptance. The parent opens and validates the returned
owner-only regular non-symlink path before readiness commit: create must be beneath configured
`expected_dir`; open must equal configured `canonical_path`. `progress` is bounded synthetic
metadata only—never reasoning, assistant text, tool arguments, or tool output. `steer_ack` is emitted only
after successful SDK queueing and echoes the steer command ID. An expected queue rejection emits correlated `command_error(queue_rejected)` with that ID; only the matching
positive ack consumes the lifetime allowance. If settlement wins first, the pending steer receives
`command_error(turn_settled)` with the actual terminal status and consumes nothing; if ack wins, its allowance
remains consumed even if `result` follows immediately. Process failure or malformed, missing, or mismatched
ack instead wins normal settlement as failed `AgentResult` (`agent_failed` or `protocol_error`), never
`CommandError` or a refusal. `result` is emitted only on
`agent_settled`, with final assistant text in SDK order. `ready`, `progress`, and the single terminal `result`
always echo the active task's `command_id`. A steer acknowledgement or command error echoes that steer
command's ID. Interrupt has no separate acknowledgement: whether task settlement or interrupt wins, the
terminal result still echoes the task ID, and the parent correlates the synchronous interrupt by its reserved
turn claim. Interrupt suppresses an aborted partial success and emits an explicit interrupted/failed outcome
instead. Every response must also match the dispatched `agent_id` and `turn`; `ready` means the task has
started. A frame outside these discriminated shapes is
malformed: before readiness it is `startup_failed`, while after readiness it settles the turn with
`protocol_error`. A completed conclusion is inline only at UTF-8 <=50 KiB and <=2,000 lines. Above that inline limit and at
most 10 MiB UTF-8, the worker writes an owner-only artifact beneath `run_dir` and sends a bounded (UTF-8
<=50 KiB and <=2,000 lines) preview, relative name, and exact byte count; above 10 MiB it settles failed
`result_too_large`. The parent opens the relative artifact with a descriptor-based no-follow operation, then
on that opened descriptor verifies a regular owner-only file and canonical containment beneath `run_dir`.
It boundedly copies <=10 MiB from that same descriptor into the store (and verifies the declared byte count),
never reopening by path. Any validation, read, or race failure settles `failed` with `agent_failed`; an
observed size above 10 MiB settles `failed` with `result_too_large`. The JSON record retains only
metadata/path, never full text, and normal `AgentResult`/`full_result_path` behavior applies. Only a complete
transcript entry or valid lifecycle/progress frame resets the once-per-turn
five-minute inactivity timer; stderr and raw bytes do not. At expiry the sidebar reads `inactive 5m`,
and a one-shot assistant notice is placed on the normal safe-boundary queue; it is an event, not an
ambient UI surface, and neither claims nor settles delivery:

```text
Sub-agent <name> has produced no verified progress for 5 minutes; it is still running.
```

One outcome wins per turn. The winning outcome is persisted in ordered turn order by atomic rename, then
the engine requests cooperative exit and waits the five-second grace before any marker-verified forced tree
termination. Process state and capacity remain held through the bounded cleanup attempt. Verified worker exit releases
them even if descendants may have escaped; a still-live worker that cannot be terminated moves to the stable
cleanup registry with its capacity claim. Waiter and notification delivery then receive the already durable
outcome without waiting on later cleanup retries. Process exit, timeout, malformed frames, child failure, and interrupt race through that single claim; an oversized
frame is `frame_too_large` both before and after readiness, while other framing failures are `protocol_error`;
later events cannot overwrite it. A timeout settles `failed` with `turn_timeout`; an explicit
interrupt settles `interrupted` with its `interrupted` error. A foreground spawn's existing waiter remains its settlement owner. Cancellation of a foreground
spawn waiter or an omitted wait before settlement atomically releases its claims to the in-memory
notice queue; cancellation after delivery commit does not replay them.

`interrupt_agent` on a ready `running` agent atomically reserves the active turn's delivery claim before it
signals, then waits through the bounded cleanup attempt and returns the durable interrupted `AgentResult`.
Verified worker exit releases capacity; registry handoff returns while the still-live worker remains charged;
against a provisional `starting` launch it refuses `not_ready`, does not signal/cancel it, and creates no
public record. Internal session close and panic may still terminate and clean provisional leases; this is not
a public interrupt outcome.
its return is that turn's sole automatic delivery route. On an already settled agent it returns
`{ task_name, turn, status, interrupted: false }`. If caller cancellation abandons the reserved claim
before settlement, it returns to the notice queue. Session panic is separate and suppression-only: it
suppresses only outcomes panic itself creates, and pre-existing queued notices survive it.

### Waiting, reading, and delivery

Each durable settlement is then represented by an in-memory queued notice until a claimant takes it;
there is no durable notice queue. At invocation, omitted `wait_agent`
snapshots only currently queued undelivered settlement notices and currently live eligible unclaimed turns. It
claims the earliest queued notice (FIFO by `settledAt`, then record ID), otherwise waits only for one
of those snapshot live turns; if neither exists it immediately returns `empty_targets`. It never awaits
future-created work, so its bound is those turns' existing deadlines. With explicit targets, the array
must be nonempty, unique, and known. It observes each target's newest turn at invocation, selecting
the earliest settled result by `settledAt`, then task name. Explicit targeted waits are repeatable
reads and do not consume their result.

`wait_all_agents` follows the same validation. Explicit targets are nonempty, unique, and known;
validation/refusal is atomic and results are returned in input order. Omitted targets snapshot only
queued settlement notices and currently live eligible unclaimed current-session
background turns, return `empty_targets` immediately when that snapshot is empty, and otherwise wait
only through those turns' deadlines and return task-name order. Explicit `[]`, duplicate, or unknown
targets return respectively `empty_targets`, `duplicate_target`, or `unknown_agent`, atomically. Explicit
targeted waits are non-claiming reads of the turn's shared settlement and therefore never conflict with
foreground, omitted-wait, notification, resume, interrupt, or another targeted waiter. A waiting call may steal a queued notice until it commits delivery by
beginning host injection; abandonment before that commit returns it to the queue.

Queued settlement and warning notices share one tagged FIFO and are batched once through
`pi.sendUserMessage`: normal delivery while the parent is idle and `{ deliverAs: 'steer' }` while it runs.
Warning notices are injection-only: waits skip them, they do not make an omitted wait snapshot nonempty,
and they remain queued in FIFO order for host delivery. The 50 KiB or
2,000-line ceiling applies to the entire batch, including instructions to use `list_agents` for
omitted tasks and `read_agent_response` for detail. There is one injection attempt. Abandonment before
beginning that attempt requeues the notice; beginning it commits delivery, and either success or failure
consumes it. Failure drops the notice but
retains its durable result, and restart never replays notices. Completed conclusions
use the same 50 KiB/2,000-line inline cap and set `truncated: true` with `full_result_path` when cut.

`list_agents` takes no arguments and returns current-session entries only with
`task_name`, `profile`, `status`, `current_turn`, and `follow_up_available`. `follow_up_available` is true
only when the lifetime send allowance is unused, the record belongs to the current live session generation,
the profile key still exists, and status is `running` or `completed`. It does not promise dynamic
provider/model/context/capacity admission success. It is false after restart or for a stale generation, a
used allowance, a removed profile, or `failed`/`interrupted` status. `read_agent_response`
takes a target and returns only `task_name`, `profile`, `status`, and ordered turns. Neither tool has
cross-session fields.

### Follow-up routing

`send_message(target, message)` permits exactly one successfully accepted call for the agent's
lifetime. A `starting` agent refuses `not_ready` without consuming it. A `running` agent sends steering
with a fresh command identity and returns `SteeringAck` only after the matching `steer_ack`, or a correlated
`CommandError`: `queue_rejected` retains status `running`, while result-first returns `turn_settled` with the
winning terminal status. Only the positive acknowledgement consumes the allowance. Malformed, missing, or
mismatched acknowledgement and process failure instead settle and return failed `AgentResult`
(`protocol_error` or `agent_failed`), never a refusal. Ack-first consumes even when the result is already
available. That acceptance does not claim or settle the turn's delivery, and does not reset the deadline:
an existing foreground waiter remains owner; otherwise eventual settlement is notification-eligible and
claimable. A `completed` agent freshly resolves its profile against
the parent's current model; a removed profile yields `unknown_profile`. It checks capacity and measures projected context
including the proposed message and the model's maximum-output reserve (8,192 tokens when unavailable).
If context cannot be measured or `projected >= ceiling`, it refuses `context_limit` without consumption.
Its accepted resume provisionally dispatches and reserves synchronous delivery, returning the next-turn
`AgentResult` only after readiness commits consumption. Caller cancellation before that reserved claim
settles returns it to the notice queue. Validation or transport failure before acceptance does not consume
the allowance. Only completed-agent resume and explicit API interrupt reserve synchronous delivery.
`failed`, `interrupted`, restarted, or already-used agents refuse (`not_resumable` or
`follow_up_used` as applicable).

### Error handling

Missing provider/model, unavailable or unsafe tools, and unknown profiles refuse before admission.
A profile is `unsafe_tool` when its maintainer configuration requests an operator, delegation, or
unclassified tool; profile removal before resume is `unknown_profile`. Parent-origin protocol and process
settlements retain their parent-selected codes (for example `protocol_error`, `frame_too_large`, or
`agent_failed`); child result frames can report only their bounded structured terminal codes.
Malformed or other framing errors after readiness settle the active turn as `failed` with
`protocol_error`; oversized frames settle it with `frame_too_large`; child-reported failure and
post-ready process, storage, or record-read failure use `agent_failed`. Pre-ready host failure uses
`startup_failed`; startup failure and startup timeout are refusals only, not durable settlements.
Notification failure is logged and consumed. Cleanup catches and records each failure in private diagnostics while continuing every remaining release; a still-live process and lease move to the stable cleanup registry for retry/reaping, and the failure cannot replace the winning result.
Retention never prunes a live record. All operations filter to the current session before target lookup.

### Verification contracts

Focused tests must establish these design contracts, rather than merely exercise happy paths:

- Atomic concurrent admission of the same task name admits exactly one child; concurrent capacity and
  single-`implementer` races never exceed their limits and leave no losing durable/public record.
- Two concurrent sends race to one accepted send only. Running steering returns `SteeringAck` only after
  matching `steer_ack`; a matching `command_error` is correlated negative response and consumes nothing.
  Ack/result races linearize at the positive ack: result-first returns the negative response, ack-first
  consumes one send. Acceptance preserves a foreground waiter and leaves otherwise eventual settlement
  notification-eligible/claimable. Explicit interrupt and
  completed resume reserve synchronous delivery, and cancellation before settlement requeues that claim.
- Initial and resumed startup each require `ready` within 30 seconds. Fault injection after capacity
  claim, spawn, identity capture, and lease write proves each installed release runs and leaves no public
  record; successful termination removes the lease/claims, while injected termination failure hands the
  still-live worker, private lease, name, and capacity to stable cleanup until observed exit. Parent-channel
  EOF terminates a child if the parent crashes before lease durability; after lease durability, startup
  reaping stops only an ownership-verified process. Cancellation racing readiness proves the losing
  pre-ready launch follows the same private cleanup rule, while a readiness winner remains admitted under
  the background/foreground delivery rules. Resumed pre-ready cleanup preserves all
  prior turns and the send allowance; `ready` commits the new running turn and consumes that allowance.
- Wait-vs-injection arbitration requeues only abandonment before beginning host injection; an attempted
  native injection, including failure, drops its notice while durable reads remain. Omitted waits use
  only their invocation snapshot, immediately refuse `empty_targets` when empty, and never observe a
  later-created turn.
- A public interrupt against a provisional `starting` launch returns `not_ready`, does not cancel the
  launch or create a record, while internal close/panic still cleans its lease. A synchronous ready-running
  interrupt races panic deterministically: the explicit interrupt retains its claimed result, while panic
  suppresses only results it itself creates and never erases an earlier notice. Cancellation of a foreground
  spawn or omitted wait before settlement returns every abandoned claim to the notice queue; cancellation
  after delivery commit never replays it.
- At exactly 30 minutes the engine requests termination; settlement occurs after exit or at most five
  seconds later after force termination. Steering never resets either bound. Result frames with the
  wrong discriminant payload are `startup_failed` before readiness and `protocol_error` afterwards.
- Restart reaping prunes expired/unparseable settled artifacts, interrupts verified orphans, and re-reads
  process identity before every signal/reap; a PID/birth-marker mismatch signals nothing while deleting
  stale artifacts/releases claims. Retention removes every settled artifact after seven days but never a
  live record.
- Closed strict-LF config and task/steer frames are pre-encoded including JSON escaping and LF; over-1 MiB
  or config-generation failures refuse `frame_too_large` pre-start/pre-write without capacity or send
  consumption. Unknown fields and invalid transitions fail as specified. Progress contains no private SDK
  content, ready follows prompt preflight/`agent_start`, and result follows only `agent_settled`. Command-error
  frames require `running` for `queue_rejected` and the actual terminal status for `turn_settled`; result
  frames reject mixed inline/artifact fields and invalid child terminal error codes. Ready-path tests reject
  symlink/non-regular/escaping create paths and non-identical open paths before commitment. Inline conclusion
  boundaries are UTF-8 50 KiB/2,000 lines; descriptor-based no-follow artifact opening verifies the opened
  regular owner-only file and canonical containment, then copies <=10 MiB from that same descriptor;
  validation, read, and race failures settle `agent_failed`, while oversize settles `result_too_large`.
  A packed-install smoke test launches
  the worker using current Bun and `import.meta.url`, completes config/task/ready/result, and needs no source
  tree. Boundary tests also cover context equality, deadline preservation, PID mismatch, and the one-shot
  inactivity warning.
- The same contracts run against synthetic `SubagentStore`, `ChildProcess`, `NotificationSink`,
  `AgentActivity`, and clock layers. Controlled `Deferred`s select the winner in exit/timeout/interrupt
  races; advancing the test clock proves all four time bounds. Closing one of two session scopes proves
  only its children are identity-verified, terminated, removed from activity/capacity, and durably
  settled; layer disposal closes both. Close-vs-spawn and close-vs-ready races prove no readiness commit
  enters a closing/closed or replacement generation. Injected cleanup failures prove every release is
  attempted, a still-live process remains tracked for retry/reaping, `closeSession` reports the failure,
  and cleanup cannot replace the first outcome. No focused engine test spawns a real child, touches the
  real temporary directory, or waits on wall time.

## 9. Open Questions

N/A.

## Changelog

| Date       | Amendment                                                                                                                                                                                                                                | Sections affected | Reason                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| 2026-08-21 | Amend durable result schemas, provisional readiness, bounded wait snapshots, delivery arbitration, limits, and verification contracts without renumbering decisions                                                                      | 3, 5, 6, 8        | Incorporate the settled public API and lifecycle safety rules while retaining stable IDs                           |
| 2026-08-22 | Specify the per-session scoped Effect service, injected host ports, nested resource acquisition, schema-tagged failures, runtime boundary, and deterministic test layers.                                                                | 3, 6, 8           | Make lifecycle ownership and Effect.ts implementation constraints explicit before planning.                        |
| 2026-08-22 | Resolve the redacted profile/private config split, closed config and session-path validation, frame pre-encoding, exact command-error winners, bounded result artifacts, session-unavailable mapping, and packed-install smoke contract. | 3, 8              | Make worker privacy, ordering, and durability definitive.                                                          |
| 2026-08-24 | Specify inherited child environment plus cooperative interruption followed by platform-marker-verified process-group/tree termination.                                                                                                   | 3, 8              | Remove custom credential transport and make the bounded stop/reap mechanism executable on each supported platform. |
| 2026-08-24 | Materialize created session files before readiness, define command-ID ownership, use high-resolution macOS process identity, and retain capacity until verified process-tree exit.                                                       | 3, 8              | Close readiness, correlation, PID reuse, and live-capacity races found during final plan review.                   |
| 2026-08-24 | Bound guaranteed ownership/capacity to the worker, return interrupts after bounded cleanup or registry handoff, and make descendant cleanup best-effort only while the worker marker remains verifiable.                                 | 3, 6, 8           | Resolve the post-worker group-reuse hazard without adding a supervisor process.                                    |
| 2026-08-24 | Retain the private launch lease, name, and capacity after pre-ready failure/cancellation when bounded cleanup hands a still-live worker to the registry.                                                                                 | 8                 | Preserve restart reaping evidence and worker limits without exposing a public pre-ready agent.                     |
| 2026-08-24 | Pass immutable invocation admission snapshots into spawn/send and remove `wait_conflict` because explicit targeted waits are non-claiming repeatable reads.                                                                              | 3, 8              | Give profile resolution a concrete current-host data path and delete an unreachable refusal branch.                |
| 2026-08-24 | Tag inactivity warnings as injection-only and exclude them from omitted wait snapshots.                                                                                                                                                  | 3, 8              | Preserve the `AgentResult`-only wait contract while sharing notification FIFO ordering.                            |
| 2026-08-25 | Enter session lifecycle through the feature descriptor's `activate`/`deactivate` rather than a self-registered session-start hook.                                                                                                       | 8                 | The feature coordinator now owns host session start, replacement, and shutdown.                                    |
| 2026-08-25 | Record deferred implementation verification and the Windows platform exclusion.                                                                                                                                                          | 5, 6              | Keep verification coverage and supported-platform limits beside the orchestration contract.                        |
