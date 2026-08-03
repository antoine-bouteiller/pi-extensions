import { describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'

import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import { createFakePi } from '#test-utils/fake_pi'

import { AgentActivity, type AgentActivityShape, StatusBarLive } from '../../shared/services.js'
import { register as registerStatusPanel } from '../../status-panel/index.js'
import { type AppRuntime, getOrCreateProcessRuntime } from '../app_runtime.js'

const sharedActivityScript = (paths: { aggregate: string; activity: string; runtime: string; statusPanel: string }): string => `
  const { Effect } = await import('effect');
  const { default: piExtensions } = await import(${JSON.stringify(paths.aggregate)});
  const { default: statusPanel } = await import(${JSON.stringify(paths.statusPanel)});
  const { AgentActivity } = await import(${JSON.stringify(paths.activity)});
  const { getOrCreateProcessRuntime } = await import(${JSON.stringify(paths.runtime)});

  const createPi = () => {
    const handlers = new Map();
    const pi = {
      events: { emit() {}, on() {} },
      async exec() { return { code: 0, killed: false, stderr: '', stdout: '' }; },
      getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => 'off',
      on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
      registerCommand() {}, registerEntryRenderer() {}, registerFlag() {}, registerMessageRenderer() {},
      registerProvider() {}, registerShortcut() {}, registerTool() {}, sendMessage() {}, setActiveTools() {},
    };
    return { handlers, pi };
  };

  const panelContext = () => {
    let renderSidebar;
    const tui = { render: () => [], requestRender() {}, terminal: { columns: 120, rows: 30 } };
    const theme = { bold: value => value, fg: (_color, value) => value };
    const ctx = {
      cwd: '/project', getContextUsage: () => undefined, mode: 'tui',
      model: { contextWindow: 100000, id: 'model', provider: 'openai' },
      ui: {
        custom(factory, options) { return new Promise(resolve => { const component = factory(tui, theme, {}, resolve); renderSidebar = width => component.render(width); options.onHandle?.({ hide() {} }); }); },
        setFooter() {}, setTitle() {},
      },
    };
    return { ctx, render: () => renderSidebar(44).join('\\n') };
  };

  const aggregate = createPi();
  piExtensions(aggregate.pi);
  const aggregateStarts = aggregate.handlers.get('session_start') || [];
  if (aggregateStarts.length !== 6 || !aggregateStarts[4]) throw new Error('aggregate status-panel handler missing');
  const aggregatePanel = panelContext();
  await aggregateStarts[4]({}, aggregatePanel.ctx);

  const standalone = createPi();
  statusPanel(standalone.pi);
  const standaloneStart = standalone.handlers.get('session_start')?.[0];
  if (!standaloneStart) throw new Error('standalone status-panel handler missing');
  const standalonePanel = panelContext();
  await standaloneStart({}, standalonePanel.ctx);

  const runtime = getOrCreateProcessRuntime();
  await runtime.runPromise(AgentActivity.pipe(Effect.flatMap(activity => activity.publish([{ color: 'accent', name: 'shared-agent', profile: 'scout' }]))));
  console.log(JSON.stringify({ aggregate: aggregatePanel.render(), standalone: standalonePanel.render() }));
`

describe('process-wide runtime', () => {
  it('memoises to one instance across repeated lookups', () => {
    expect(getOrCreateProcessRuntime()).toBe(getOrCreateProcessRuntime())
  })

  it('uses the runtime supplied to an extension register function', async () => {
    let subscriptions = 0
    const sentinelActivity: AgentActivityShape = {
      list: () => [],
      publish: () => Effect.void,
      subscribe: () => {
        subscriptions += 1
        return () => undefined
      },
    }
    const runtime: AppRuntime = ManagedRuntime.make(
      Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, FetchHttpClient.layer, StatusBarLive, Layer.succeed(AgentActivity)(sentinelActivity))
    )
    const originalOwnerToken = process.env.PI_SUBAGENT_OWNER_TOKEN
    delete process.env.PI_SUBAGENT_OWNER_TOKEN
    try {
      registerStatusPanel(createFakePi().pi, runtime)
      expect(subscriptions).toBe(1)
    } finally {
      if (originalOwnerToken === undefined) {
        delete process.env.PI_SUBAGENT_OWNER_TOKEN
      } else {
        process.env.PI_SUBAGENT_OWNER_TOKEN = originalOwnerToken
      }
      await runtime.dispose()
    }
  })

  it('makes AgentActivity observable through both packaged and standalone loading paths', async () => {
    const script = sharedActivityScript({
      activity: fileURLToPath(new URL('../../shared/services.ts', import.meta.url)),
      aggregate: fileURLToPath(new URL('../../../extension.ts', import.meta.url)),
      runtime: fileURLToPath(new URL('../app_runtime.ts', import.meta.url)),
      statusPanel: fileURLToPath(new URL('../../status-panel/index.ts', import.meta.url)),
    })
    const { PI_SUBAGENT_OWNER_TOKEN: _ownerToken, ...env } = process.env
    const child = Bun.spawn([process.execPath, '--eval', script], { env, stderr: 'pipe', stdout: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    expect(exitCode, stderr).toBe(0)
    const result: unknown = JSON.parse(stdout.trim())
    expect(result).toEqual({
      aggregate: expect.stringContaining('shared-agent'),
      standalone: expect.stringContaining('shared-agent'),
    })
  })
})
