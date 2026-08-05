import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

import { asResult } from '@tests/utils/casts.js'

const FEATURE_MODULES = [
  'ask_user',
  'auto_compact',
  'background_poll',
  'caffeinate',
  'claude_code',
  'comment_checker',
  'hashline',
  'mcp',
  'meridian_session_affinity',
  'prompt_rewind',
  'rules',
  'safe_rm',
  'safety_guard',
  'status_panel',
  'sub_agents',
  'webfetch',
] as const

const EXPECTED_FEATURE_NAMES = [
  'ask-user',
  'auto-compact',
  'background-poll',
  'caffeinate',
  'claude-code',
  'comment-checker',
  'hashline',
  'mcp',
  'meridian-session-affinity',
  'prompt-rewind',
  'rules',
  'safe-rm',
  'safety-guard',
  'status-panel',
  'sub-agents',
  'webfetch',
]

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

const EXPECTED_COMMANDS = ['agents', 'mcp-auth', 'prompt-rewind-cancel', 'subagent', 'subagents'].toSorted()
const EXPECTED_MESSAGE_RENDERERS = ['pi-codex-subagent-completion'].toSorted()

const EXPECTED_HANDLER_COUNTS: Record<string, number> = {
  after_provider_response: 1,
  agent_end: 1,
  agent_settled: 2,
  agent_start: 2,
  before_agent_start: 3,
  before_provider_headers: 1,
  context: 1,
  input: 1,
  message_update: 1,
  model_select: 1,
  resources_discover: 1,
  session_compact: 1,
  session_shutdown: 7,
  session_start: 9,
  session_tree: 1,
  thinking_level_select: 1,
  tool_call: 2,
  tool_execution_end: 1,
  tool_execution_start: 1,
  tool_result: 3,
  turn_end: 1,
}

interface Manifest {
  tools: string[]
  commands: string[]
  messageRenderers: string[]
  handlerCounts: Record<string, number>
}

interface ManifestResults {
  aggregate: Manifest
  direct: Manifest
  featureNames: string[]
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
      on(name) { manifest.handlerCounts[name] = (manifest.handlerCounts[name] || 0) + 1; },
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

const manifestScript = (paths: { extensionPath: string; featureRegistryPath: string; moduleDir: string; runtimePath: string }): string => `
  ${FAKE_PI_FACTORY}
  const results = {};

  {
    const { default: piExtensions } = await import(${JSON.stringify(paths.extensionPath)});
    const { manifest, pi } = createManifestPi();
    piExtensions(pi);
    results.aggregate = manifest;
  }

  {
    const { getOrCreateProcessRuntime } = await import(${JSON.stringify(paths.runtimePath)});
    const runtime = getOrCreateProcessRuntime();
    const { pi, manifest } = createManifestPi();
    const modules = ${JSON.stringify(FEATURE_MODULES)};
    for (const name of modules) {
      const { register } = await import(${JSON.stringify(paths.moduleDir)} + '/' + name + '/feature.js');
      register(pi, runtime);
    }
    results.direct = manifest;
  }

  const { features } = await import(${JSON.stringify(paths.featureRegistryPath)});
  results.featureNames = features.map(feature => feature.name);
  console.log(JSON.stringify(results));
`

// Registering sub_agents touches the real agent directory, so the manifest must remain child-isolated.
const runManifestScript = async (): Promise<ManifestResults> => {
  const paths = {
    extensionPath: fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    featureRegistryPath: fileURLToPath(new URL('../src/config/features.ts', import.meta.url)),
    moduleDir: fileURLToPath(new URL('../src/features', import.meta.url)).replace(/\/$/, ''),
    runtimePath: fileURLToPath(new URL('../src/config/runtime.ts', import.meta.url)),
  }
  const { PI_SUBAGENT_OWNER_TOKEN: _ownerToken, ...env } = process.env
  const child = Bun.spawn([process.execPath, '--eval', manifestScript(paths)], { env, stderr: 'pipe', stdout: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(exitCode, stderr).toBe(0)
  return asResult<ManifestResults>(JSON.parse(stdout.trim()))
}

describe('registration manifest', () => {
  test('every registered tool, command, hook, and message renderer matches on both registration paths', async () => {
    const { aggregate, direct, featureNames } = await runManifestScript()

    expect(featureNames).toEqual(EXPECTED_FEATURE_NAMES)
    for (const [label, manifest] of [
      ['packaged aggregate (src/index.ts)', aggregate],
      ['explicit internal feature registration', direct],
    ] as const) {
      expect(manifest.tools.toSorted(), label).toEqual(EXPECTED_TOOLS)
      expect(manifest.commands.toSorted(), label).toEqual(EXPECTED_COMMANDS)
      expect(manifest.messageRenderers.toSorted(), label).toEqual(EXPECTED_MESSAGE_RENDERERS)
      expect(manifest.handlerCounts, label).toEqual(EXPECTED_HANDLER_COUNTS)
    }
  })
})
