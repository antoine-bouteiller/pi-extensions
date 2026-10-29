---
title: Sub-agent viewer
status: implemented
author: Antoine Bouteiller
date: 2026-10-29
module: [src/features, src/shared/state, src/shared/effect, src/config]
related: [docs/effect_pi_boundary.spec.md, docs/project_structure.md]
---

## Why

Sub-agents run as headless `pi --mode rpc` children with no pane. The operator sees them only
through the parent agent's `list_agents` calls and the final `subagent-result` messages. There is
no way to tell how many are running, or what one is doing, without asking the parent agent. Each
child already persists its transcript to the session file reported by `get_state`.

- `[G-1]` The operator sees at a glance how many sub-agents of the current session are running.
- `[G-2]` The operator lists the running sub-agents of the current session on demand.
- `[G-3]` The operator reads a running sub-agent's conversation as it progresses, without affecting
  it.
- `[G-4]` Status entries read as plain text: no icons, and `·` separates only independent values.
- `[NG-1]` Listing or opening closed or exited sub-agents; their transcripts stay on disk.
- `[NG-2]` Sending, interrupting, or closing a child from the viewer; those remain the parent
  agent's tools.
- `[NG-3]` Viewing another session's sub-agents.
- `[NG-4]` Streaming an assistant message before Pi persists it at `message_end`.
- `[NG-5]` Viewing outside the interactive TUI.
- `[NG-6]` Dragging the overlay's scrollbar.

## Design

- `[PI-1]` Look, never touch: the viewer never writes to a child or to host UI state.
- `[PI-2]` One source per view: the count and the list come from the same in-memory children map the
  tools use; the transcript comes from the child's persisted session file.

| Decision                    | Choice                                                                                                                                                                                                                                | Rationale                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `[KD-1]` Running            | A child is running while it is in the children map and owned by the current parent session file, whatever its status (`starting`, `working`, `idle`, `blocked`). This is exactly the set `list_agents` returns.                       | An idle child still holds a process and can be resumed.                                                          |
| `[KD-2]` Ambient count      | One shared status-bar entry, key `subagents`, republished whenever the running set changes and cleared at zero and on session end.                                                                                                    | Reuses the status bar other features already publish to instead of adding a widget.                              |
| `[KD-3]` Footer statuses    | The `status_panel` footer renders every shared status-bar entry, in priority order, in the right column before the turn metrics.                                                                                                      | `status_panel` replaces Pi's footer, which was the only place status entries rendered.                           |
| `[KD-4]` Command            | `/subagents` opens a `ctx.ui.select` of the running children in spawn order; choosing one opens the transcript overlay.                                                                                                               | Listing and opening are one motion.                                                                              |
| `[KD-5]` Transcript source  | The overlay reads the child's session file and re-reads it on a 500 ms tick when its size changed.                                                                                                                                    | The file is durable and already written; the RPC stream stays dedicated to results and dialogs.                  |
| `[KD-6]` Transcript content | The root-to-leaf branch of the last entry, including entries before a compaction, with one marker line per compaction. User, assistant (thinking included), and tool components are Pi's exported components.                         | Shows the child's full history, not its compacted context.                                                       |
| `[KD-7]` Tool rendering     | `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` render through Pi's root-exported `create*ToolDefinition(childCwd)`. Every other tool renders through a display-only definition: compact JSON args and a collapsed preview. | `ToolExecutionComponent` has no built-in fallback in Pi 1.4.0, and extension tool definitions live in the child. |
| `[KD-8]` Tool expansion     | Seeded from `ctx.ui.getToolsExpanded()` and toggled by `app.tools.expand` inside the overlay only.                                                                                                                                    | Inspecting a child never changes the parent view (`[PI-1]`).                                                     |
| `[KD-9]` Overlay lifetime   | The overlay stays open when its child closes or exits: the title shows `exited`, the content stays, and refresh stops. `esc` or `q` closes it. The refresh fiber is scoped to the command invocation.                                 | Fiber ownership per `docs/effect_pi_boundary.spec.md` `[KD-7]`.                                                  |
| `[KD-10]` Wheel scrolling   | The overlay handles every wheel event over it: it scrolls by `event.wheelDelta` and reports the event handled, even when already at an edge.                                                                                          | Pi routes an unhandled wheel over an overlay to the main transcript behind it.                                   |
| `[KD-11]` Jump to latest    | While scrolled away from the end, the overlay draws Pi's jump-to-latest label on its last body row. A left click on the label or the `tui.altScreen.bottom` key scrolls to the end and resumes following.                             | Pi draws and handles its own label only for the main view, never inside an overlay.                              |
| `[KD-12]` No status icons   | Icons are removed everywhere: from status items, from feature descriptors' status metadata, and from the health notifications built from them. Every surface shows the entry's text alone.                                            | The footer joins entries with `·`; the text already names each entry.                                            |
| `[KD-13]` Entry qualifiers  | Inside one status entry, a qualifier of the main value goes in parentheses, never after `·`. The background-poll entry reads `1 background poll (12s)`.                                                                               | `·` between entries and inside an entry made one entry look like two.                                            |

## Outcome

- `[SO-1]` While the current session has running sub-agents, the status bar carries one
  `N sub-agent(s)` entry, and no entry otherwise. — demonstrated by `[VC-1]`
- `[SO-2]` The `status_panel` footer shows every shared status entry, so sub-agent counts,
  background polls, and feature-health errors are visible with `status_panel` enabled.
  — demonstrated by `[VC-2]`
- `[SO-3]` `/subagents` lists the current session's running sub-agents and opens one into a
  read-only overlay. — demonstrated by `[VC-3]`
- `[SO-4]` The overlay shows the child's persisted conversation as it grows, with tool output
  collapsed by default and expandable in place. — demonstrated by `[VC-4.1]`, `[VC-6]`
- `[SO-5]` Opening, scrolling, toggling, and closing the overlay send nothing to the child and leave
  the host's tools-expanded state unchanged. — demonstrated by `[VC-5]`
- `[SO-6]` In fullscreen mode, the mouse wheel and trackpad scroll the overlay and never the
  transcript behind it. Once scrolled up, a jump-to-latest label returns to the newest message.
  — demonstrated by `[VC-7]`, `[VC-8]`
- `[SO-7]` No status entry or feature-health notification carries an icon, and feature descriptors
  declare only a status name. The background-poll entry puts its elapsed time in parentheses.
  — demonstrated by `[VC-2]`, `[VC-9]`, `[VC-10]`

## Contracts

| ID       | Kind      | Contract                                                                                                                          | Anchor                                     |
| -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `[CT-1]` | api       | `/subagents` command, no arguments, registered by `src/features/subagents/index.ts` next to the tools                             | `src/features/subagents/index.ts:229`      |
| `[CT-3]` | config    | Status entry `subagents`: `{ priority: 30, tone: 'muted', text: '1 sub-agent' \| '<N> sub-agents' }`; absent when N is 0          | `src/features/subagents/subagents.ts:144`  |
| `[CT-6]` | invariant | The viewer issues no `RpcCommand` to any child and never calls `ctx.ui.setToolsExpanded`                                          | `src/features/subagents/viewer.ts:370`     |
| `[CT-8]` | config    | Status entry `background-poll` text: `<N> background poll(s) (<formatElapsed(oldest)>)`, for example `2 background polls (1m05s)` | `src/features/background_poll/poll.ts:223` |

### [CT-2] Running-agent accessor

Kind: api · Anchor: `src/features/subagents/subagents.ts:416`

```ts
interface RunningAgentView {
  readonly agent_id: string
  readonly model: string
  readonly name?: string
  readonly status: 'starting' | 'working' | 'idle' | 'blocked'
  readonly cwd: string
  /** From `get_state`; undefined until the spawn handshake completes. */
  readonly session_file?: string
}

// Added to the object returned by makeSubagentHandlers. Same ownership filter as `list`, spawn order.
running: (ctx: ExtensionContext) => readonly RunningAgentView[]
```

`Child` gains `cwd` and `sessionFile`. `list_agents` output is unchanged; the session file path is
not exposed to the parent agent.

### [CT-4] Footer line

Kind: api · Anchor: `src/features/status_panel/footer.ts:54`

```ts
renderFooterLine(model: ModelInfoState, statuses: readonly StatusEntry[], theme: StatusTheme, width: number): string
```

```text
ctx ■■······ 12.5% · 34k / 272k            1 background poll (12s) · 2 sub-agents · cache 87% · 42 tok/s
```

Each entry renders as `entry.text` in its tone's color, joined by `·`, in
`statusBar.list()` order, followed by the metrics. Tone maps to `ThemeColor`: `muted` → `muted`,
`info` → `accent`, `success` → `success`, `warning` → `warning`, `error` → `error`; no tone is
`muted`. The panel subscribes to `statusBar.subscribe` while installed and requests a render on each
change, and unsubscribes on session shutdown. With no entries, the line equals today's output.

### [CT-5] Transcript overlay

Kind: boundary · Anchor: `src/features/subagents/viewer.ts:232`

```text
╭─ Review auth · anthropic/claude-opus-5-5 · working ───────────────╮
│ <user, assistant, tool, and compaction-marker components>         │
╰─ ↑↓ scroll · pgup/pgdn page · ctrl+o expand tools · esc close ────╯
```

Opened with `ctx.ui.custom(…, { overlay: true, overlayOptions: { width: '80%', maxHeight: '80%' } })`.
The frame is drawn in `theme.fg('border')`. The title is `<name ?? agent_id> · <model> · <status>`,
with status `exited` once the child leaves the running set. The body is a `ScrollView` with
`follow: 'end'`: it follows new content until the user scrolls up, and follows again once scrolled
back to the end. Pi lays out `ScrollView`s only in the main view, so the overlay calls
`updateLayout(contentHeight, bodyHeight, requestRender)` itself and renders the visible slice.

| Input                        | Effect                                                   |
| ---------------------------- | -------------------------------------------------------- |
| `↑` / `↓`                    | Scroll one line                                          |
| `pgup` / `pgdn`              | Scroll one viewport                                      |
| Wheel or trackpad            | `scrollBy(event.wheelDelta)`; always `{ handled: true }` |
| `tui.altScreen.bottom`       | `scrollToEnd()`                                          |
| Left click on the jump label | `scrollToEnd()`                                          |
| `app.tools.expand`           | Toggle every tool component in the overlay               |
| `esc` / `q`                  | Close                                                    |

Pi computes `wheelDelta` from the `fullscreenWheelScrollLines` setting, and Alt multiplies it by 5.
The overlay reads it as given.

The jump label is shown only while the body is not following the end. It is centred on the last
body row, inside the frame:

```ts
theme.bg('selectedBg', theme.fg('text', ` ↓ Jump to latest message · ${shortcut} `))
```

The text and style match the label Pi draws in its main view. `shortcut` is
`keybindings.getKeys('tui.altScreen.bottom')` from the `ctx.ui.custom` factory, formatted like Pi's
unexported `keyDisplayText`: each `+` part capitalized, `alt` shown as `option` on macOS, keys joined
by `/`. With the default keybindings it reads `Ctrl+End`.

A missing or empty session file renders `No messages yet.`. A collapsed display-only tool result
shows its first 3 lines, then `… (N more lines, <expand key> to expand)`. A toggle survives refresh
rebuilds.

`/subagents` outcomes:

| Situation                       | Result                                                       |
| ------------------------------- | ------------------------------------------------------------ |
| `ctx.mode !== 'tui'`            | `notify('/subagents needs the interactive TUI.', 'warning')` |
| No running children             | `notify('No running sub-agents.', 'info')`                   |
| Selection dismissed             | Nothing                                                      |
| Child left before the selection | `notify('Agent <id> is no longer running.', 'warning')`      |
| Otherwise                       | Overlay for the chosen child                                 |

Select options read `<name ?? agent_id> · <model> · <status>`.

### [CT-7] Icon-free status shapes

Kind: type · Anchor: `src/shared/state/status_bar.ts:7`

```ts
// src/shared/state/status_bar.ts
interface StatusItem {
  text: string
  tone?: StatusTone
  priority?: number
}

// src/shared/effect/feature.ts
interface FeatureStatusMetadata {
  readonly name: string
}
```

`formatStatusText` is removed: status channels mirror `entry.text` into Pi's status registry
unchanged. The coordinator's descriptor validation requires a nonempty string `status.name` and no
longer reads `icon`. A feature-health error publishes
`<name>: <reason>` and notifies the same text. The meridian warning publishes and notifies
`meridian: <warning>`.

## Acceptance

- `[VC-1]` Given two children spawned through the fake `pi`, the status bar lists `subagents` with
  text `2 sub-agents`. After `close_agent` on one, it reads `1 sub-agent`. After the other exits, the
  entry is absent. A child spawned and still running at session shutdown leaves no entry.
  — demonstrates `[SO-1]`
- `[VC-2]` `renderFooterLine` with the tagged theme and entries `{ key: 'subagents', priority: 30,
tone: 'muted', text: '2 sub-agents' }` and `{ key: 'feature:x', priority: 10, tone: 'error', text:
'x failed' }` yields the right column `<error>x failed · <muted>2 sub-agents · <muted>cache 87% ·
42 tok/s`. Publishing a status entry while the panel is installed triggers
  `requestRender`. — demonstrates `[SO-2]`
- `[VC-3]` With no children, `/subagents` notifies `No running sub-agents.`. With children `a`
  (named `Scout`) and `b` from this session and `c` owned by another parent session file, the select
  receives exactly `Scout · <model> · working` and `b · <model> · working`, and choosing `b` opens
  `ui.custom` with `overlay: true`. — demonstrates `[SO-3]`
- ~~`[VC-4]` Given a session file with a user message, an assistant message with a thinking block and
  `read` and `ffgrep` tool calls, their 20-line results, and a compaction entry: the rendered overlay
  contains the user text, the thinking text, the compaction marker, the first lines of each result,
  and `more lines`, and does not contain line 20. After the expand key, line 20 of both results is
  visible. After an assistant message is appended to the file and the refresh tick runs, its text is
  visible and the expansion is kept.~~
- `[VC-4.1]` As `[VC-4]`, except that collapsed, the `read` call shows its path and no output, while
  the `ffgrep` result shows its first lines and `more lines`. Neither result shows line 20 until the
  expand key. Pi's `read` renderer, required by `[KD-7]`, draws no output while collapsed.
  — demonstrates `[SO-4]`
- `[VC-5]` With the overlay open on a fake child, after scrolling, toggling, and closing, the fake
  child's `stdin.jsonl` holds only the spawn handshake records, and `setToolsExpanded` was never
  called. — demonstrates `[SO-5]`
- `[VC-6]` When the viewed child exits while the overlay is open, the title ends with `· exited` and
  the previously rendered messages remain. — demonstrates `[SO-4]`
- `[VC-7]` Given an overlay whose content is longer than its body and that is following the end, a
  wheel event with `wheelDelta: -3` returns `handled: true` and lowers `scrollTop` by 3. A wheel
  event with `wheelDelta: 3` at the end returns `handled: true` and leaves `scrollTop` unchanged.
  — demonstrates `[SO-6]`
- `[VC-8]` Given the same overlay, the rendered lines contain no `Jump to latest message` while it
  follows the end. After a wheel up, the last body row contains `↓ Jump to latest message ·` and the
  `tui.altScreen.bottom` key text. An assistant message appended to the session file and refreshed
  then leaves `scrollTop` unchanged. Each of a left press on the label and the
  `tui.altScreen.bottom` key brings the new message into view and removes the label.
  — demonstrates `[SO-6]`
- `[VC-9]` After one background poll registers, Pi's status registry holds `1 background poll (0s)`
  under `background-poll`, and one second later `1 background poll (1s)`. — demonstrates `[SO-7]`
- `[VC-10]` A test registry holding a descriptor with `status: { name: 'x' }` and no `icon`
  registers. When its activation fails with reason `r`, Pi's status registry holds `x: r` under
  `feature:x` and the user is notified `x: r`. An unavailable Meridian notifies
  `meridian: unavailable`. — demonstrates `[SO-7]`

## Caveats

- `[C-1]` Pi writes a session file only once it holds a user or assistant message
  (`SessionManager._persist`), and each message only at `message_end`. A starting child shows
  `No messages yet.`, and the overlay lags the child by one message.
- `[C-2]` Every refresh after a size change re-parses the whole file. A very long child session
  costs one full parse per 500 ms tick while it grows.
- `[C-3]` `[KD-3]` changes shipped `status_panel` behaviour: background polls and feature-health
  errors become visible in its footer. Existing `renderFooterLine` tests keep their expectations
  through an empty `statuses` argument.
- `[C-4]` A prior transcript overlay exists in git at `6d52467^:src/features/sub_agents/transcript.ts`
  (branch projection, display-only definitions, frame). It predates Pi 1.4.0 and the removal of
  built-in renderer fallback.
- `[C-5]` Behaviour of `spawn_agent`, `send_message`, `interrupt_agent`, `close_agent`, and
  `list_agents` is unchanged and stays owned by `tests/features/subagents/subagents.spec.ts` and
  `tests/features/subagents/index.spec.ts`.
- `[C-6]` Wheel and click input reach the overlay only in Pi's default `tuiMode: "fullscreen"`. With
  `tuiMode: "regular"`, Pi does not capture the mouse: the trackpad scrolls the terminal's own scrollback,
  and the jump label is reached through `tui.altScreen.bottom` only.
- `[C-7]` `[KD-12]` and `[KD-13]` change shipped text. Pi's stock footer, used when `status_panel` is
  disabled, also loses the icons. The same change updates existing tests:
  `tests/shared/state/status_bar.spec.ts` drops its `formatStatusText` case and its icon fixtures,
  `tests/registration.spec.ts` drops the icon-uniqueness assertion, and the background-poll,
  Meridian, and coordinator tests drop icons from their expected text. It also amends
  `docs/effect_pi_boundary.spec.md` (`[G-7a]`, §8.7, §8.10, §8.12) and `docs/project_structure.md`.
