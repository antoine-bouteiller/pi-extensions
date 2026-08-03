import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

import { asResult } from '#test-utils/casts'

/*
 * One authoritative registration manifest, run against both loading paths Pi actually uses:
 * `extension.ts`'s packaged aggregate (one injected runtime) and each `src/*\/index.ts` module's
 * standalone default export (Pi's direct dev-mode auto-load, each falling back to the same
 * process-wide runtime). Runs in a child process because registering `sub-agents` for real
 * constructs a live `AgentManager`, which touches the real agent directory.
 */

const EXTENSION_MODULES = [
  'ask-user',
  'background-poll',
  'claude-code',
  'comment-checker',
  'hashline',
  'mcp',
  'meridian-session-affinity',
  'rules',
  'safe-rm',
  'safety-guard',
  'status-panel',
  'sub-agents',
  'webfetch',
] as const

const EXPECTED_TOOLS = [
  'ask_user',
  'background_poll',
  'hashline_read',
  'hashline_write',
  'interrupt_agent',
  'list_agents',
  'mcp',
  'read_agent_response',
  'safe_rm',
  'send_message',
  'spawn_agent',
  'wait_agent',
  'wait_all_agents',
  'webfetch',
].toSorted()

const EXPECTED_COMMANDS = ['agents', 'mcp-auth', 'subagent', 'subagents'].toSorted()

const EXPECTED_MESSAGE_RENDERERS = ['pi-codex-subagent-completion'].toSorted()

/** Handler counts, not just event names: two extensions sharing an event name must both be present. */
const EXPECTED_HANDLER_COUNTS: Record<string, number> = {
  after_provider_response: 1,
  agent_settled: 1,
  agent_start: 1,
  before_agent_start: 2,
  before_provider_headers: 1,
  model_select: 1,
  resources_discover: 1,
  session_compact: 1,
  session_shutdown: 5,
  session_start: 6,
  session_tree: 1,
  thinking_level_select: 1,
  tool_call: 1,
  tool_result: 2,
  turn_end: 1,
}

interface Manifest {
  tools: string[]
  commands: string[]
  messageRenderers: string[]
  handlerCounts: Record<string, number>
}

const FAKE_PI_FACTORY = `
  const createManifestPi = () => {
    const manifest = { commands: [], handlerCounts: {}, messageRenderers: [], tools: [] };
    const pi = {
      events: { emit() {}, on() {} },
      async exec() { return { code: 0, killed: false, stderr: '', stdout: '' }; },
      getActiveTools: () => [],
      getAllTools: () => [],
      getThinkingLevel: () => 'off',
      on(name, handler) {
        manifest.handlerCounts[name] = (manifest.handlerCounts[name] || 0) + 1;
      },
      registerCommand(name) { manifest.commands.push(name); },
      registerEntryRenderer() {},
      registerFlag() {},
      registerMessageRenderer(type) { manifest.messageRenderers.push(type); },
      registerProvider() {},
      registerShortcut() {},
      registerTool(tool) { manifest.tools.push(tool.name); },
      sendMessage() {},
      setActiveTools() {},
    };
    return { manifest, pi };
  };
`

const manifestScript = (modulePaths: { extensionPath: string; moduleDir: string }): string => `
  ${FAKE_PI_FACTORY}
  const results = {};

  {
    const { default: piExtensions } = await import(${JSON.stringify(modulePaths.extensionPath)});
    const { manifest, pi } = createManifestPi();
    await piExtensions(pi);
    results.aggregate = manifest;
  }

  {
    const { pi, manifest } = createManifestPi();
    const modules = ${JSON.stringify(EXTENSION_MODULES)};
    for (const name of modules) {
      const { default: register } = await import(${JSON.stringify(modulePaths.moduleDir)} + '/' + name + '/index.js');
      await register(pi);
    }
    results.direct = manifest;
  }

  console.log(JSON.stringify(results));
`

const runManifestScript = async (): Promise<{ aggregate: Manifest; direct: Manifest }> => {
  const extensionPath = fileURLToPath(new URL('../extension.ts', import.meta.url))
  const moduleDir = fileURLToPath(new URL('../src', import.meta.url)).replace(/\/$/, '')
  const script = manifestScript({ extensionPath, moduleDir })
  const { PI_SUBAGENT_OWNER_TOKEN: _ownerToken, ...env } = process.env
  const child = Bun.spawn([process.execPath, '--eval', script], { env, stderr: 'pipe', stdout: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(exitCode, stderr).toBe(0)
  return asResult<{ aggregate: Manifest; direct: Manifest }>(JSON.parse(stdout.trim()))
}

describe('registration manifest', () => {
  test('every registered tool, command, hook, and message renderer matches on both loading paths', async () => {
    const { aggregate, direct } = await runManifestScript()

    for (const [label, manifest] of [
      ['packaged aggregate (extension.ts)', aggregate],
      ['standalone direct-load (src/*/index.ts)', direct],
    ] as const) {
      expect(manifest.tools.toSorted(), label).toEqual(EXPECTED_TOOLS)
      expect(manifest.commands.toSorted(), label).toEqual(EXPECTED_COMMANDS)
      expect(manifest.messageRenderers.toSorted(), label).toEqual(EXPECTED_MESSAGE_RENDERERS)
      expect(manifest.handlerCounts, label).toEqual(EXPECTED_HANDLER_COUNTS)
    }
  })
})
