# Pi extensions

[![codecov](https://codecov.io/gh/antoine-bouteiller/pi-extensions/graph/badge.svg)](https://codecov.io/gh/antoine-bouteiller/pi-extensions)

First-party extensions for [Pi](https://github.com/earendil-works/pi), built as a single Bun workspace and shipped as one installable Pi package.

## Installation

```bash
pi install git:github.com/antoine-bouteiller/pi-extensions
```

The `pi` manifest in `package.json` points at `src/index.ts`, the package's only extension entrypoint. It builds one lazy, memoised Effect runtime (`src/config/runtime.ts`) and hands it to the ordered registry in `src/config/features.ts`, which registers every capability under `src/features/` onto a single `ExtensionAPI`. Installing this repository adds exactly one extension; the features listed below are internal capabilities of it, never separately loadable.

## Development

Link `src/` into Pi's global extension directory (`~/.pi/agent/extensions`) and Pi loads this source tree in place instead of the bundle.

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` runs Oxfmt, Oxlint, Knip, and the Bun test suite. `bun run test:coverage` adds coverage.

**Type checking lives inside Oxlint.** `oxlint.config.ts` enables `options.typeAware` and `options.typeCheck`, and `oxlint-tsgolint` does the analysis, so `bun run lint` _is_ the type gate, locally and in CI. No separate type-check step is needed.

`bun run typecheck` (`tsc --noEmit`) is advisory only. It exists to surface [`@effect/language-service`](https://github.com/Effect-TS/language-service) suggestions such as `processEnv`, `globalTimers`, and `nodeBuiltinImport`. Those are warnings, but they still make `tsc` exit non-zero, so the script is expected to fail and is excluded from `check` and CI. Every remaining warning is a reviewed exception, recorded in the `overrides` block of `oxlint.config.ts` or as a scoped `oxlint-disable` comment.

## Layout

```text
src/index.ts                  the only Pi extension entrypoint/default export
src/config/                   composition only: ordered feature registry and runtime
src/features/                 one capability per snake_case folder
src/features/<name>/index.ts  the feature's only registration site, exporting `register(pi, runtime)`
src/shared/                   cross-feature Effect boundary, state, and utilities
tests/<mirrors src/>          tests mirror the source tree, using `.spec.ts`
tests/utils/                  shared typed fakes and the bun_effect harness, imported as @tests/utils/*
```

Only a direct-child `index.ts` is auto-discovered, so `src/config/`, `src/features/`, and `src/shared/` deliberately have none. See [`docs/project_structure.md`](docs/project_structure.md) for the dependency-direction and import-alias contract.

## Effect

This package tracks an Effect v4 prerelease while the API surface keeps moving, so every Effect update must pass full CI. `tests/utils/bun_effect.ts` is a local Bun-native `it.effect`/`it.scoped`/`it.live` shim standing in for `@effect/bun-test`, which does not exist yet ([Effect-TS/effect#5973](https://github.com/Effect-TS/effect/pull/5973)); drop it once that package ships.

## Features

| Feature                     | Purpose                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ask_user`                  | Asks the user a multiple-choice question mid-turn                                                           |
| `background_poll`           | Polls a shell command in the background and wakes the agent when it succeeds                                |
| `caffeinate`                | Prevents macOS idle sleep while the parent Pi session runs                                                  |
| `claude_code`               | Converts global and trusted-project `.claude/commands/` files into temporary Pi skills                      |
| `comment_checker`           | Runs the `comment-checker` binary after successful writes and edits, appending warnings to the tool result  |
| `hashline`                  | Content-hash anchored file reads and writes that reject stale edits                                         |
| `mcp`                       | One deliberately narrow, lazy MCP gateway (see below)                                                       |
| `meridian_session_affinity` | Adds Pi's session ID to Meridian requests so SDK sessions resume across client-side tool loops              |
| `prompt_rewind`             | Escape before the first assistant output restores the cancelled prompt's raw text for editing               |
| `rules`                     | Loads recursive `.md` and `.mdc` rules from `.claude/rules/` and `.agents/rules/`                           |
| `safe_rm`                   | Validated deletion that refuses credentials and paths outside the working directory                         |
| `safety_guard`              | Routes simple literal `rm` through `safe_rm`; blocks complex destructive shell commands and protected paths |
| `status_panel`              | Docked status sidebar with model, context usage, git state, provider quota, and running subagents           |
| `sub_agents`                | Session-scoped subagents in isolated child Pi processes ([details](src/features/sub_agents/README.md))      |
| `webfetch`                  | Fetches a URL and returns markdown, plain text, or raw HTML                                                 |

`mcp` reads only `~/.config/mcp/mcp.json`. It supports stdio and HTTP/SSE tools plus automatic loopback OAuth through `/mcp-auth`, stores reusable credentials in the macOS Keychain, and opens no connections at startup. URL-only HTTP servers such as Linear (`https://mcp.linear.app/mcp`) auto-detect OAuth after a 401 challenge, so they need no empty `"oauth": {}` block; custom HTTP headers suppress that detection unless `oauth` is set explicitly.

`rules` injects unscoped rules statically; path-scoped rules are injected after matching file-tool results.
