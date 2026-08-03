# pi-codex-subagents

Codex-shaped, session-scoped subagents for [Pi](https://github.com/earendil-works/pi). Spawn isolated child Pi processes, receive their final responses automatically, steer active work, and inspect sessions in a live full-chat view.

Requires Pi 0.80.4 or newer and Node.js 22.19 or newer.

## Deployment

This capability is maintained in the [`pi-extensions`](../../..) repository as one internal feature of that package's single Pi extension; it is not an npm package or a separately installed extension. Normal installation uses `pi install git:github.com/antoine-bouteiller/pi-extensions`, which loads the packaged `src/index.ts` entrypoint. For maintainer-only local development, the repository's `src/` directory is instead linked to `~/.pi/agent/extensions`, so Pi loads this source tree in place with no separate install step. Dependencies for all features are managed from the repository root workspace.

## Tools

| Tool                  | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `spawn_agent`         | Spawn a fresh-context child Pi process                                 |
| `wait_agent`          | Block for one completion and return its final text                     |
| `wait_all_agents`     | Block until every selected agent finishes                              |
| `list_agents`         | List current-session agents, or explicitly include historical sessions |
| `read_agent_response` | Read an agent's latest final raw text response                         |
| `send_message`        | Steer a running agent or start another turn when settled               |
| `interrupt_agent`     | Abort the current turn while preserving its session for later messages |

Agent names are unique within their parent session. The same task name can exist safely in different Pi sessions. Read and control tools are always scoped to the current parent session; only `list_agents(include_all: true)` crosses session boundaries, and that view is read-only.

## Source-defined agent profiles

Agent profiles live only in [`profiles.ts`](./profiles.ts). `agent_type` is required. User JSON/Markdown agents, omitted generic agent types, and caller-added skills are intentionally unsupported. The built-in profiles are `scout`, `librarian`, `implementer`, and `reviewer`; adding another profile requires one registry entry using this generic contract:

```ts
type AgentConfig = {
  allowedTools: readonly string[]
  model: string | ((context: ModelSelectorContext) => string)
  prompt: string
  isReadonly: boolean
  description?: string
  thinking?: ThinkingLevel
  color?: ThemeColor
}

const example: AgentConfig = {
  allowedTools: ['read', 'webfetch', 'mcp'],
  model: ({ parentModel }) => (parentModel.provider === 'anthropic' ? 'gpt-5.6-sol' : 'claude-opus-5'),
  prompt: 'Research the assigned question and cite the evidence.',
  isReadonly: true,
  description: 'Cited research',
  thinking: 'high',
  color: 'mdLink',
}
```

The first four fields are required. `description` defaults to the registry key, `thinking` to `high`, and `color` to `accent`. Built-ins currently select only the configured OpenAI and Anthropic models.

Model selectors are exact. A bare ID such as `claude-sonnet-5` selects that exact authenticated ID, preferring its canonical `openai` or `anthropic` provider, then official OAuth/cloud variants, then other authenticated non-Google providers deterministically. A qualified selector such as `anthropic/claude-sonnet-5` requires that exact pair. Selector functions receive an immutable authenticated-model snapshot and the parent provider/model, and return one of the same exact selector strings. Spawning fails before run artifacts are created when a profile or selected model is unavailable.

Children rediscover normally configured global and project extensions on every launch and restart. Temporary extensions supplied only through a parent CLI/factory invocation are not guaranteed because Pi does not expose an exact loaded-extension list. `allowedTools` is always passed as the strict model-callable tool boundary. Names for an extension that is not installed, such as optional FFF tools, are harmless; they become usable when that extension registers them.

Skills, prompt templates, context files, `AGENTS.md`, and `CLAUDE.md` remain isolated. Children start fresh sessions with Pi's normal system prompt plus the profile prompt. Conversation and parent context are never copied. The normalized profile, provider/model, thinking level, prompt, tools, color, and read-only metadata are persisted, so a hibernated child restarts deterministically while rediscovering extensions afresh.

`isReadonly` adds generic prompt guidance and selects the MCP gateway policy; it is metadata, not a local filesystem or shell sandbox. It does not inspect `bash` commands or rewrite `allowedTools`. In read-only mode MCP permits tools annotated `readOnlyHint: true` and not destructive, plus the four unannotated DBX metadata operations `dbx_list_connections`, `dbx_list_tables`, `dbx_describe_table`, and `dbx_get_schema_context`. Other unannotated, mutating, or destructive MCP operations are hidden and denied. False mode is unrestricted; the implementer profile does not allow MCP at all.

Every child receives `PI_SUBAGENT_OWNER_TOKEN`, `PI_SUBAGENT_PROFILE`, and `PI_SUBAGENT_READONLY` (`1` or `0`). Parent session/provider/model environment variables are removed. The owner token limits the custom status panel to forwarding Azure response quota; it does not render UI, poll Claude quota, or fetch Git state in children. Profile identity uses theme-aware colors across spawn, completion, activity, browser, and peek surfaces while lifecycle status retains independent semantic colors.

## Configuration

Optional configuration lives at `~/.pi/agent/pi-codex-subagents/config.json`:

```json
{
  "storageDir": "~/.local/state/pi-codex-subagents/runs",
  "retentionDays": 7,
  "inactivityMinutes": 5
}
```

`storageDir` accepts an absolute path, `~/...`, or a path relative to the package configuration directory. By default runs are stored in `~/.pi/agent/pi-codex-subagents/runs`. `retentionDays` defaults to `7`; expired runs and oversized tool outputs are removed when the extension loads. Set it to `0` to disable automatic cleanup. `inactivityMinutes` defaults to `5`; after that long without child RPC activity, the parent orchestrator receives one warning while the agent keeps running. Set it to `0` to disable inactivity warnings. Runtime sockets remain in the operating system temporary directory and are removed when agents stop. Legacy `defaults` keys are ignored.

Configuration is read when agents spawn, while cleanup runs when the extension loads. Restart Pi after changing `storageDir`, `retentionDays`, or `inactivityMinutes`.

## Completion delivery

A child completion or failure is delivered automatically to its parent session after the child reaches final status. If the parent is active, the result joins the current run; if the parent is idle, it starts a continuation turn. Continue independent work instead of waiting. Use `wait_agent` or `wait_all_agents` only when the next action depends on those responses and no useful work remains meanwhile; an active wait receives the result directly without a duplicate automatic message.

## Delegation guidance

The extension appends a short delegation section to the parent system prompt on every `before_agent_start`. It encourages spawning subagents generously for read-heavy exploration and research, parallelizing independent questions, not blocking on waits, and writing self-contained tasks, while noting the cases that belong in the parent's own context. The block is skipped when `PI_SUBAGENT_OWNER_TOKEN` is set, so children never receive it; no profile grants `spawn_agent`, so subagents cannot spawn further agents.

## Commands and TUI

While agents are starting or running, the wide status panel shows them in its `SUBAGENTS` section. No duplicate activity widget is rendered above the editor.

`/subagents` and `/agents` browse agents in the current session. Press Tab to switch to the read-only all-sessions view. `/subagent <task-name>` opens one current-session agent directly.

The full-chat view uses the child working directory for tool rendering and synchronizes in-progress output when opened midway through a run. Use Left/Right to switch between agents in the current browser scope. Escape returns to the parent chat; press Escape again immediately to interrupt the agent you just viewed. Any other key disarms that second-Escape action.

Child RPC processes are terminated after completion, failure, or interruption so settled agents do not keep consuming memory. `send_message` starts a fresh child process with the persisted session and continues from there. On startup, the extension also reconciles and terminates validated owned children left behind by an earlier extension process.

## Output limits

Automatic completions, wait tools, and response tools follow Pi's standard 50 KB / 2,000-line output limit. Oversized output is truncated and the complete text is written beside the runtime data; the returned notice includes a path that can be read with Pi's `read` tool.

## Environment

`PI_SUBAGENT_PI_BIN` overrides the Pi executable used for child processes. Normally children use the same Pi installation as the parent.

## License

MIT
