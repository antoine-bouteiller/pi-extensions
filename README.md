<h1 align="center">Pi extensions</h1>

<p align="center">
  <a href="https://github.com/antoine-bouteiller/pi-extensions/actions/workflows/quality-checks.yaml"><img alt="Quality Checks" src="https://img.shields.io/github/actions/workflow/status/antoine-bouteiller/pi-extensions/quality-checks.yaml?branch=main&amp;style=for-the-badge&amp;logo=githubactions&amp;logoColor=cad3f5&amp;labelColor=363a4f"></a>
  <a href="https://codecov.io/gh/antoine-bouteiller/pi-extensions"><img alt="Codecov" src="https://img.shields.io/codecov/c/github/antoine-bouteiller/pi-extensions?style=for-the-badge&amp;logo=codecov&amp;logoColor=cad3f5&amp;colorA=363a4f"></a>
  <a href="https://bun.sh/"><img alt="Bun" src="https://img.shields.io/badge/runtime-Bun-eed49f?style=for-the-badge&amp;logo=bun&amp;logoColor=cad3f5&amp;labelColor=363a4f"></a>
</p>

These are official extensions for [Pi](https://github.com/earendil-works/pi). They are built using a single Bun workspace and are installed as one package.

## Installation

```bash
pi install git:github.com/antoine-bouteiller/pi-extensions
```

The `package.json` file directs Pi to `src/index.ts`, which is the only entry point for the extension. It creates one memoized Effect runtime (`src/config/runtime.ts`) and gives it to an ordered registry in `src/config/features.ts`. This registry attaches every capability found in `src/features/` to a single `ExtensionAPI`. When you install this repository, you are adding exactly one extension; the features listed below are parts of that extension and cannot be loaded individually.

## Development

To develop, link the `src/` directory to Pi's global extension folder (`~/.pi/agent/extensions`). Pi will then load the source code directly instead of the built version.

```bash
bun install --frozen-lockfile
bun run check
```

The command `bun run check` runs Oxfmt, Oxlint, Knip, and the Bun test suite. Use `bun run test:coverage` to see test coverage.

**Type checking is handled by Oxlint.** The `oxlint.config.ts` file enables `options.typeAware` and `options.typeCheck`. Because `oxlint-tsgolint` performs the analysis, `bun run lint` serves as the type check for both local development and CI. You do not need a separate type-checking step.

`bun run typecheck` (`tsc --noEmit`) is for information only. It is used to show suggestions from [`@effect/language-service`](https://github.com/Effect-TS/language-service), such as `processEnv`, `globalTimers`, and `nodeBuiltinImport`. These are technically warnings, but they cause `tsc` to fail, so the script is expected to error out. Because of this, it is excluded from `check` and CI. Any other warnings are intentionally allowed via the `overrides` block in `oxlint.config.ts` or via `oxlint-disable` comments.

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

Only an `index.ts` file located directly inside a folder is automatically discovered. For this reason, `src/config/`, `src/features/`, and `src/shared/` do not contain `index.ts` files. See [`docs/project_structure.md`](docs/project_structure.md) for rules regarding imports and dependencies.

## Effect

This package uses a pre-release version of Effect v4. Because the API changes frequently, every Effect update must pass the full CI suite. The file `tests/utils/bun_effect.ts` is a custom shim for `it.effect`, `it.scoped`, and `it.live` to replace `@effect/bun-test`, which is not yet available ([Effect-TS/effect#5973](https://github.com/Effect-TS/effect/pull/5973)). Replace this shim once the official package is released.

## Features

| Feature                     | Purpose                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ask_user`                  | Asks the user a multiple-choice question during a turn.                                                          |
| `auto_theme`                | Follows the system light/dark appearance on macOS, Windows, and Freedesktop desktops.                            |
| `background_poll`           | Runs a shell command in the background and alerts the agent when it succeeds.                                    |
| `caffeinate`                | Prevents macOS from sleeping while a Pi session is active.                                                       |
| `claude_code`               | Turns `.claude/commands/` files in global or trusted projects into temporary Pi skills.                          |
| `comment_checker`           | Runs the `comment-checker` tool after file edits and adds any warnings to the result.                            |
| `hashline`                  | Replaces `read` and `write` with content-hash-anchored file operations that reject stale edits.                  |
| `mcp`                       | A specific, limited MCP gateway (see details below).                                                             |
| `meridian_session_affinity` | Includes Pi's session ID in Meridian requests so sessions stay active across tool loops.                         |
| `prompt_rewind`             | Allows you to edit your original prompt if you cancel before the assistant responds.                             |
| `rules`                     | Loads `.md` and `.mdc` rules from `.claude/rules/` and `.agents/rules/`.                                         |
| `safety_guard`              | Provides `safe_rm`, redirects simple `rm` commands through it, and blocks dangerous commands or protected paths. |
| `status_panel`              | A sidebar showing the model, context usage, git status, provider limits, and active subagents.                   |
| `sub_agents`                | Creates session-specific subagents in separate Pi processes ([details](src/features/sub_agents/README.md)).      |
| `webfetch`                  | Fetches a URL and provides the content as markdown, plain text, or HTML.                                         |

The `mcp` feature only reads `~/.config/mcp/mcp.json`. It supports tools via stdio and HTTP/SSE, uses the system keyring to store credentials, and does not open connections at startup. It also handles automatic OAuth through `/mcp-auth`. For HTTP servers like Linear (`https://mcp.linear.app/mcp`), OAuth is detected automatically after a 401 error, so no extra configuration is needed. Custom HTTP headers will stop this automatic detection unless `oauth` is manually set.

The `rules` feature injects general rules immediately. Rules specific to a file path are injected after a tool's result matches a file.
