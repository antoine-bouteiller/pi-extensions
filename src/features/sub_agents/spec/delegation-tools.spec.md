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

| Decision                    | Choice                                                                                                                               | Rationale                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[KD-1]` Tool set           | Seven tools: `spawn_agent`, `wait_agent`, `wait_all_agents`, `list_agents`, `read_agent_response`, `send_message`, `interrupt_agent` | One tool per intent the assistant actually has; collapsing the waits into one tool would hide the difference between the next result and all results           |
| `[KD-2]` Mode parameter     | `spawn_agent` waits unless `run_in_background` is set (`[KD-3]` of the umbrella), and the guidance encourages the waiting mode       | The default must be the safe mode, and a single boolean keeps the choice visible in the call rather than buried in prose                                       |
| `[KD-3]` Announcements      | An unwaited settlement is injected into the session as a tagged notification, whether the assistant is mid-turn or idle              | The assistant must be able to act on a background result without the operator having to prompt it, and the tag is what keeps it distinguishable from user text |
| `[KD-4]` Guidance injection | Delegation guidance is appended to the parent's instructions                                                                         | Tool descriptions alone do not convey policy like "do not duplicate a pending child's work"                                                                    |
| `[KD-5]` Result shape       | Every result states the agent, its terminal status, and either its conclusion as plain text or the reason there is none              | A caller that cannot distinguish "no findings" from "failed" makes the wrong next move                                                                         |
| `[KD-6]` Session scope      | Every tool, reading or mutating, resolves targets within the current session only (`[KD-1]` of the umbrella)                         | A listing the assistant can see but the operator cannot is a surface with no accountable owner                                                                 |
| `[KD-8]` Child suppression  | The seven tools do not register when the process's environment marks it as a subagent                                                | This is what makes flat topology (`[NG-1]` of the umbrella) true now that no allow-list restricts a child's tools                                              |

Withdrawn: `[KD-7]` (posture in listings). There is no posture to report.

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

One factory builds the feature and one registration wires it into the host: lifecycle hooks, the seven
tools, the operator command, and the completion renderer. Registration is skipped entirely inside a
child process.

| Tool                  | Input                                                      | Result                                                                                                                 |
| --------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `spawn_agent`         | `task_name`, `agent_type`, `message`, `run_in_background?` | Foreground: the settlement. Background: acceptance, naming the agent and its profile                                   |
| `wait_agent`          | optional `targets`                                         | The next settlement among the targets, or among all outstanding agents                                                 |
| `wait_all_agents`     | `targets`                                                  | One entry per target once every one has settled                                                                        |
| `list_agents`         | none                                                       | Name, status, profile, and a last-task preview per agent of this session                                               |
| `read_agent_response` | `target`                                                   | That agent's latest conclusion, or its current status if none exists yet                                               |
| `send_message`        | `target`, `message`                                        | One follow-up: steers a running turn or resumes a settled one, refused when one is in flight or the ceiling is reached |
| `interrupt_agent`     | `target`                                                   | Stops a starting or running agent                                                                                      |

Profile names and descriptions in the `spawn_agent` schema come from the profiles component, so the
schema and the accepted set cannot drift.

The public schemas keep targeting by task name and expose no session selector:

```ts
type SpawnAgentInput = {
  task_name: string
  agent_type: 'scout' | 'librarian' | 'reviewer' | 'implementer'
  message: string
  run_in_background?: boolean // defaults to false
}

type AgentResult =
  | { agent: string; status: 'completed'; conclusion: string; fullResultPath?: string }
  | { agent: string; status: 'failed' | 'interrupted'; reason: string }

type AgentAcceptance = { agent: string; profile: string; status: 'starting' | 'running' }
```

Representative calls and results:

```json
{"task_name":"inspect-cache","agent_type":"scout","message":"Trace cache invalidation."}
{"agent":"inspect-cache","status":"completed","conclusion":"Invalidation starts in CacheStore.clear()."}

{"task_name":"check-docs","agent_type":"librarian","message":"Verify the API contract.","run_in_background":true}
{"agent":"check-docs","profile":"librarian","status":"starting"}
```

### Interactions

The adapter holds no lifecycle state: each tool call becomes one engine call, and each completion
event that arrives unclaimed becomes one session announcement. Inactivity events surface as a single
warning to the parent.

An unclaimed background result becomes host-injected content, not user-authored text:

```text
[subagent:check-docs status=completed]
The API guarantees ordered delivery. Full result: /runs/01J...7M.result.txt
```

At registration, `PI_SUBAGENT=1` skips both the seven tool registrations and parent guidance
injection; all unrelated host tools remain available to the child.

Guidance injected into the parent's instructions covers: when delegation is worth it, foreground as
the default and the encouraged mode, background for genuinely independent errands, not duplicating a
pending child's work, giving concurrent writing children disjoint paths, and preferring a fresh child
over a long follow-up chain. It also states plainly that a child holds the same tools as the parent,
including a shell, so the assistant knows what it is authorising (`[C-10]` of the umbrella).

### Error handling

- Unknown profile, unauthenticated provider for the profile's model, duplicate task name, follow-up
  already in flight, exhausted context → refusal naming the limit and the alternative, with no agent
  created.
- Wait naming an unknown agent → immediate failure rather than a block.
- Abandoned wait → the child keeps working and its settlement is announced instead of lost.
- Oversized result or announcement → truncated for delivery with the full text's location reported.
- Settlement arriving after the session process is gone → the record keeps the conclusion and the
  announcement is dropped (`[C-6]` of the umbrella).

Refusals are structured enough for the completion renderer to preserve the enforced limit and the
next action:

```json
{
  "error": { "code": "follow_up_in_flight", "message": "check-docs already has a follow-up in flight; wait for it to settle or spawn a fresh child." }
}
```

## 9. Open Questions

None.

## Changelog

| Date       | Amendment                                                                                     | Sections affected | Reason                                                   |
| ---------- | --------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------- |
| 2026-08-21 | Add tool input/result, foreground/background, announcement, suppression, and refusal examples | 8                 | Make the assistant-facing contract concrete and testable |
