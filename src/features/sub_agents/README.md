# pi-codex-subagents

Codex-shaped, session-scoped subagents for [Pi](https://github.com/earendil-works/pi). Spawn isolated child Pi processes, receive their final responses automatically, steer active work, and inspect sessions in a live full-chat view.

Requires Pi 0.80.4 or newer and Node.js 22.19 or newer.

## Deployment

This capability is maintained in the [`pi-extensions`](../../..) repository as one internal feature of that package's single Pi extension; it is not an npm package or a separately installed extension. Normal installation uses `pi install git:github.com/antoine-bouteiller/pi-extensions`, which loads the packaged `src/index.ts` entrypoint. For maintainer-only local development, the repository's `src/` directory is instead linked to `~/.pi/agent/extensions`, so Pi loads this source tree in place with no separate install step. Dependencies for all features are managed from the repository root workspace.

## Tools

| Tool                  | Purpose                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `spawn_agent`         | Spawn foreground by default, or accept immediately with `run_in_background: true` |
| `wait_agent`          | Synchronize one intentionally background agent and return its final text          |
| `wait_all_agents`     | Synchronize every selected background agent                                       |
| `list_agents`         | List current-session agents, or explicitly include historical sessions            |
| `read_agent_response` | Read an agent's latest final raw text response                                    |
| `send_message`        | Send the one allowed steering or continuation message to a logical agent          |
| `interrupt_agent`     | Abort the current turn while preserving its unused follow-up, when one remains    |

Agent names are unique within their parent session. The same task name can exist safely in different Pi sessions. Read and control tools are always scoped to the current parent session; only `list_agents(include_all: true)` crosses session boundaries, and that view is read-only.

## Source-defined agent profiles

Agent profiles live only in [`profiles.ts`](./profiles.ts). `agent_type` is required. User JSON/Markdown agents, omitted generic agent types, and caller-added skills are intentionally unsupported. The built-in profiles are `scout`, `librarian`, and `reviewer`; adding another profile requires one registry entry using this generic contract:

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

The first four fields are required. `description` defaults to the registry key, `thinking` to `high`, and `color` to `accent`. Built-ins currently select configured OpenAI models; any source-defined profile may select Claude.

Model selectors are exact. A bare ID such as `claude-sonnet-5` selects that exact authenticated ID, preferring its canonical `openai` or `anthropic` provider, then official OAuth/cloud variants, then other authenticated non-Google providers deterministically. A qualified selector such as `anthropic/claude-sonnet-5` requires that exact pair. Selector functions receive an immutable authenticated-model snapshot and the parent provider/model, and return one of the same exact selector strings. Spawning fails before run artifacts are created when a profile or selected model is unavailable. Claude is recommended primarily for short research and review tasks, but it is not restricted by `isReadonly`.

Children rediscover normally configured global and project extensions on every launch and restart. Temporary extensions supplied only through a parent CLI/factory invocation are not guaranteed because Pi does not expose an exact loaded-extension list. `allowedTools` is always passed as the strict model-callable tool boundary. Names for an extension that is not installed, such as optional FFF tools, are harmless; they become usable when that extension registers them.

Skills, prompt templates, context files, `AGENTS.md`, and `CLAUDE.md` remain isolated. Children start fresh sessions with Pi's normal system prompt plus the profile prompt. Conversation and parent context are never copied. The normalized profile, provider/model, thinking level, prompt, tools, color, and read-only metadata are persisted, so a hibernated child restarts deterministically while rediscovering extensions afresh.

`isReadonly` adds generic prompt guidance and selects the MCP gateway policy; it is metadata, not a local filesystem or shell sandbox. It does not inspect `bash` commands or rewrite `allowedTools`. In read-only mode MCP permits tools annotated `readOnlyHint: true` and not destructive, plus the four unannotated DBX metadata operations `dbx_list_connections`, `dbx_list_tables`, `dbx_describe_table`, and `dbx_get_schema_context`. Other unannotated, mutating, or destructive MCP operations are hidden and denied. All built-in profiles are read-only.

Every child receives `PI_SUBAGENT_OWNER_TOKEN`, `PI_SUBAGENT_PROFILE`, and `PI_SUBAGENT_READONLY` (`1` or `0`). Parent session/provider/model environment variables are removed. The owner token limits the custom status panel to forwarding Azure response quota; it does not render UI, poll Claude quota, or fetch Git state in children. Profile identity uses theme-aware colors across spawn, completion, activity, browser, and peek surfaces while lifecycle status retains independent semantic colors.

## Cache-aware lifecycle limits

Each logical agent should receive one narrow, self-contained initial task. It accepts at most one successful `send_message` follow-up across active steering and hibernated-session continuation; rejected delivery attempts do not consume that allowance. Start a fresh agent for a distinct task instead of repeatedly steering an old context.

One manager runs at most three Claude-backed child processes concurrently, regardless of profile capabilities. Claude continuation is refused once the latest active-branch assistant usage reaches 112,000 context input tokens (`input + cacheRead + cacheWrite`), leaving headroom before 128k. If a settled Claude session has no trustworthy usage record, continuation fails closed and requests a fresh agent.

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

`spawn_agent` runs in the foreground when `run_in_background` is omitted or `false`: the tool waits for final status and returns the completion, failure, or interruption directly. That event is claimed before launch and is not also injected as an automatic completion notification.

With `run_in_background: true`, the tool returns after startup acceptance. The final event is later injected into the parent session exactly once; if the parent is active it joins the current run, and if the parent is idle it starts a continuation turn. `wait_agent` and `wait_all_agents` remain available to synchronize work that was intentionally started in the background, and an active wait receives the result without a duplicate automatic message.

Aborting a foreground tool wait releases its completion claim but does not interrupt the child. If a child was created, it continues and its final event returns to automatic background delivery. Use `interrupt_agent` when the child itself must stop.

Execution mode is an invocation-time delivery policy and is not persisted. It does not change profile restrictions, process ownership, the one-follow-up limit, or Claude concurrency and continuation limits.

## Delegation guidance

The extension appends a short delegation section to the parent system prompt on every `before_agent_start`. Foreground is recommended whenever the answer is needed for the next decision or the parent would otherwise inspect the same scope. Background execution is reserved for clearly non-overlapping work; the parent must not repeat a pending child's files, symbols, or question and should wait if its next action would overlap. The guidance also asks for narrow self-contained tasks, caps parallel Claude work at three children, prefers fresh agents to repeated steering, and recommends Claude primarily for short research and review.

The block is skipped when `PI_SUBAGENT_OWNER_TOKEN` is set, so children never receive it; no profile grants `spawn_agent`, so subagents cannot spawn further agents.

## Commands and TUI

While agents are starting or running, the wide status panel shows them in its `SUBAGENTS` section. No duplicate activity widget is rendered above the editor.

`/subagents` and `/agents` browse agents in the current session. Press Tab to switch to the read-only all-sessions view. `/subagent <task-name>` opens one current-session agent directly.

The full-chat view uses the child working directory for tool rendering and synchronizes in-progress output when opened midway through a run. Use Left/Right to switch between agents in the current browser scope. Escape returns to the parent chat; press Escape again immediately to interrupt the agent you just viewed. Any other key disarms that second-Escape action.

Child RPC processes are terminated after completion, failure, or interruption so settled agents do not keep consuming memory. When its single follow-up is still available, `send_message` can start a fresh child process with the persisted session and continue from there; Claude sessions at or above the context threshold must be replaced instead. On startup, the extension also reconciles and terminates validated owned children left behind by an earlier extension process.

## Output limits

Foreground spawn results, automatic background completions, wait tools, and response tools follow Pi's standard 50 KB / 2,000-line output limit. Oversized output is truncated and the complete text is written beside the runtime data; the returned notice includes a path that can be read with Pi's `read` tool.

## Environment

`PI_SUBAGENT_PI_BIN` overrides the Pi executable used for child processes. Normally children use the same Pi installation as the parent.

## License

MIT
