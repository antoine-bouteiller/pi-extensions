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
- `comment_checker` — Check comments after file edits.
- `hashline` — Hash-anchored file reads and writes that reject stale edits.
- `herdr` — Delegate to Pi agents in Herdr panes with three native tools.
- `mcp` — MCP gateway with discovery, tool selection, and OAuth.
- `meridian_session_affinity` — Session affinity and harness fingerprint scrubbing for Meridian requests.
- `prompt_rewind` — Edit your prompt when cancelling before a response.
- `provider_retry` — Extend retries to server and unknown-status provider failures.
- `rules` — Load rules from `.claude/rules/` and `.agents/rules/`.
- `status_panel` — Show model, context, Git, and provider limits.
- `webfetch` — Fetch URLs as Markdown, text, or HTML.

## Delegation

Inside a Herdr-managed pane, the `herdr` feature exposes three Pi tools:

- `spawn_agent({model,message})` creates a Pi agent in a Herdr pane, submits its initial task,
  and returns the pane ID.
- `send_message({pane_id,message})` sends a follow-up or a child's conclusion to its parent,
  without waiting for a response.
- `close_pane({pane_id})` closes a pane spawned by the current Pi session.

Children receive their parent address and reply instructions automatically. The parent can finish
its turn while leaving Pi running; a child's message resumes it or queues input if it is busy.
Detailed reviews can use a temporary handoff file plus a short completion message.

The agent chooses an available model suited to the task, preferring Azure OpenAI
(`azure-openai-responses`) for implementation, scouting, and research, and a different provider
from the agent that produced the work for review. These are preferences, not a fixed model list
or enforced roles; explicit user model choices take precedence.
Herdr manages the Pi processes; there is no sub-agent orchestrator or durable delivery queue. Replies are agent-driven: provider failures or crashes can prevent them. Read and verify
a delegate's result before relying on it. Panes are not automatically closed on parent exit;
after Pi reload/restart, manage previously created panes directly in Herdr.
Requires `herdr` and `pi` on `PATH` and access to the chosen model. Old `subagents` settings
are no longer read; saved sessions are left untouched.

## Development

From the repository root:

```bash
bun install --frozen-lockfile
bun run check
pi -e .
```

`check` runs formatting, linting/type checking, unused-code checks, and tests.
