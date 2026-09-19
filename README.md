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
- `mcp` — MCP gateway with discovery, tool selection, and OAuth.
- `meridian_session_affinity` — Session affinity and harness fingerprint scrubbing for Meridian requests.
- `prompt_rewind` — Edit your prompt when cancelling before a response.
- `provider_retry` — Extend retries to server and unknown-status provider failures.
- `rules` — Load rules from `.claude/rules/` and `.agents/rules/`.
- `status_panel` — Show model, context, Git, provider limits, and subagents.
- `sub_agents` — Delegate research, review, and implementation to isolated agents.
- `webfetch` — Fetch URLs as Markdown, text, or HTML.

## Development

From the repository root:

```bash
bun install --frozen-lockfile
bun run check
pi -e ./src/index.ts
```

`check` runs formatting, linting/type checking, unused-code checks, and tests.
