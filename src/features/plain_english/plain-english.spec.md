---
title: Plain English
status: amended
author: Antoine Bouteiller
date: 2026-08-15
related: [docs/project_structure.md, docs/effect_pi_boundary.spec.md]
---

## 2. Problem Statement

Assistant messages in this agent are dense: jargon, hedges, tool names, and structure that a
reader has to decode before they can judge whether the agent understood them. The reader wants
the same content in plain English without losing the original wording, and wants to ask for the
same treatment of a Markdown document they name. The rewrite is a reading aid, so it must never alter
what the model itself said, what the session sends back to the provider, or what the transcript
records — and it must disappear silently whenever the rewriter is unavailable.

- `[G-1]` Every user-facing assistant message of substance is followed in the transcript by a
  plain-English rewrite produced by a second, cheap model.
- `[G-2]` The rewrite is display-only: it never enters the LLM context, never replaces the
  assistant message, and never changes the agent's behaviour.
- `[G-4]` Every failure path — no model configured, provider down, timeout, truncated output —
  leaves the original text and the original file exactly as they were.
- `[G-5]` The reader can turn rewrites off and on inside a running session.
- `[G-6]` The reader can rewrite any Markdown file on demand, without the automatic path armed.

## 3. Key Design Decisions

| Decision                     | Choice                                                                                                                    | Rationale                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[KD-1]` Display trigger     | One `message_end` handler, not `message_update`                                                                           | `message_end` carries the finalized `AgentMessage`, so the whole-message reassembly the upstream plugin does with per-chunk temp files has no counterpart here (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:890`)             |
| `[KD-2]` Rewrite surface     | `pi.appendEntry` plus `pi.registerEntryRenderer`, never `MessageEndEventResult.message`                                   | Custom entries are declared not to participate in LLM context (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:936`), which makes `[G-2]` structural; replacing the finalized message would feed the rewrite back to the provider |
| `[KD-12]` Eligible messages  | Only messages the user actually reads: an assistant message with no tool calls, or whose only tool call is `ask_user`     | Intermediate tool-dispatch narration is scaffolding, not an answer; rewriting it multiplies latency and cost for text the reader skims past                                                                                                                     |
| `[KD-3]` Display modes       | Append only; no `replace` mode                                                                                            | `[KD-2]` renders the original message untouched by construction, so suppressing it would mean editing context to change display — the exact coupling this design refuses                                                                                        |
| `[KD-4]` Rewriter model      | A Pi registry model named by `PI_PLAIN_ENGLISH_MODEL` as `provider/model-id`, called through `ctx.modelRegistry.complete` | The registry already owns credentials, base URLs, and OpenAI-compatible providers (`node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts:28`), so a local ollama endpoint is a provider entry rather than a second HTTP path              |
| `[KD-5]` Display concurrency | Rewrite runs on a forked fiber owned by the session scope; the `message_end` handler returns immediately                  | Awaiting the rewrite stalls the turn for the rewriter's whole latency; scope ownership is the repo's rule for forks (`docs/effect_pi_boundary.spec.md` `[KD-7]`)                                                                                                |
| `[KD-8]` Markdown default    | `sibling` mode writing `NAME.plain.md`; `overwrite` exists but is opt-in and marker-guarded                               | A weak rewriter degrading a real document is unrecoverable; a sibling file is discardable                                                                                                                                                                       |
| `[KD-9]` Kill switch         | A `/plain-english` command toggling in-memory session state                                                               | Pi owns commands natively, so the upstream flag-file polled on every hook fire buys nothing here                                                                                                                                                                |
| `[KD-10]` Failure policy     | Fail open everywhere: on any error, timeout, or truncation, emit nothing and notify once per session via `ctx.ui.notify`  | A partial rewrite is more confusing than none, and a silent skip with no explanation reads as a bug                                                                                                                                                             |
| `[KD-11]` Configuration      | Plain `process.env` reads resolved once at registration, except the toggle                                                | The repo has no settings API and existing features read `process.env` directly (`src/features/mcp/gateway.ts`, `src/features/sub_agents/core.ts`)                                                                                                               |
| `[KD-13]` Markdown trigger   | A `/plain-english-md <path>` command is the only way a file is rewritten; no `write`/`edit` hook                          | Rewriting `README.md` because the agent happened to touch it is data loss dressed as a feature, and a post-write rewrite charges the rewriter's latency to every Markdown write                                                                                 |

## 4. Principles & Intents

- `[PI-1]` **Display is not context** — anything the reader sees that the model did not produce
  stays out of the message stream.
- `[PI-2]` **Absent beats wrong** — no rewrite is always an acceptable outcome; a truncated,
  half-rewritten, or hallucinated one never is.
- `[PI-3]` **The reader owns the switch** — the feature is inert until a model is named, and one
  command stops it mid-session.
- `[PI-4]` **Bytes on disk are sacred** — the file-side rewrite defaults to a new file, and the
  in-place mode is idempotent and atomic.

## 5. Non-Goals

- `[NG-1]` Rewriting user messages, tool output, thinking blocks, or sub-agent transcripts.
- `[NG-2]` A `replace` display mode that suppresses the original message.
- `[NG-3]` A provider layer of its own — ollama, Anthropic, and OpenAI-compatible endpoints are
  reached as Pi providers.
- `[NG-4]` User-supplied prompt files; the two system prompts are built in.
- `[NG-5]` Persisting or re-rendering rewrites for messages produced before the feature was on.

## 6. Caveats

- `[C-1]` Because `[KD-5]` does not block the turn, a rewrite entry lands when it completes and
  can appear after tool output belonging to the same turn. Ordering is completion order, not
  message order.
- `[C-2]` Rewrites travel wherever the chosen model lives. A cloud model in
  `PI_PLAIN_ENGLISH_MODEL` sends every assistant message — and every file passed to
  `/plain-english-md` — to that provider, on that provider's credentials and quota.
- `[C-3]` `appendEntry` persists the entry in the session, so rewrites reappear on resume while
  the model context stays clean.
- `[C-4]` `/plain-english-md` blocks until the rewrite lands. A large document against a slow
  local model is measured in tens of seconds, bounded by `MD_TIMEOUT_MS`.
- `[C-5]` Truncation is detected from the assistant message's stop reason; a provider that does
  not report one is treated as untruncated and a clipped rewrite can be displayed.

## 7. High-Level Components

```text
message_end ──► display.ts ──fork──► rewrite.ts ──► ctx.modelRegistry.complete
                    │                    │
                    └──ok──► appendEntry('plain-english') ──► entry renderer
                                         │
/plain-english-md <path> ──► markdown.ts ─┘──► NAME.plain.md  |  NAME.md (marker)

            config.ts (env, once)      toggle state (session)
```

| Component     | Module type                              | Responsibility                                                         | Public API surface                                  |
| ------------- | ---------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| Registration  | `src/features/plain_english/index.ts`    | Register the hook, the commands, and the entry renderer; bridge Effect | `register(pi, runtime)`                             |
| Rewriter      | `src/features/plain_english/rewrite.ts`  | Build the request, call the registry model, validate the completion    | `rewriteMessage`, `rewriteDocument`, `RewriteError` |
| Display       | `src/features/plain_english/display.ts`  | Decide eligibility, emit the entry, render it                          | `handleMessageEnd`, `renderRewriteEntry`            |
| Markdown      | `src/features/plain_english/markdown.ts` | Rewrite one named Markdown file and write the plain version            | `markdownCommand`, `rewriteFile`                    |
| Configuration | `src/features/plain_english/config.ts`   | Read and validate env once; hold the session toggle                    | `loadConfig`, `PlainEnglishConfig`, `Toggle`        |

## 8. Detailed Design

### 8.1 Registration

`register(pi, runtime)` follows the repo's feature shape — a named export wired from
`src/config/features.ts:25`, containing only registration and bridging
(`docs/project_structure.md`):

```ts
export const register = (pi: ExtensionAPI, runtime: AppRuntime): void
```

It registers, in order: `pi.registerEntryRenderer('plain-english', renderRewriteEntry)`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:922`),
`pi.on('message_end', ...)`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:897`), and the
`/plain-english` and `/plain-english-md` commands (`src/features/sub_agents/index.ts:23`).
Event handlers are bridged with
`makeEventHandler` (`src/shared/effect/runtime.ts:35`). When `loadConfig` yields no usable model
the feature registers the command and the renderer only, so a session with no configuration pays
nothing.

### 8.2 Configuration

| Variable                         | Default   | Meaning                                                                 |
| -------------------------------- | --------- | ----------------------------------------------------------------------- |
| `PI_PLAIN_ENGLISH_MODEL`         | _(unset)_ | `provider/model-id`, resolved with `modelRegistry.find`. Unset = inert. |
| `PI_PLAIN_ENGLISH_MIN_CHARS`     | `200`     | Skip content whose prose length, fenced code removed, is below this.    |
| `PI_PLAIN_ENGLISH_TIMEOUT_MS`    | `45000`   | Per-rewrite deadline for the display path.                              |
| `PI_PLAIN_ENGLISH_MD_TIMEOUT_MS` | `150000`  | Per-rewrite deadline for `/plain-english-md`.                           |

An unparsable numeric value falls back to its default. A `PI_PLAIN_ENGLISH_MODEL` that names no
registry model makes the feature inert and notifies once.

The session toggle is a boolean in feature state, defaulting to on, flipped by
`/plain-english` (`on`, `off`, or no argument to invert). It gates the display path only; an
explicit `/plain-english-md` invocation runs regardless.

### 8.3 Rewriter

```ts
interface RewriteRequest {
  readonly systemPrompt: string
  readonly text: string
  readonly question?: string
}
type RewriteError = ModelUnavailable | RewriteTimeout | RewriteTruncated | ProviderFailure
```

`rewriteMessage` builds a single-turn `Context`: the built-in system prompt (plain English,
preserve every fact, leave fenced code verbatim, output only the rewrite, never answer or repeat
the question), the assistant text as the user turn, and the originating user question as
labelled context so the rewrite stays on topic. It calls
`ctx.modelRegistry.complete(model, context)`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts:33`) under a timeout, then
validates: non-empty, not truncated by an output cap. Anything else becomes a `RewriteError`.

`rewriteDocument` differs only in its system prompt and in receiving the document body with YAML
frontmatter already stripped.

Failures are values, not defects, per the repo's error-channel rule
(`docs/effect_pi_boundary.spec.md` `[KD-9]`). The first `RewriteError` of a session produces one
`ctx.ui.notify(..., 'warning')` naming the cause; later ones are silent.

### 8.4 Display path

On `message_end`, the handler proceeds only when the toggle is on, the message role is
`assistant`, the message is user-facing per `[KD-12]` — it carries no tool call, or exactly one
and that one is `ask_user` — and the concatenated text content minus fenced code reaches
`MIN_CHARS`. It then
forks the rewrite onto the session scope and returns `undefined`, leaving the message untouched.

On success the fiber calls:

```ts
pi.appendEntry('plain-english', { text: rewrite, messageId })
```

`renderRewriteEntry(entry, options, theme)` renders a `💬 In plain English:` header followed by
the rewrite, dimmed, honouring `options.expanded`. On failure the fiber emits nothing.

Session shutdown interrupts the scope, so a rewrite in flight when the session ends is dropped
rather than appended to a dead session.

### 8.5 Markdown command

`/plain-english-md <path> [--overwrite]` rewrites one file on demand. It resolves `<path>`
against the working directory and requires an existing `.md` file that is not itself a
`.plain.md` output. It then reads the file, splits YAML frontmatter, skips a body below
`MIN_CHARS`, and awaits `rewriteDocument` under `MD_TIMEOUT_MS`. The mode is `sibling` unless
`--overwrite` is passed.

| Mode        | Result                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `sibling`   | Writes `NAME.plain.md` beside `NAME.md`; the original is never opened for writing.               |
| `overwrite` | Rewrites `NAME.md` in place, inserting `<!-- plain-english:rewritten -->` after any frontmatter. |

Frontmatter is re-attached verbatim. In `overwrite` mode the marker makes the operation
idempotent: a file already carrying it is skipped, so an edit-rewrite-edit loop cannot compound.
Both modes write through a temporary file in the destination directory and rename, so a crash
mid-write leaves the previous bytes.

Being an explicit request, the command is never silent: it reports the written path on success
and the reason on every rejection — no model configured, missing file, not Markdown, body below
`MIN_CHARS`, already marked, or rewrite failed.

### 8.6 Failure modes

| Failure                                | Behaviour                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| No or unknown `PI_PLAIN_ENGLISH_MODEL` | Display path inert with one notice at session start; the command reports it. |
| Provider unreachable, auth missing     | No entry, file untouched; one notice per session.                            |
| Timeout                                | Fiber interrupted or await abandoned; no entry, file untouched.              |
| Truncated completion                   | Result discarded, treated as a failure; notice mentions the output cap.      |
| Renderer throws                        | Entry data is already persisted; Pi's renderer contract governs fallback.    |
| Toggle off mid-rewrite                 | In-flight rewrite still lands; the next message produces nothing.            |

### 8.7 Tests

`tests/features/plain_english/` mirrors the module set. Registration is driven through the fake
Pi (`tests/utils/fake_pi.ts`) with a stub `modelRegistry`, asserting: an eligible message yields
exactly one `plain-english` entry and no message replacement; a message carrying a `bash` tool
call yields none while an `ask_user` one yields an entry; a failing rewriter yields no entry
and one notice; a short message is skipped; and the toggle suppresses the display path. For the
command: a `.md` argument produces `NAME.plain.md` and leaves the original bytes untouched,
`--overwrite` inserts the marker and a second pass is a no-op, a missing or non-Markdown path
reports rather than writes, and the toggle being off does not block it. Timeout behaviour is
asserted with `TestClock`.

## 9. Open Questions

None.

## Changelog

| Date       | Amendment                                          | Sections affected      | Reason                                                                   |
| ---------- | -------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| 2026-08-15 | Add `/plain-english-md <path>` command             | 2, 3, 7, 8.1, 8.5, 8.7 | On-demand rewrite of an existing Markdown file                           |
| 2026-08-15 | Drop the automatic `write`/`edit` Markdown rewrite | 2, 3, 6, 7, 8.1–8.7    | Unasked-for file rewrites and per-write latency outweigh the convenience |
