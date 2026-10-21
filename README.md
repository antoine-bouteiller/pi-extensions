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
- `herdr` — Delegate to Pi agents in Herdr panes, receive their results automatically, and message other running Pi agents.
- `meridian_session_affinity` — Session affinity and harness fingerprint scrubbing for Meridian requests.
- `prompt_rewind` — Edit your prompt when cancelling before a response.
- `provider_retry` — Extend retries to server and unknown-status provider failures.
- `rules` — Load rules from `.claude/rules/` and `.agents/rules/`.
- `status_panel` — Show model, context, Git, and provider limits.
- `webfetch` — Fetch URLs as Markdown, text, or HTML.

## Delegation

Inside a Herdr-managed pane, the `herdr` feature exposes these Pi tools:

- `spawn_agent({model,message,name?,thinking?,tools?,cwd?})` creates a Pi agent in a separate Herdr
  **Agents** tab, submits its initial task, and returns the pane ID. Each parent session reuses its
  Agents tabs, with at most four panes per tab, creating another when full. The current directory
  and focus are preserved. `name` labels the pane, `thinking` sets the child's thinking level, and
  `tools` restricts the child to an allowlist (for example `["read","grep","find","ls"]`). `cwd`
  (absolute, `~/`-relative, or relative to the current directory; meant for when the user asks for
  another folder or project) starts the child in a new Herdr workspace for that folder instead. Later
  spawns into the same folder from the same session reuse that workspace's tabs, and a closed workspace
  is recreated.
- `send_message({pane_id,message})` sends a follow-up to a spawned agent, or a message to a peer,
  without waiting for a response.
- `interrupt_agent({pane_id})` sends Escape to cancel a spawned agent's current turn; the agent stays open.
- `list_agents()` lists spawned agents with their Herdr status and whether a result is awaited.
- `discover_agents()` lists every other Pi agent running in Herdr, across all workspaces, with its
  workspace, cwd, status, and role: `spawned` (by this session), `peer` (another top-level agent),
  or `delegated` (another session's child).
- `close_pane({pane_id})` closes a pane spawned by the current Pi session.

Peers are top-level Pi agents. A peer receives a message framed as coming from another agent's pane,
not from its user, and replies, if at all, with its own `send_message`. Nothing reports back
automatically. Agents delegated by another session cannot be messaged, because their responses go to
their own parent. Delegated agents are recognized by the `pi-<8 hex>` Herdr agent name that
`spawn_agent` assigns.

Each spawned pane carries a display-only Herdr pane token, `subagent`, set to the child's name, or
its model when unnamed. Herdr's Agent sidebar rows can show it as `$subagent`. For example, in
Herdr's `config.toml`:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "machine", "workspace", "tab"], ["agent", { token = "$subagent", dim = true }]]
```

Herdr has no setting to hide an agent from the sidebar. Its rules style or hide one token based
on that token's own value, so the token marks children but cannot dim or remove their whole entry.

Delegated agents get none of these tools, so they cannot delegate, discover, or message other panes. Whenever
a child's run settles, its final response is written atomically to a separate record in
`<child session>.jsonl.exit.d/`. The parent polls those records and the child's Herdr pane every
few seconds and delivers a `herdr-agent-result` message that wakes it (as steering at the next
turn boundary if it is busy) for each result, for a blocked approval prompt, and for an agent that
exits or loses its pane while a result is awaited.
The parent can finish its turn while leaving Pi running. Detailed reviews can use a temporary
handoff file referenced in the child's final response. Spawned panes are recorded in the parent
session with their original owner and outstanding request, so they survive a Pi reload or restart
without granting forked sessions control of the original parent's agents. `awaiting_result` clears
when the latest request's result is queued for delivery; it does not indicate that the parent has
consumed it. Legacy ownership records without a parent identity are not restored; close those
panes manually in Herdr before spawning replacements.

Configure an explicit model allowlist in `~/.pi/agent/settings.json` (or your custom Pi agent directory):

```json
{
  "herdr": {
    "allowedModels": ["azure-openai-responses/gpt-6-astra", "azure-openai-responses/gpt-6-sol"],
    "modelNotes": {
      "azure-openai-responses/gpt-6-astra": "highest-reasoning: complex implementation, debugging, design, and deep review of Claude-produced work",
      "azure-openai-responses/gpt-6-sol": "scouting, straightforward research, routine scoped implementation, and lightweight review of Claude-produced work"
    }
  }
}
```

Entries are exact `provider/model-id` values, not patterns. Trusted project `.pi/settings.json`
can replace the list, including with `[]`; untrusted project settings are ignored. Missing or
empty lists disable spawning. Malformed settings also block spawning. Only allowlisted models
currently available in Pi's model registry can be spawned; the usable list is exposed directly as
choices in `spawn_agent`'s `model` argument and checked again before creating a pane. The argument
schema refreshes each turn; settings are reread each turn and spawn.

Within that list, the agent prefers Azure OpenAI (`azure-openai-responses`) for implementation,
scouting, and research, and a different provider from the agent that produced the work for review.
These are preferences, not enforced roles; explicit user model choices must also satisfy the allowlist.
Optional `herdr.modelNotes` maps a model to a one-line hint (at most 500 characters) shown in
`spawn_agent`'s `model` argument and taking precedence over those defaults. Notes guide selection;
they do not enforce model roles. Only notes for allowed, available models are shown.
Trusted project notes override global notes for matching model IDs; other global notes remain.
Herdr manages the Pi processes. A result written while the parent is not running is delivered
after it restarts if the child's pane is still open. Read and verify a delegate's result before relying on it.
Panes are not automatically closed on parent exit.
Requires `herdr` and `pi` on `PATH` and access to the chosen model. Old `subagents` settings
are no longer read; saved sessions are left untouched.

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
