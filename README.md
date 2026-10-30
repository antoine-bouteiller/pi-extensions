# Personal Pi extensions

My personal extension for [Pi](https://github.com/earendil-works/pi)

**Requires the Bun-compiled version of Pi.**

## Install

```bash
pi install git:github.com/antoine-bouteiller/pi-extensions
```

## Features

- `ask_user` — Multiple-choice questions during a turn.
- `background_poll` — Background shell polling with completion notifications.
- `claude_code` — Load Claude commands as temporary Pi skills.
- `hashline` — Hash-anchored file reads and writes that reject stale edits.
- `meridian_session_affinity` — Session affinity and harness fingerprint scrubbing for Meridian requests.
- `peers` — Open independent Pi agents in new Herdr or Rex tabs, and discover and message other running Pi agents.
- `prompt_rewind` — Edit your prompt when cancelling before a response.
- `provider_retry` — Extend retries to server and unknown-status provider failures.
- `rules` — Load rules from `.claude/rules/` and `.agents/rules/`.
- `status_panel` — Show activity, model, and thinking in the editor border, and context, cache hit, and throughput in a one-line footer. Name the session after the current git branch, so the terminal title (and the Rex pane name) shows it, unless the session already has a name it did not set.
- `subagents` — Delegate to headless Pi sub-agents and receive their results automatically.
- `webfetch` — Fetch URLs as Markdown, text, or HTML.

## Delegation

### Sub-agents

The `subagents` feature runs delegated agents as headless children of the current session, in any
terminal. Each child is `pi --mode rpc`, started from `PATH` with this package loaded. No pane, tab,
or workspace is created.

- `spawn_agent({model,message,name?,thinking?,tools?,cwd?})` starts a child, submits its task, and
  returns its `agent_id`. `name` labels the child in results and dialogs. `thinking` sets its thinking
  level. `tools` restricts it to an allowlist (for example `["read","grep","find","ls"]`). `cwd`
  (absolute, `~/`-relative, or relative to the current directory) starts it in another folder.
- `send_message({agent_id,message})` sends a follow-up. It starts a new run when the child is idle
  and steers the current run otherwise.
- `interrupt_agent({agent_id})` clears the child's queued messages and aborts its current run.
- `close_agent({agent_id})` stops the child.
- `list_agents()` lists the session's children with their status (`starting`, `working`, `idle`,
  or `blocked`) and whether a result is awaited.

Whenever a child's run settles, its final response arrives as a `subagent-result` message that wakes
the parent, as steering at the next turn boundary if it is busy. A child that exits while a result
is awaited is reported as `exited`, with its exit code and the end of its stderr.

A child's `select`, `confirm`, `input`, and `editor` dialogs open in the parent's UI, titled with
the child's name or model, one at a time. Only the user answers them; the parent agent never sees
them. Without a UI, they are cancelled at once. `editor` dialogs cannot be dismissed when their child
goes away, and their answer is then dropped. `ask_user` in a child returns its no-UI result.

Children are tied to the parent session. Ending, reloading, or switching the session closes their
input, sends `SIGTERM` after 5 seconds, and `SIGKILL` 5 seconds later. Each child's transcript is
written under `<agent dir>/subagents/sessions/<parent session id>/`, outside `/resume`, and is
never deleted by this package. The parent session records one `subagent` entry per child with its
transcript path. Children run with `PI_SUBAGENT=1` and without `HERDR_*` or `REX_*` variables, so
they cannot spawn, open, discover, or message other agents. There is no limit on concurrent
children.

### Peers

Inside Herdr (`HERDR_ENV=1`) or Rex (`REX_SESSION` and `REX_BLOCK` set), the `peers` feature
exposes these tools. Herdr wins when both apply. Elsewhere, they fail with a message.

- `open_agent({model,message,name?,thinking?,cwd?})` opens one new tab in the caller's Herdr
  workspace or Rex session, without moving focus, runs an independent top-level Pi there, and gives
  it the task. The tab is labelled with `name`, else the model. `cwd` elsewhere opens the tab in a
  workspace or session named after the folder, reused for later opens and recreated when gone. The
  opened agent's results are not reported back.
- `discover_agents()` lists every other top-level Pi agent, across all workspaces or sessions, with
  its pane ID, workspace or session label, cwd, and status.
- `message_peer({pane_id,message})` sends a message to one of them without waiting for a response.

A peer receives a message framed as coming from another agent's pane, not from its user, and replies,
if at all, with its own `message_peer`. An opened agent's first message says it was started at the
other agent's user's request.

In Rex, each interactive Pi running this package writes a presence record to
`<agent dir>/peers/rex/presence/<block>.json` with its pid, block, session, cwd, and inbox
directory, and removes it on exit. A peer is live only while its block exists and its pid runs. Pi
agents without this package are not discoverable. Messages are written as files into the peer's
inbox, which it polls every second and deletes after delivery, so nothing is typed into its
terminal. `rex` is taken from `REX_BIN_DIR`, else `PATH`.

### Models

Configure an explicit model allowlist in `~/.pi/agent/settings.json` (or your custom Pi agent
directory). Both `spawn_agent` and `open_agent` use it:

```json
{
  "subagents": {
    "allowedModels": ["azure-openai-responses/gpt-6-astra", "azure-openai-responses/gpt-6-sol"],
    "modelNotes": {
      "azure-openai-responses/gpt-6-astra": "highest-reasoning: complex implementation, debugging, design, and deep review of Claude-produced work",
      "azure-openai-responses/gpt-6-sol": "scouting, straightforward research, routine scoped implementation, and lightweight review of Claude-produced work"
    }
  }
}
```

Entries are exact `provider/model-id` values, not patterns. Trusted project `.pi/settings.json`
can replace the list, including with `[]`; untrusted project settings are ignored. Missing or empty
lists disable spawning and opening, and so do malformed settings, including unknown fields in the
`subagents` block. A legacy `herdr` block is ignored: rename it to `subagents`. Only allowlisted
models currently available in Pi's model registry can be used; the usable list is exposed as the
choices of each tool's `model` argument, refreshed each turn, and checked again on every call.

Within that list, the agent prefers Azure OpenAI (`azure-openai-responses`) for implementation,
scouting, and research, and a different provider from the agent that produced the work for review.
These are preferences, not enforced roles. Optional `subagents.modelNotes` maps a model to a one-line
hint (at most 500 characters) shown in the `model` argument and taking precedence over those
defaults. Trusted project notes override global notes for matching model IDs.

### Upgrading from `herdr`

Children started by the previous Herdr-based version keep running in their panes; nothing reads
their results any more, so close them in Herdr. Their `herdr-agent` session entries are ignored.
The `$subagent` Herdr pane token is no longer set.

## Development

From the repository root:

```bash
bun install --frozen-lockfile
bun run fmt:check
bun run lint
bun run knip
bun run test
pi -e .
```

`lint` also type-checks through Oxlint. `bun check` runs Bun's standalone type checker.
