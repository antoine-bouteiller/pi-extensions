---
title: Delegation tools
status: amended
author: Antoine Bouteiller
date: 2026-08-17
parent-spec: src/features/sub_agents/spec/sub-agents.spec.md
---

## 2. Problem Statement

The assistant reaches delegation through tools, and the shape of those tools decides whether it
delegates well: waiting by default, avoiding overlap with pending children, and preferring a fresh
child to a long conversation. This component is the adapter between the host session and the
orchestration engine, and it owns the guidance that makes the assistant use the tools as designed
(`[G-1]`, `[G-3]`).

Goals are owned by the umbrella.

## 3. Key Design Decisions

| Decision                    | Choice                                                                                                                                                                                                                                | Rationale                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[KD-1]` Tool set           | Seven tools: `spawn_agent`, `wait_agent`, `wait_all_agents`, `list_agents`, `read_agent_response`, `send_message`, `interrupt_agent`                                                                                                  | One tool per intent the assistant actually has; collapsing the waits into one tool would hide the difference between the next result and all results      |
| `[KD-2]` Mode parameter     | `spawn_agent` waits unless `run_in_background` is set (`[KD-3]` of the umbrella), and the guidance encourages the waiting mode                                                                                                        | The default must be the safe mode, and a single boolean keeps the choice visible in the call rather than buried in prose                                  |
| `[KD-3.1]` Announcements    | An unclaimed settlement is FIFO-batched for one `pi.sendUserMessage` attempt: normal delivery while idle and `{ deliverAs: 'steer' }` while the parent runs. Invocation commits delivery; failure drops its notice but not its record | The public Pi API supplies the supported idle/steering boundary without inventing a private host hook, while durable inspection survives delivery failure |
| `[KD-4]` Guidance injection | Delegation guidance is appended to the parent's instructions                                                                                                                                                                          | Tool descriptions alone do not convey policy like "do not duplicate a pending child's work"                                                               |
| `[KD-5]` Result shape       | `AgentResult` uses snake_case task identity, integer turn, terminal status, conclusion or structured error, and optional truncation path                                                                                              | A caller can distinguish a completed conclusion, failed/interrupted error, and durable full result without guessing                                       |
| `[KD-6]` Session scope      | Every tool, reading or mutating, resolves targets within the current session only (`[KD-1]` of the umbrella)                                                                                                                          | A listing the assistant can see but the operator cannot is a surface with no accountable owner                                                            |
| `[KD-8]` Child suppression  | The seven tools do not register when the process's environment marks it as a subagent                                                                                                                                                 | This independently enforces flat topology (`[NG-1]` of the umbrella), while the profile allow-list controls every other child tool                        |

## 4. Principles & Intents

- `[PI-1]` The tool schema is the documentation — refines umbrella `[PI-5]`: limits the engine enforces
  are stated in the schema the assistant reads, so most refusals never happen.

## 5. Non-Goals

- `[NG-1]` A tool that lets a child ask the parent or the operator for anything — refines umbrella
  `[NG-7]`; the channel runs one way.
- `[NG-2]` Any cross-session parameter on any tool — refines umbrella `[NG-5]`.

## 6. Caveats

- `[C-1]` Guidance text competes for the parent's instruction budget, so it stays at the length needed
  to convey policy and no more.
- `[C-2]` Announcement delivery depends on the host accepting injected session content while a turn is
  in flight.

## 7. High-Level Components

N/A — the component inventory is owned by the umbrella.

## 8. Detailed Design

### API surface

One factory builds the feature and one registration wires lifecycle hooks, seven tools, and completion
rendering. The operator leaf owns command registration. Registration is skipped when `PI_SUBAGENT=1`.
Schemas target task names only, have no session selector, and validate `task_name` exactly and
case-sensitively. TypeBox/Pi reports schema errors; uniqueness remains runtime-validated because it is
not a JSON-schema array constraint:

```ts
const TaskNameSchema = Type.String({ pattern: '^[A-Za-z0-9_.-]+$', minLength: 1, maxLength: 64 })
const TargetsSchema = Type.Array(TaskNameSchema, { minItems: 1 }) // uniqueness checked at runtime

type TaskName = string // exactly /^[A-Za-z0-9_.-]{1,64}$/
type ProfileKey = 'scout' | 'librarian' | 'reviewer' | 'implementer'
type ToolErrorCode =
  | 'unknown_profile'
  | 'duplicate_task_name'
  | 'capacity_exceeded'
  | 'missing_provider'
  | 'missing_model'
  | 'unavailable_tool'
  | 'unsafe_tool'
  | 'startup_timeout'
  | 'startup_failed'
  | 'frame_too_large'
  | 'protocol_error'
  | 'unknown_agent'
  | 'empty_targets'
  | 'duplicate_target'
  | 'not_ready'
  | 'follow_up_used'
  | 'not_resumable'
  | 'context_limit'
  | 'agent_failed'
  | 'turn_timeout'
  | 'interrupted'
  | 'result_too_large'
  | 'session_unavailable'
type Refusal = { error: { code: ToolErrorCode; message: string } }
type AgentResult =
  | { task_name: TaskName; turn: number; status: 'completed'; conclusion: string; truncated?: never; full_result_path?: never }
  | { task_name: TaskName; turn: number; status: 'completed'; conclusion: string; truncated: true; full_result_path: string }
  | { task_name: TaskName; turn: number; status: 'failed' | 'interrupted'; error: { code: ToolErrorCode; message: string } }

type SpawnAgentInput = {
  task_name: TaskName
  agent_type: ProfileKey
  message: string
  run_in_background?: boolean // false by default
}
type WaitAgentInput = { targets?: TaskName[] }
type WaitAllInput = { targets?: TaskName[] }
type ListAgentsInput = Record<string, never> // no arguments
type ReadAgentResponseInput = { target: TaskName }
type SendMessageInput = { target: TaskName; message: string }
type InterruptAgentInput = { target: TaskName }

type RunningAcceptance = { task_name: TaskName; profile: ProfileKey; turn: number; status: 'running' }
type SteeringAck = { task_name: TaskName; turn: number; status: 'running'; accepted: true }
type CommandError =
  | { task_name: TaskName; turn: number; status: 'running'; accepted: false; error: { code: 'queue_rejected'; message: string } }
  | {
      task_name: TaskName
      turn: number
      status: 'completed' | 'failed' | 'interrupted'
      accepted: false
      error: { code: 'turn_settled'; message: string }
    }
type WaitAllOutput = { results: AgentResult[] } | Refusal
type AgentListEntry = {
  task_name: TaskName
  profile: string // historical retained records may name a removed profile
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  current_turn: number
  // True only for an unused allowance on this live generation with an existing profile and running/completed status.
  // It does not guarantee dynamic provider/model/context/capacity admission.
  follow_up_available: boolean
}
type ListOutput = { agents: AgentListEntry[] } | Refusal
type ReadOutput =
  | {
      task_name: TaskName
      profile: string // historical retained records may name a removed profile
      status: 'running' | 'completed' | 'failed' | 'interrupted'
      turns: AgentResult[] // strictly ascending turn order
    }
  | Refusal
type SettledInterruptNoop = {
  task_name: TaskName
  turn: number
  status: 'completed' | 'failed' | 'interrupted'
  interrupted: false
}

type SpawnAgentOutput = AgentResult | RunningAcceptance | Refusal
type WaitAgentOutput = AgentResult | Refusal
type SendMessageOutput = SteeringAck | CommandError | AgentResult | Refusal
type InterruptAgentOutput = AgentResult | SettledInterruptNoop | Refusal
```

| Tool                  | Input                    | Result                                                                  |
| --------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `spawn_agent`         | `SpawnAgentInput`        | `SpawnAgentOutput`; background is `RunningAcceptance` only after ready. |
| `wait_agent`          | `WaitAgentInput`         | `WaitAgentOutput`.                                                      |
| `wait_all_agents`     | `WaitAllInput`           | `WaitAllOutput`.                                                        |
| `list_agents`         | `ListAgentsInput`        | `ListOutput`; no arguments and current-session entries only.            |
| `read_agent_response` | `ReadAgentResponseInput` | `ReadOutput`.                                                           |
| `send_message`        | `SendMessageInput`       | `SendMessageOutput`.                                                    |
| `interrupt_agent`     | `InterruptAgentInput`    | `InterruptAgentOutput`.                                                 |

`agent_type` is a JSON Schema string `enum` over the profile keys so callers and validation errors see the
accepted values. Its description is `key: description` pairs joined by `; ` in the order below:

| Profile       | Description                                                                                |
| ------------- | ------------------------------------------------------------------------------------------ |
| `scout`       | Quick codebase exploration and focused implementation reconnaissance — read-only by policy |
| `librarian`   | Cited web and remote-system research — read-only by policy                                 |
| `reviewer`    | Read-only plan and implementation review                                                   |
| `implementer` | Scoped code implementation and verification — write-capable                                |

Profile names and descriptions come from the profiles component so the schema and accepted set cannot
drift.

Representative calls and results:

```json
{"task_name":"inspect-cache","agent_type":"scout","message":"Trace cache invalidation."}
{"task_name":"inspect-cache","turn":1,"status":"completed","conclusion":"Invalidation starts in CacheStore.clear()."}

{"task_name":"check-docs","agent_type":"librarian","message":"Verify the API contract.","run_in_background":true}
{"task_name":"check-docs","profile":"librarian","turn":1,"status":"running"}
```

### Interactions

The adapter holds no lifecycle state: at each spawn/send invocation it snapshots current cwd, configured
agent directory, project trust, parent model, registered tool names, and string environment values for the
engine's admission decision, then delegates the call. It injects unclaimed current-session background
settlements through `pi.sendUserMessage`. It calls normal delivery while
`ctx.isIdle()` and `{ deliverAs: 'steer' }` otherwise. At invocation, an omitted-target
`wait_agent` snapshots only queued undelivered settlement notices and currently live eligible unclaimed
turns; injection-only inactivity warnings are skipped and do not make the snapshot nonempty.
It claims the earliest queued notice (FIFO `settledAt`, then ID), otherwise waits only for a turn in
that snapshot; an empty snapshot immediately returns `empty_targets`. It never awaits future-created
work, and is bounded by its snapshot turns' deadlines. Explicit targets must be nonempty, unique,
known, and observe their newest turn at invocation; they select earliest `settledAt`, then task name,
and are repeatable reads. `wait_all_agents` has the same atomic validation: explicit results retain
input order; omitted targets snapshot only queued settlement notices and currently live eligible unclaimed
current-session background turns, return `empty_targets` when empty, and otherwise return task-name
order after only those snapshot turns settle. `[]`, duplicates, or unknown names refuse atomically with
`empty_targets`, `duplicate_target`, or `unknown_agent`. Explicit targeted waits are non-claiming,
repeatable reads and never conflict with any delivery owner or another targeted waiter.

After a settlement is durably recorded, an in-memory queued notice is FIFO-batched once at a safe
boundary; there is never a durable notice queue. The entire batch is capped at 50 KiB or 2,000 lines,
including directions to use `list_agents` for omitted tasks and `read_agent_response` for details. There
is one `pi.sendUserMessage` attempt. Abandonment before invoking the host method requeues a stolen
notice; invocation commits delivery, and return or throw consumes it. Failure drops the notice but retains its durable result, and restart does not replay it. A
wait can steal a queued notice until injection commits. A result inline delivery uses the same cap, sets
`truncated: true`, and supplies `full_result_path` for the full text. The inactivity warning is a one-shot
event on this normal safe-boundary queue, not an ambient UI surface; it neither claims nor settles an
agent result, and waits never claim or return it. It is injected exactly as:

```text
Sub-agent <name> has produced no verified progress for 5 minutes; it is still running.
```

The parent guidance is exactly:

```text
Delegate narrow, self-contained errands whose intermediate context need not remain
in the parent conversation. Foreground is the default. Use background execution
only for clearly independent work, and never duplicate work assigned to a pending
child. A session may have at most three live children and one live implementer.
Each child accepts at most one follow-up message and each turn ends after 30
minutes. Prefer a fresh child for distinct work. Only the child’s conclusion is
returned; use the inspection tools for durable results and conversations.
```

In that fixed guidance, “inspection tools” means the delegation inspection workflow: tool calls expose
durable results, while the `/subagents` operator surface exposes persisted conversations. No delegation
tool returns a transcript or its private session path.

At registration, `PI_SUBAGENT=1` skips both tool registration and this guidance. The child launcher
enables only resolved profile tools; no other host tool is available to the child.

### Follow-up and interruption

`send_message` permits exactly one successfully accepted call for an agent's lifetime. `starting`
returns `not_ready` without consumption. `running` sends steering and returns `SteeringAck` only after
the child returns a matching `steer_ack`, or a correlated `CommandError`: `queue_rejected` is `running`,
while result-first returns `turn_settled` with its actual terminal status. Only the positive acknowledgement
consumes the allowance. Missing/mismatched acknowledgement or process failure settles and returns failed
`AgentResult` (`protocol_error` or `agent_failed`), never `CommandError` or a refusal. Ack-first consumes
even when the result is immediately available. A positive acceptance neither claims nor settles the active
turn and does not reset its 30-minute deadline. An existing foreground waiter remains owner; otherwise the
eventual settlement is notification-eligible and claimable. `completed` freshly
resolves the profile against the parent's current model (a removed profile is `unknown_profile`; no
selected model is canonical `missing_model`), checks capacity and projected context including the message
and model maximum-output reserve (8,192-token fallback), then dispatches provisionally. At
`projected >= ceiling` (or if unmeasurable) it returns `context_limit`. Before its 30-second `ready`,
previous durable turns remain and the send is not consumed; after ready it creates/marks the new running
turn, consumes, reserves synchronous delivery, waits, and returns its `AgentResult`. Caller cancellation
before this reserved claim settles returns it to the notice queue. Only completed-agent resume and
explicit API interrupt reserve synchronous delivery. Validation or transport failure before acceptance
does not consume. `failed`, `interrupted`, restarted, and already-used targets refuse with `not_resumable`
or `follow_up_used`. `follow_up_available` is true only while the lifetime send allowance is unused,
the record belongs to the current live session generation, its profile key still exists, and its status is
`running` or `completed`. It is false after restart/stale generation, a used allowance, a removed profile,
or `failed`/`interrupted`; it does not promise later provider, model, context, or capacity success.

Interrupting a ready `running` agent reserves/claims active-turn delivery before signalling, then waits
through the bounded cleanup attempt and returns the durable interrupted settlement as its sole automatic
route. Verified worker exit releases capacity; if a still-live worker is handed to the cleanup registry, the
call returns while that worker remains charged against capacity. Public `interrupt_agent` against provisional `starting` returns `not_ready`: it neither
cancels the launch nor creates a record. Internal session close/panic may still clean a provisional launch
lease. Caller cancellation before settlement returns the ready-running claim to the notice queue. Panic is
separate and suppression-only: it suppresses only outcomes it causes and does not erase prior queued notices.

### Error handling

`ToolErrorCode` is the canonical public error-code union: exactly `unknown_profile`,
`duplicate_task_name`, `capacity_exceeded`, `missing_provider`, `missing_model`, `unavailable_tool`,
`unsafe_tool`, `startup_timeout`, `startup_failed`, `frame_too_large`, `protocol_error`, `unknown_agent`,
`empty_targets`, `duplicate_target`, `not_ready`, `follow_up_used`, `not_resumable`,
`context_limit`, `agent_failed`, `turn_timeout`, `interrupted`, `result_too_large`, and
`session_unavailable`. A profile is `unsafe_tool` when its
maintainer configuration requests an operator, delegation, or unclassified tool.

The engine starts its 30-second startup and 30-minute turn clocks on dispatch; readiness means the
initial task started with no immediate error. Initial pre-ready failure or timeout is a refusal with no
public agent. Successful worker termination removes its private lease and releases name/capacity; a
still-live worker moves with its lease and claims to stable cleanup until observed exit. Resume also
requires ready within 30 seconds: pre-ready refusal preserves prior durable history
and leaves its send unconsumed; only ready creates/marks the new running turn and consumes it. Frames
are pre-encoded with JSON escaping and their LF and limited to 1 MiB; an oversized config/task/steer
refuses `frame_too_large` before spawn/write without capacity or send consumption, while malformed/other
received framing is `protocol_error`. A five-minute inactivity
timer resets only on a complete transcript entry or valid lifecycle/progress frame, never stderr or
raw bytes; the sidebar says `inactive 5m`. Termination grace is five seconds uniformly. Private logs
contain diagnostics and stderr only. Notification failure is not agent failure.

### Verification contracts

Focused adapter contracts verify the public boundary, not an implementation plan:

- TypeBox accepts only `TaskName` values matching `/^[A-Za-z0-9_.-]{1,64}$/`; target arrays are
  nonempty in schema and unique at runtime; all seven declared public output schemas accept every stated
  union branch and reject cross-session fields. Completed results require `truncated: true` exactly with
  `full_result_path`; list/read public statuses exclude `starting` and retained profiles accept strings.
- Atomic spawn admission races produce one name winner and respect the three-live/one-implementer
  bounds. A two-caller send race accepts one call; running steering returns acknowledgement only after
  matching `steer_ack`, while matching `command_error` is a correlated negative response that consumes
  nothing. `queue_rejected` carries `running`; `turn_settled` carries its actual terminal status. Result-first
  versus ack-first races respectively retain versus consume the allowance; positive acceptance preserves a
  foreground waiter and otherwise leaves settlement notification-eligible/claimable. Completed resume and
  explicit ready-running interrupt alone reserve synchronous delivery; a provisional interrupt returns
  `not_ready` without cancelling or recording the launch.
- List projections make `follow_up_available` true only for unused allowance/current live generation/existing
  profile/running-or-completed combinations, and false for restart or stale generation, used allowance,
  removed profile, and failed/interrupted status; tests prove it is not an admission guarantee.
- Initial and resumed readiness races enforce 30 seconds: initial failure leaves no public agent record,
  while a crash leaves a private launch lease sufficient to reap the ownership-verified process; resume
  failure preserves prior turns and send allowance; ready commits the new turn.
- Wait-vs-injection arbitration requeues only before beginning injection, drops an attempted failed
  injection while retaining reads, and proves an omitted wait neither waits for nor sees future work.
- Synchronous interrupt versus panic preserves the explicit result and suppresses only panic-created
  outcomes. Restart reaping covers verified orphan, PID/birth-marker mismatch without signal, seven-day
  retention, and no live pruning. Boundary tests cover 1 MiB frames, 50 KiB/2,000-line inline delivery,
  equality context refusal (`projected >= ceiling`), 30-minute steering with no deadline reset, and the
  one-shot non-claiming inactivity warning.

## 9. Open Questions

N/A.

## Changelog

| Date       | Amendment                                                                                                                           | Sections affected | Reason                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| 2026-08-21 | Amend exact public schemas, readiness, bounded waits, delivery arbitration, and verification contracts                              | 3, 8              | Make the settled assistant-facing contract testable without renumbering decisions                                 |
| 2026-08-22 | Refine public command-error winners, result and frame limits, and session-unavailable mapping.                                      | 3, 8              | Preserve exact follow-up and lifecycle outcomes.                                                                  |
| 2026-08-24 | Bind automatic delivery to public `pi.sendUserMessage`, using normal delivery while idle and steering while running.                | 3, 8              | Replace an unavailable native-steer abstraction with the user-approved public Pi API and define its commit point. |
| 2026-08-24 | Return explicit interrupt after bounded cleanup or cleanup-registry handoff, retaining capacity only for a still-live owned worker. | 8                 | Prevent an unbounded tool call when forced cleanup cannot complete.                                               |
| 2026-08-24 | Keep pre-ready failure private while retaining its lease and claims when a still-live worker moves to cleanup.                      | 8                 | Avoid losing reaping evidence or exceeding capacity after a startup refusal.                                      |
| 2026-08-24 | Snapshot invocation admission inputs for spawn/send and remove unreachable `wait_conflict` from repeatable targeted waits.          | 3, 8              | Make current-host resolution explicit and keep the public error union implementable.                              |
| 2026-08-24 | Exclude injection-only inactivity warnings from omitted wait snapshots.                                                             | 8                 | Keep wait outputs limited to `AgentResult`.                                                                       |
