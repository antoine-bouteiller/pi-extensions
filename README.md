# Pi extensions

First-party extensions for [Pi](https://github.com/earendil-works/pi), developed as a single Bun workspace and distributed as one installable Pi package.

## Installation

```bash
pi install git:github.com/antoine-bouteiller/pi-extensions
```

`package.json` declares a `pi` manifest pointing at `src/index.ts`, the single Pi extension entrypoint for this package. `src/index.ts` obtains one lazily-built, memoised Effect runtime (`src/config/runtime.ts`) and passes it to the ordered feature registry in `src/config/features.ts`, which registers every capability under `src/features/` (see [Features](#features)) onto one `ExtensionAPI` instance. Installing this repository through `pi install` therefore adds exactly one extension, not one per capability. Features are internal capabilities of that one extension, not separately installed or independently loadable extensions.

## Development

For local development, `src/` is Pi's global extension directory: it is linked to `~/.pi/agent/extensions`, so Pi loads this source tree in place instead of the packaged bundle. Pi's local auto-discovery loads only the top-level `src/index.ts` entrypoint; nothing under `src/config/`, `src/features/`, or `src/shared/` has a direct-child `index.ts`, so none of it is separately auto-discovered. See [`docs/project_structure.md`](docs/project_structure.md) for the full folder and dependency contract.

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` runs Oxlint correctness checks, strict TypeScript checking, Knip unused-code checks, and the Bun test suite. `bun run test:coverage` additionally collects coverage.

## Layout

```text
src/index.ts               the only Pi extension entrypoint/default export
src/config/                composition only: the ordered feature registry and runtime; no index.ts
src/features/<name>/       one capability per snake_case folder, exporting named `register(pi, runtime)`; no index.ts
src/shared/                cross-feature Effect boundary, state, and utilities; no index.ts
tests/<mirrors src/>       tests mirror the source tree, using `.spec.ts`
tests/utils/               shared typed fakes and the bun_effect test harness, imported as @tests/utils/*
```

See [`docs/project_structure.md`](docs/project_structure.md) for the full dependency-direction and import-alias contract. `src/config/`, `src/features/`, and `src/shared/` deliberately have no direct-child `index.ts`, so Pi never auto-discovers any of them as a separate extension. `package.json`, `bun.lock`, and `bunfig.toml` are development infrastructure and are not Pi entrypoints.

## Effect

This package is on an Effect v4 **beta** (`effect` and `@effect/platform-bun` pinned to the exact same `4.0.0-beta.107` in `package.json`, not a range) while the API surface is still moving. Renovate remains enabled, but every proposed Effect update stays exact and must pass the full CI suite. `tests/utils/bun_effect.ts` is a local Bun-native `it.effect`/`it.scoped`/`it.live` shim standing in for `@effect/bun-test`, which does not exist yet ([Effect-TS/effect#5973](https://github.com/Effect-TS/effect/pull/5973)); replace it once that package ships.

## Features

Each row below is one internal capability registered by `src/config/features.ts`, not a separately installed or independently loadable extension.

| Feature                     | Purpose                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ask_user`                  | Asks the user a multiple-choice question mid-turn                                                           |
| `background_poll`           | Polls a shell command in the background and wakes the agent when it succeeds                                |
| `caffeinate`                | Prevents macOS idle sleep while the parent Pi session is running                                            |
| `claude_code`               | Converts global and trusted-project `.claude/commands/` files into temporary Pi skills                      |
| `comment_checker`           | Runs the `comment-checker` binary after successful writes and edits, appending warnings to the tool result  |
| `hashline`                  | Content-hash anchored file reads and writes that reject stale edits                                         |
| `mcp`                       | One deliberately narrow, lazy MCP gateway (see below)                                                       |
| `meridian_session_affinity` | Adds Pi's current session ID to Meridian requests so SDK sessions resume across client-side tool loops      |
| `prompt_rewind`             | Escape before the first assistant output rewinds the cancelled prompt and restores its raw text for editing |
| `rules`                     | Loads recursive `.md` and `.mdc` rules from `.claude/rules/` and `.agents/rules/`                           |
| `safe_rm`                   | Validated deletion that refuses credentials, Git repositories, and paths outside the working directory      |
| `safety_guard`              | Routes simple literal `rm` through `safe_rm`; blocks complex destructive shell commands and protected paths |
| `status_panel`              | Renders a docked status sidebar with model, context usage, git state, provider quota, and running subagents |
| `sub_agents`                | Session-scoped subagents in isolated child Pi processes ([details](src/features/sub_agents/README.md))      |
| `webfetch`                  | Fetches a URL and returns markdown, plain text, or raw HTML                                                 |

`mcp/` is backed only by `~/.config/mcp/mcp.json`. It supports stdio and HTTP/SSE tools plus automatic loopback OAuth through `/mcp-auth`, with reusable credentials stored in the macOS Keychain, and opens no connections during startup. URL-only HTTP servers such as Linear (`https://mcp.linear.app/mcp`) auto-detect OAuth after a 401 challenge, so they do not need an empty `"oauth": {}` block. Custom HTTP headers suppress this implicit detection unless `oauth` is explicitly configured.

`rules/` injects unscoped rules statically; path-scoped rules are injected after matching file-tool results.
