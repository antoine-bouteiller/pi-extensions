# Pi extensions

First-party extensions for [Pi](https://github.com/earendil-works/pi), developed as a single Bun workspace and distributed as one installable Pi package.

## Installation

```bash
pi install git:github.com/antoine-bouteiller/pi-extensions
```

`package.json` declares a `pi` manifest pointing at `extension.ts`, a single entrypoint that composes every extension under `src/*/index.ts` (see [Extensions](#extensions)) onto one `ExtensionAPI` instance, sharing one lazily-built Effect runtime (`src/effect/app_runtime.ts`) across all of them. Installing this repository through `pi install` therefore adds exactly one extension, not one per directory. `src/rtk.ts` and `src/herdr-agent-state.ts` are managed integrations (see below) and are intentionally excluded from that bundle.

## Development

For local development, `src/` is Pi's global extension directory: it is linked to `~/.pi/agent/extensions`, so Pi loads this source tree in place instead of the packaged `extension.ts` bundle. Pi auto-loads top-level `src/*.ts` files and direct child `src/*/index.ts` entrypoints; everything else must live deeper, or in a directory without an `index.ts`. Each of those entrypoints' default export falls back to the same process-wide Effect runtime that `extension.ts` injects explicitly, so the two loading paths always share one runtime instance (and therefore one `StatusBar`/`AgentActivity`) regardless of which one Pi uses.

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` runs Oxlint correctness checks, strict TypeScript checking, Knip unused-code checks, and the Bun test suite. `bun run test:coverage` additionally collects coverage.

## Layout

```text
extension.ts               packaged entrypoint: injects one runtime into every extension below
src/effect/                Pi<->Effect boundary and the shared process-wide runtime; no index.ts
src/shared/                cross-extension services (StatusBar, AgentActivity, ...); no index.ts
src/<name>/index.ts        extension entrypoint: exports `register(pi, runtime)` and a standalone default
src/<name>/*.ts            implementation modules
src/<name>/test/           colocated tests
src/<name>/test/fixtures/  child processes and other on-disk test fixtures
test/                      cross-extension discovery, registration-manifest, and managed-integration tests
test/utils/                shared typed fakes (#test-utils/fake_pi, #test-utils/casts) and the bun_effect
                           test harness (#test-utils/bun_effect), imported as #test-utils/*
```

`src/shared/` and `src/effect/` hold modules reused across extensions and deliberately have no `index.ts`, so Pi never loads either as an extension. `package.json`, `bun.lock`, `bunfig.toml`, and `.oxlintrc.json` are development infrastructure and are not Pi entrypoints.

## Effect

This package is on an Effect v4 **beta** (`effect` and `@effect/platform-node` pinned to the exact same `4.0.0-beta.102` in `package.json`, not a range) while the API surface is still moving. Renovate remains enabled, but every proposed Effect update stays exact and must pass the full CI suite. `test/utils/bun_effect.ts` is a local Bun-native `it.effect`/`it.scoped`/`it.live` shim standing in for `@effect/bun-test`, which does not exist yet ([Effect-TS/effect#5973](https://github.com/Effect-TS/effect/pull/5973)); replace it once that package ships.

## Extensions

| Extension                   | Purpose                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ask-user`                  | Asks the user a multiple-choice question mid-turn                                                           |
| `background-poll`           | Polls a shell command in the background and wakes the agent when it succeeds                                |
| `claude-code`               | Converts global and trusted-project `.claude/commands/` files into temporary Pi skills                      |
| `comment-checker`           | Runs the `comment-checker` binary after successful writes and edits, appending warnings to the tool result  |
| `hashline`                  | Content-hash anchored file reads and writes that reject stale edits                                         |
| `mcp`                       | One deliberately narrow, lazy MCP gateway (see below)                                                       |
| `meridian-session-affinity` | Adds Pi's current session ID to Meridian requests so SDK sessions resume across client-side tool loops      |
| `rules`                     | Loads recursive `.md` and `.mdc` rules from `.claude/rules/` and `.agents/rules/`                           |
| `safe-rm`                   | Validated deletion that refuses credentials, Git repositories, and paths outside the working directory      |
| `safety-guard`              | Blocks recognized destructive shell commands and protected-path access                                      |
| `status-panel`              | Renders a docked status sidebar with model, context usage, git state, provider quota, and running subagents |
| `sub-agents`                | Session-scoped subagents in isolated child Pi processes ([details](src/sub-agents/README.md))               |
| `webfetch`                  | Fetches a URL and returns markdown, plain text, or raw HTML                                                 |

`mcp/` is backed only by `~/.config/mcp/mcp.json`. It supports stdio and HTTP/SSE tools plus automatic loopback OAuth through `/mcp-auth`, with reusable credentials stored in the macOS Keychain, and opens no connections during startup. URL-only HTTP servers such as Linear (`https://mcp.linear.app/mcp`) auto-detect OAuth after a 401 challenge, so they do not need an empty `"oauth": {}` block. Custom HTTP headers suppress this implicit detection unless `oauth` is explicitly configured.

`rules/` injects unscoped rules statically; path-scoped rules are injected after matching file-tool results.

## Managed integrations

`src/herdr-agent-state.ts` is generated by Herdr and `src/rtk.ts` is maintained by RTK. Do not refactor or edit either implementation here; add compatibility tests in `test/` instead.
