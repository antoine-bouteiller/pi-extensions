---
title: Agent profiles and child environment
status: amended
author: Antoine Bouteiller
date: 2026-08-17
parent-spec: src/features/sub_agents/spec/sub-agents.spec.md
---

## 2. Problem Statement

Every delegation must resolve a profile name into a concrete child: which model runs it, with what
standing instruction, tools, effort, and process environment. A profile grants only the capabilities
its errand needs (`[KD-4.2]` of the umbrella). This component is where the clean context of `[G-1]`
and the capability bound of `[G-5.2]` are preserved or leaked, and where a delegation is refused
before any process exists.

Goals are owned by the umbrella.

## 3. Key Design Decisions

| Decision                           | Choice                                                                                                                                                                                                                                                                                                                      | Rationale                                                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[KD-1]` Profile registry          | Four shipped profiles: `scout`, `librarian`, `reviewer`, `implementer`                                                                                                                                                                                                                                                      | Exploration, external research, review, and mechanical edits are the errands that recur; a fifth profile earns its place by demand, not by symmetry                                                       |
| `[KD-2]` Model selection           | `scout` and `librarian` use `azure-openai/gpt-5.6-luna`; `implementer` uses `azure-openai/gpt-5.6-terra`; `reviewer` uses exactly `anthropic/claude-opus-5` iff the current parent provider string is `openai`, otherwise `azure-openai/gpt-5.6-sol`                                                                        | Routing is literal and deterministic: an OpenAI parent gets an Anthropic second opinion, while every other parent provider uses the designated Azure model                                                |
| `[KD-3]` Unresolvable model        | Resolution failure refuses the delegation before any process starts, naming the missing provider or model; it never falls back to another model                                                                                                                                                                             | A child that starts and then cannot think wastes an errand, and a silent substitution returns the same model's opinion while claiming otherwise                                                           |
| `[KD-4.2]` Tool allow-list         | `scout`, `librarian`, and `reviewer` have exact required read-only tool lists. `implementer` has a required local baseline plus every maintainer-classified tool except async-process, operator, and delegation classes; unknown and unclassified tools are denied                                                          | The first three profiles only inspect or report; implementers gain synchronous editing/verification tools, while one-turn workers cannot safely own delayed async-process wake-ups                        |
| `[KD-6.1]` Child environment       | The worker inherits the parent process environment, replaces every `PI_SUBAGENT*` identity value, and adds `PI_SUBAGENT_READONLY=1` only for policy-read-only profiles. It uses the configured shared `agentDir` for persisted auth/model catalogs; parent-memory-only runtime keys are unsupported and are never forwarded | Ordinary Pi credential, proxy, certificate, and toolchain resolution works without a second credential transport, while replacing reserved markers keeps child identity and flat delegation deterministic |
| `[KD-7.1]` Inherited context       | No profile inherits skills, prompt templates, context files, conversation, or parent session. Configured extensions load normally and may contribute hooks; this package skips parent-only registrations under `PI_SUBAGENT=1`, while the resolved allow-list controls model-visible tools                                  | Normal extension loading constructs lifecycle-dependent tools without a second loader; explicit package gating preserves the intended parent/child split for known UI and context features                |
| `[KD-8]` Context ceiling           | Each profile carries a follow-up context ceiling, defaulting to 200,000 tokens and narrowed to the resolved model's usable window                                                                                                                                                                                           | The bound belongs beside the model that makes it real; a single hardcoded number mis-refuses on a smaller model and never refuses on a larger one                                                         |
| `[KD-9.1]` Resolution/config split | Resolution produces a redacted persisted profile; a separate private worker config carries immutable setup but no credential value. The worker reconstructs and verifies the selected setup, but never selects alternatives                                                                                                 | Records remain explainable without secrets, and ordinary Pi auth resolution through inherited environment plus configured `agentDir` avoids a custom credential channel                                   |

## 4. Principles & Intents

- `[PI-1]` Resolve early, refuse early — refines umbrella `[PI-5]`: everything a profile needs is
  resolved before a process exists, so refusals cost nothing.

## 5. Non-Goals

- `[NG-1]` Per-delegation overrides of a profile's model, prompt, or effort — refines umbrella
  `[NG-2]`: the caller chooses a profile, never its contents.
- `[NG-2.1]` User-authored or per-delegation tool policies — refines umbrella `[NG-2]`; maintainers
  own the four shipped allow-lists as product behavior.

## 6. Caveats

- `[C-1]` Profile colors and thinking levels are presentation and effort hints; only the resolved
  tool allow-list carries capability meaning.
- `[C-2]` Adding a profile or changing its allow-list or maintainer classification is a product and
  security change reviewed as one; read-only profiles deny every tool not explicitly listed.
  `PI_SUBAGENT_READONLY=1` is injected for `scout`, `librarian`, and `reviewer` as defense in depth,
  not as a sandbox. Their read-only restrictions remain prompt/policy only and technically unenforced
  by this feature: the standing prompt and each tool's implementation must be trusted to preserve
  them. In particular, the reviewer prompt's explicit prohibition is only on file edits; its
  unrestricted `bash` access does not prevent broader process or network mutation, consistent with
  this policy-only caveat.
- `[C-4]` `reviewer`'s deterministically selected provider/model may require additional credentials.
- `[C-5.1]` The child resolves credentials from the inherited environment and configured shared `agentDir`,
  like an ordinary Pi process. A key supplied only through the parent's `--api-key`,
  `ModelRuntime.setRuntimeApiKey`, or another in-memory credential store is not inherited; child-equivalent
  preflight refuses that delegation with `missing_provider` before process creation.
- `[C-6]` Environment inheritance is operational compatibility, not isolation: unrelated provider,
  cloud, deployment, proxy, and toolchain variables are visible to the child. Tool policy remains explicitly
  non-sandboxed under `[C-2]`; callers requiring secret isolation must run Pi in a suitably filtered parent
  environment.
- `[C-7]` The worker enforces child resource isolation for skills, prompt templates, context files,
  including extension-contributed ones, byte-for-byte prompt append, and no separately forwarded
  credential or runtime-key values, but no test asserts those properties byte-for-byte. SDK loader
  configuration drift would therefore not be detected automatically.

## 7. High-Level Components

N/A — the component inventory is owned by the umbrella.

## 8. Detailed Design

### Data model

A profile is maintainer-authored data: the profile key, a model rule, a standing prompt, a tool
allow-list, a context ceiling, and optional description, thinking level, and color. The set of profile
keys is closed; a delegation naming anything else is refused during admission.

Resolution turns a profile into the shape the engine spawns from: the profile key, the concrete
provider and model ID it resolved to, the prompt, the tool allow-list, the thinking level, and the
effective context ceiling.

The resolver contract is a discriminated result, so admission cannot accidentally start a child from
a partial profile:

```ts
type PersistedResolvedProfile = {
  key: 'scout' | 'librarian' | 'reviewer' | 'implementer'
  provider: string
  model: string
  prompt: string
  tools: string[]
  thinkingLevel?: 'low' | 'medium' | 'high'
  contextCeiling: number
}
type WorkerConfig = {
  version: 1
  cwd: string
  agentDir: string // the only location from which persisted auth/model catalogs may be read
  provider: string
  model: string
  thinkingLevel?: 'low' | 'medium' | 'high'
  prompt: string
  tools: string[]
  contextCeiling: number
  projectTrusted: boolean
  resourcePolicy: { configuredExtensions: true; skills: false; promptTemplates: false; contextFiles: false }
  memoryPolicy: { persistence: 'session_file_only'; inMemory: 'fixed' }
} // closed, JSON-serializable private stdin config only; never persisted or logged

type ProfileResolution =
  | { ok: true; profile: PersistedResolvedProfile }
  | {
      ok: false
      error: {
        code: 'unknown_profile' | 'missing_provider' | 'missing_model' | 'unavailable_tool' | 'unsafe_tool'
        message: string
      }
    }
```

| Profile       | Description                                                                                | Model rule                                                                                                             | Effort | Color    |
| ------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| `scout`       | Quick codebase exploration and focused implementation reconnaissance — read-only by policy | `azure-openai/gpt-5.6-luna`                                                                                            | low    | `blue`   |
| `librarian`   | Cited web and remote-system research — read-only by policy                                 | `azure-openai/gpt-5.6-luna`                                                                                            | low    | `purple` |
| `reviewer`    | Read-only plan and implementation review                                                   | exactly `anthropic/claude-opus-5` iff current parent provider string is `openai`; otherwise `azure-openai/gpt-5.6-sol` | high   | `orange` |
| `implementer` | Scoped code implementation and verification — write-capable                                | `azure-openai/gpt-5.6-terra`                                                                                           | medium | `green`  |

These fixed effort assignments reflect the work type: exploration and research are bounded and use
low effort, review requires deeper adversarial assessment and uses high effort, and implementation
balances code changes with focused verification at medium effort.

Unknown historical profile records render `gray`/`muted`; they are not re-resolved into a current
profile.

The resolver uses concrete registered tool names, never inherited capability classes. Maintainers
classify the current tools as follows; unknown future tools are denied until this table is amended:

| Classification | Current tools                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| local-read     | `read`, `ffgrep`, `fffind`, `hashline_read`                                                                             |
| shell          | `bash`                                                                                                                  |
| local-write    | `edit`, `write`, `safe_rm`, `hashline_write`                                                                            |
| network-read   | `webfetch`                                                                                                              |
| remote-gateway | `mcp`                                                                                                                   |
| async-process  | `background_poll`                                                                                                       |
| operator       | `ask_user`                                                                                                              |
| delegation     | `spawn_agent`, `wait_agent`, `wait_all_agents`, `list_agents`, `read_agent_response`, `send_message`, `interrupt_agent` |

| Profile       | Required tools                                                         |
| ------------- | ---------------------------------------------------------------------- |
| `scout`       | `read`, `ffgrep`, `fffind`, `bash`                                     |
| `librarian`   | `read`, `ffgrep`, `fffind`, `webfetch`, `mcp`                          |
| `reviewer`    | `read`, `ffgrep`, `fffind`, `bash`                                     |
| `implementer` | Local `read`, search (`ffgrep`, `fffind`), `bash`, `edit`, and `write` |

Every required tool must be registered and available or resolution refuses before process start.
For `implementer`, the required local baseline is supplemented by every currently registered tool
that maintainers have classified as neither async-process, operator, nor delegation; this includes the
guarded local supplements `hashline_read` and `hashline_write`, plus `safe_rm`, `webfetch`, and `mcp`
when registered and so classified. `background_poll` is denied because its delayed wake-up requires a
session that survives the first settled turn, while each worker owns exactly one turn. These supplementary classified tools are
optional: an unavailable one is omitted rather than refusing the delegation.
Unknown or unclassified tools, and every async-process, operator, or delegation tool, are denied even
to `implementer`; no profile receives a tool merely because it was newly registered.

The first three profiles are read-only by policy. `scout` and `reviewer` receive `bash`, and
`librarian` receives `mcp`; their read-only restrictions are prompt/policy only and technically
enforced by neither this feature nor a sandbox. Every other tool not explicitly listed for those
profiles is absent. Delegation-tool suppression remains an independent flat-topology rule for every
profile.

For example, a parent whose current provider string is exactly `openai` resolving `reviewer` selects
`anthropic/claude-opus-5`; every other provider string selects `azure-openai/gpt-5.6-sol`. If that
selected provider is unavailable, resolution returns `missing_provider` rather than trying the other
branch. The effective ceiling is the lower bound:

```ts
const contextCeiling = Math.min(profile.contextCeiling ?? 200_000, model.contextWindow)
// 200,000 profile tokens and a 128,000-token model window => 128,000
```

### Standing prompts

`scout`:

```text
You are a fast codebase exploration agent. Investigate only the delegated task.
Use local read, search, and shell tools to inspect; do not modify files or external
systems. Return a concise conclusion with relevant paths, symbols, and evidence.
If the task requires a product decision or mutation, explain the blocker instead.
```

`librarian`:

```text
You are a cited research agent. Investigate only the delegated question using
local, web, and configured remote sources. Do not modify local or remote state.
Cite the source for each material claim, distinguish documented fact from
inference, and return a concise synthesis. If a source or operation is unavailable,
state the limitation rather than guessing.
```

`reviewer`:

```text
You are a read-only code reviewer. Inspect the requested change and only the
context needed to assess it. Prioritize correctness, security, data loss, and
behavioral regressions. Report actionable findings in severity order with file
and line references and reasoning. Do not modify files, report unrelated
pre-existing issues, or raise style-only comments unless asked. If there are no
findings, say so explicitly.
```

`implementer`:

```text
You are a scoped implementation agent. Complete only the delegated task. Inspect
the relevant code, make the smallest correct change, and preserve validation,
security, data-loss prevention, and accessibility boundaries. Do not broaden the
task or refactor unrelated code. Run focused existing checks and return the
changed paths, verification results, and any blocker requiring a parent decision.
```

### API surface

- Profile resolution — the single entry point: validate the name, evaluate the model rule against the
  parent's model and the operator's authenticated providers, compute the effective context ceiling,
  expand and validate the profile's tool allow-list, and return either a resolved profile or an error
  naming the missing provider, missing model, or unavailable required tool.
- Profile description rendering — render the profile list with each profile's description for the
  `spawn_agent` schema, so the assistant reads the same set the engine accepts.
- Child environment construction — copy the parent environment, remove every inherited
  `PI_SUBAGENT*` control value, then inject the child's exact subagent identity and read-only posture,
  including the marker that keeps the delegation tools from registering inside the child.

### Interactions

The orchestration engine resolves a profile during admission against the parent's current model and
provider, then stores only that redacted `PersistedResolvedProfile` on the agent record. It derives a
private `WorkerConfig` separately. On every resumed turn it resolves again against that parent's then-current
model and provider and persists that turn's redacted resolved profile;
it does not reuse an earlier selection. Historical persisted profiles keep each record readable and
explainable after a product update or when its profile no longer exists. If a settled profile is removed,
resume-time resolution maps it to `unknown_profile`; the historical persisted profile remains readable.

The worker directly calls `createAgentSession` after reconstructing and verifying the exact provider/model,
thinking, prompt, tools, and fixed policies from `WorkerConfig`; a missing or mismatched reconstruction fails
pre-ready and never selects an alternative. It explicitly disables skills, prompt
templates, and context files; it never loads parent conversation state or imports parent session identity.
Configured extensions load normally inside the worker so lifecycle-dependent tools initialize through
their supported hooks; only the resolved allow-list is model-visible, but non-tool extension hooks may run.
This package checks `PI_SUBAGENT=1` during feature registration and skips parent-only features through an
explicit per-descriptor policy: `ask_user`, `background_poll`, `caffeinate`, `claude_code`,
`prompt_rewind`, `rules`, and `sub_agents` itself. `auto_theme` and `caffeinate` already self-suppress on
`PI_SUBAGENT_OWNER_TOKEN`; synchronous tool, provider, and safety features (`comment_checker`, `hashline`,
`mcp`, `meridian_session_affinity`, `safety_guard`, `status_panel` quota forwarding, and `webfetch`) stay
registered. Persisted authentication and model catalogs are read only from the
configured shared `agentDir`, while provider keys, proxies, certificates, and related runtime settings use
ordinary inherited environment resolution. Before admission, the parent creates a child-equivalent model
runtime from that same `agentDir` and environment; a selected provider available only through a parent-memory
runtime override refuses `missing_provider` before process creation. `projectTrusted` is captured from
`ctx.isProjectTrusted()` and applied to the worker's `SettingsManager` before extension discovery.
`PI_SUBAGENT=1` suppresses delegation registration independently of the allow-list. The closed `WorkerConfig`
supplies every non-environment setup value, and the worker does not select alternative models, tools, or
resource policies.

Environment construction copies the parent environment for ordinary Pi and tool compatibility, removes all
reserved sub-agent control values, then injects fresh child identity. The fresh UUID owner token is used by
the status_panel/caffeinate integration; read-only injection and environment inheritance are not sandbox
guarantees:

```ts
const ownerToken = randomUUID()
const childEnvironment = { ...parentEnvironment }
for (const key of Object.keys(childEnvironment)) {
  if (key.startsWith('PI_SUBAGENT')) delete childEnvironment[key]
}
Object.assign(childEnvironment, {
  PI_SUBAGENT: '1',
  PI_SUBAGENT_ID: agent.id,
  PI_SUBAGENT_OWNER_TOKEN: ownerToken,
})
if (profile.key !== 'implementer') childEnvironment.PI_SUBAGENT_READONLY = '1'

const childOptions = {
  skills: false,
  promptTemplates: false,
  contextFiles: false,
  tools: resolvedProfile.tools,
  systemPromptAppend: resolvedProfile.prompt,
}
```

### Verification contracts

The following scenarios are acceptance contracts for this component; they verify observable resolver
and launch-boundary behavior rather than prescribe an implementation sequence.

| Contract                          | Scenario and required observation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Resolver matrix                   | Resolve each fixed-model profile and assert its specified provider/model. Resolve `reviewer` with parent provider `openai` and assert `anthropic/claude-opus-5`; resolve it with every other provider string and assert `azure-openai/gpt-5.6-sol`. An unauthenticated selected provider returns `missing_provider`, and an unavailable selected model from an authenticated provider returns `missing_model`; neither case selects the other branch.                                                                                                                                            |
| Required tools and default denial | For each profile, remove one tool from its required-tools row and assert pre-start `unavailable_tool`. With all required tools present, assert the resolved list is exactly each settled row for `scout`, `librarian`, and `reviewer`. For `implementer`, assert available classified synchronous non-operator, non-delegation supplements are included, unavailable supplements are omitted, and `background_poll`, an unknown/unclassified tool, `ask_user`, or any of the seven delegation tools is absent. A newly registered tool remains absent until the classification table is amended. |
| Environment inheritance           | Given a parent environment containing unrelated configuration, provider keys, and stale `PI_SUBAGENT*` values, assert unrelated values and credentials are inherited unchanged while every reserved marker is replaced. Assert the current `PI_SUBAGENT_ID`, a fresh UUID `PI_SUBAGENT_OWNER_TOKEN`, and `PI_SUBAGENT: '1'`; assert `PI_SUBAGENT_READONLY: '1'` only for `scout`, `librarian`, and `reviewer`. Skills, prompt templates, and context files remain disabled, and only `resolvedProfile.tools` is active.                                                                          |
| Prompt literals                   | For every profile, assert `systemPromptAppend` equals the corresponding fenced prompt content byte-for-byte, including its text and line breaks but excluding the Markdown fence and any wrapper quotation marks.                                                                                                                                                                                                                                                                                                                                                                                |
| Persisted/profile config split    | Assert `PersistedResolvedProfile` contains only key, provider/model, prompt, exact tools, thinking, and ceiling. Assert closed JSON `WorkerConfig` also contains cwd, agentDir, project trust, and fixed resource/memory policies, contains no credential value, is never persisted/logged, and rejects unknown fields. The worker uses inherited environment plus configured agentDir for auth, loads configured extensions normally, exposes only exact resolved tool IDs, and fails mismatches pre-ready without fallback.                                                                    |
| Resume re-resolution              | Admit and settle a child, change the parent provider or model availability, then resume it. Assert the resumed turn resolves anew and persists a new redacted profile rather than reusing a private config; a newly missing provider or model refuses the follow-up. Remove the settled profile before resume and assert the follow-up returns `unknown_profile` while historical data remains readable.                                                                                                                                                                                         |

### Error handling

- Unknown profile name → refusal naming the valid names.
- Model rule resolves to a provider the operator has not authenticated → `missing_provider` refusal
  naming that provider, with no fall-back to a second model.
- The selected model is not registered or available from its authenticated provider → `missing_model`
  refusal naming that model, with no fall-back.
- Profile removed after an agent settled → the record stays readable and openable, and a follow-up
  maps to `unknown_profile` rather than silently substituting another profile.
- A required concrete tool is unavailable → refusal before process start naming that tool. An optional
  maintainer-classified `implementer` tool that is unavailable is omitted.
- An unknown, unclassified, operator, or delegation tool → denied; it cannot expand any profile's
  tool set.

## 9. Open Questions

N/A.

## Changelog

| Date       | Amendment                                                                                                                                                                                                              | Sections affected | Reason                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-21 | Consolidate pass-2 corrections for deterministic reviewer routing, effort rationale, guarded-tool classification, child environment isolation, policy-only review limits, and resume-time unknown profiles             | 2, 3, 6, 8        | Keep the shipped profile contract explicit, testable, and default-deny while preserving accepted prompt literals and per-turn decisions |
| 2026-08-22 | Split persisted redacted profile resolution from closed private worker configuration, including credential source, fixed policies, and exact reconstruction verification.                                              | 3, 6, 8           | Keep records explainable without persisting secret runtime setup.                                                                       |
| 2026-08-24 | Inherit the parent environment, use shared `agentDir` authentication, reject parent-memory-only credentials in child-equivalent preflight, and propagate project trust without carrying credentials in `WorkerConfig`. | 3, 6, 8           | Match ordinary Pi child startup and remove custom credential transport while keeping context/tool isolation explicit.                   |
| 2026-08-24 | Load configured extensions normally, keep model-visible tools allowlisted, and suppress package-owned parent-only features under `PI_SUBAGENT=1`.                                                                      | 3, 6, 8           | Preserve lifecycle-dependent tool initialization without building a generic tool-only extension loader.                                 |
| 2026-08-24 | Exclude the async-process class, currently `background_poll`, from one-turn child profiles.                                                                                                                            | 3, 8              | A delayed poll wake-up cannot complete after the worker exits on its first settled turn.                                                |
| 2026-08-25 | Name the actual parent-only features suppressed in children and gate them through the feature descriptor policy.                                                                                                       | 8                 | The suppression list referenced a feature that does not exist and omitted `auto_theme`.                                                 |
| 2026-08-25 | Record unproven byte-for-byte child loader isolation and private setup forwarding.                                                                                                                                     | 6                 | Keep the loader-verification gap beside the child-environment contract.                                                                 |
