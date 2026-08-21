---
title: Agent profiles and child environment
status: amended
author: Antoine Bouteiller
date: 2026-08-17
parent-spec: src/features/sub_agents/spec/sub-agents.spec.md
---

## 2. Problem Statement

Every delegation must resolve a profile name into a concrete child: which model runs it, with what
standing instruction, at what effort, and in what process environment. A profile shapes how a child
thinks, not what it may touch — it holds the full tool set either way (`[C-10]` of the umbrella). This
component is where the clean context of `[G-1]` is preserved or leaked, and where a delegation is
refused before any process exists.

Goals are owned by the umbrella.

## 3. Key Design Decisions

| Decision                    | Choice                                                                                                                                                                                    | Rationale                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[KD-1]` Profile registry   | Four shipped profiles: `scout`, `librarian`, `reviewer`, `implementer`                                                                                                                    | Exploration, external research, review, and mechanical edits are the errands that recur; a fifth profile earns its place by demand, not by symmetry                                                         |
| `[KD-2]` Model selection    | A profile's model is a fixed rule over the parent's model, evaluated at spawn: `reviewer` takes Opus when the parent is GPT and `gpt-5.6-sol` otherwise; the rest name one model outright | A second opinion is only a second opinion if it comes from a different model family; everywhere that does not matter, a literal ID is the whole feature                                                     |
| `[KD-3]` Unresolvable model | Resolution failure refuses the delegation before any process starts, naming the missing provider; it never falls back to another model                                                    | A child that starts and then cannot think wastes an errand, and a silent substitution returns the same model's opinion while claiming otherwise                                                             |
| `[KD-6]` Child identity     | The child environment strips parent-owned Pi identity variables and injects the subagent's own identity                                                                                   | Inherited identity makes a child indistinguishable from its parent in logs and state directories, and the injected marker is what suppresses the delegation tools inside a child (`[KD-6]` of the umbrella) |
| `[KD-7]` Inherited context  | No profile inherits skills, prompt templates, or context files; the child is launched with all three switched off                                                                         | Clean context is the product (`[PI-1]` of the umbrella); a child that needs project conventions can be given them in its instruction, at the cost of the one call that needs them                           |
| `[KD-8]` Context ceiling    | Each profile carries a follow-up context ceiling, defaulting to 200,000 tokens and narrowed to the resolved model's usable window                                                         | The bound belongs beside the model that makes it real; a single hardcoded number mis-refuses on a smaller model and never refuses on a larger one                                                           |

Withdrawn: `[KD-4]` (tool allow-list) and `[KD-5]` (posture label). A profile no longer describes or
restricts what a child may do.

## 4. Principles & Intents

- `[PI-1]` Resolve early, refuse early — refines umbrella `[PI-5]`: everything a profile needs is
  resolved before a process exists, so refusals cost nothing.

## 5. Non-Goals

- `[NG-1]` Per-delegation overrides of a profile's model, prompt, or effort — refines umbrella
  `[NG-2]`: the caller chooses a profile, never its contents.
- `[NG-2]` Describing or constraining a child's capabilities through its profile — refines umbrella
  `[C-10]`; every profile has the same reach.

## 6. Caveats

- `[C-1]` Profile colors and thinking levels are presentation and effort hints; they carry no
  authorisation meaning, because there is no authorisation.
- `[C-2]` Adding a profile is a product change reviewed as one, but it widens nothing: the reach of
  every child is already the reach of the parent.
- `[C-4]` `reviewer`'s cross-family rule means a machine authenticated with only one provider gets a
  refusal rather than a same-family review. That refusal is the point.

## 7. High-Level Components

N/A — the component inventory is owned by the umbrella.

## 8. Detailed Design

### Data model

A profile is maintainer-authored data: the profile key, a model rule, a standing prompt, a context
ceiling, and optional description, thinking level, and color. The set of profile keys is closed; a
delegation naming anything else is refused during admission.

Resolution turns a profile into the shape the engine spawns from: the profile key, the concrete
provider and model ID it resolved to, the prompt, the thinking level, and the effective context
ceiling.

The resolver contract is a discriminated result, so admission cannot accidentally start a child from
a partial profile:

```ts
type ResolvedProfile = {
  key: 'scout' | 'librarian' | 'reviewer' | 'implementer'
  provider: string
  model: string
  prompt: string
  thinkingLevel?: 'low' | 'medium' | 'high'
  contextCeiling: number
}

type ProfileResolution =
  { ok: true; profile: ResolvedProfile } | { ok: false; error: { code: 'unknown_profile' | 'missing_provider'; message: string } }
```

| Profile       | Errand                                          | Model rule                                      | Effort |
| ------------- | ----------------------------------------------- | ----------------------------------------------- | ------ |
| `scout`       | Read an unfamiliar tree and answer one question | `gpt-5.6-luna`                                  | low    |
| `librarian`   | Chase an external citation                      | `gpt-5.6-luna`                                  | low    |
| `reviewer`    | Re-read a change and judge it                   | Opus when the parent is GPT, else `gpt-5.6-sol` | high   |
| `implementer` | Make a narrow, scoped edit and verify it        | `gpt-5.6-terra`                                 | medium |

Every profile runs with the host's full tool set, shell included. `implementer` is expected to run the
tests and typechecks that prove its own edits, which is what makes a writing errand worth delegating
at all.

For example, an authenticated GPT parent resolving `reviewer` selects Opus; a non-GPT parent selects
`gpt-5.6-sol`. If that selected provider is unavailable, resolution returns `missing_provider` rather
than trying the other branch. The effective ceiling is the lower bound:

```ts
const contextCeiling = Math.min(profile.contextCeiling ?? 200_000, model.contextWindow)
// 200,000 profile tokens and a 128,000-token model window => 128,000
```

### API surface

- Profile resolution — the single entry point: validate the name, evaluate the model rule against the
  parent's model and the operator's authenticated providers, compute the effective context ceiling,
  and return either a resolved profile or an error naming the missing provider.
- Profile description rendering — render the profile list with each profile's description for the
  `spawn_agent` schema, so the assistant reads the same set the engine accepts.
- Child environment construction — return the child's environment with parent Pi identity variables
  removed and the subagent identity injected, including the marker that keeps the delegation tools
  from registering inside the child.

### Interactions

The orchestration engine resolves a profile during admission and stores the resolved fields on the
agent record, so a record remains readable and explainable after a product update even when its
profile no longer exists.

The child is launched with skills, prompt templates, and context files all disabled, and with the
profile's prompt appended to the child's own system prompt.

Environment construction is conceptual pseudocode for the child-launch boundary. The constructor uses
the host's complete identity-variable list rather than maintaining a second list in this feature:

```ts
const childEnvironment = {
  ...omit(parentEnvironment, host.piIdentityVariables),
  PI_SUBAGENT: '1',
  PI_SUBAGENT_ID: agent.id,
}

const childOptions = {
  skills: false,
  promptTemplates: false,
  contextFiles: false,
  systemPromptAppend: resolvedProfile.prompt,
}
```

### Error handling

- Unknown profile name → refusal naming the valid names.
- Model rule resolves to a provider the operator has not authenticated → refusal naming that provider,
  with no fall-back to a second model.
- Profile removed after an agent settled → the record stays readable and openable, and a follow-up is
  refused rather than silently substituting another profile.

## 9. Open Questions

None.

## Changelog

| Date       | Amendment                                                                      | Sections affected | Reason                                                                                    |
| ---------- | ------------------------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------- |
| 2026-08-21 | Add resolver, model-selection, context-ceiling, and child-environment examples | 8                 | Make profile admission and isolation implementable without expanding profile capabilities |
