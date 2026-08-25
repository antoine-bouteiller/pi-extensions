import { fileURLToPath } from 'node:url'

import { BunFileSystem, BunPath } from '@effect/platform-bun'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asResult } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { withProcessEnv } from '@tests/utils/process_env.js'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import { getOrCreateProcessRuntime } from '@/config/runtime.js'
import { feature as statusPanel } from '@/features/status_panel/index.js'
import { AgentActivity, type AgentActivityApi, type AppRuntime, StatusBarLive } from '@/shared/effect/app_services.js'
import { parseJsonText } from '@/shared/utils/json.js'

const sharedActivityScript = (paths: { aggregate: string; activity: string; runtime: string; statusPanel: string }): string => `
  const { Effect } = await import('effect');
  const { feature: statusPanel } = await import(${JSON.stringify(paths.statusPanel)});
  const { AgentActivity } = await import(${JSON.stringify(paths.activity)});
  const { getOrCreateProcessRuntime } = await import(${JSON.stringify(paths.runtime)});

  const createPi = () => {
    const handlers = new Map();
    const pi = {
      events: { emit() {}, on() {} },
      exec() { return Effect.runPromise(Effect.succeed({ code: 0, killed: false, stderr: '', stdout: '' })); },
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

  const explicit = createPi();
  statusPanel.implementation.register(explicit.pi, getOrCreateProcessRuntime());
  const explicitPanel = panelContext();
  await getOrCreateProcessRuntime().runPromise(statusPanel.implementation.activate({ reason: 'startup', type: 'session_start' }, explicitPanel.ctx));

  const runtime = getOrCreateProcessRuntime();
  await runtime.runPromise(AgentActivity.pipe(Effect.flatMap(activity => activity.publish([{ color: 'accent', name: 'shared-agent', profile: 'scout' }]))));
  console.log(JSON.stringify({ explicit: explicitPanel.render() }));
`

describe('process-wide runtime', () => {
  it.effect('does not include MCP when an isolated child builds without the MCP entrypoint', () =>
    Effect.gen(function* () {
      const entrypoint = fileURLToPath(new URL('fixtures/without_mcp_entry.ts', import.meta.url))
      const script = `
        const result = await Bun.build({ entrypoints: ['${entrypoint}'], metafile: true, target: 'bun' });
        if (!result.success) process.exit(1);
        console.log(JSON.stringify(Object.keys(result.metafile.inputs)));
      `
      const child = Bun.spawn([process.execPath, '--eval', script], { stderr: 'pipe', stdout: 'pipe' })
      const [stdout, stderr, exitCode] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      )

      expect(exitCode, stderr).toBe(0)
      const inputs = asResult<readonly string[]>(parseJsonText(stdout.trim()))
      const normalizedInputs = inputs.map((input) => input.replaceAll('\\', '/'))
      expect(normalizedInputs).toEqual(
        expect.arrayContaining([
          expect.stringContaining('src/config/runtime.ts'),
          expect.stringContaining('src/features/ask_user/index.ts'),
          expect.stringContaining('src/features/status_panel/index.ts'),
        ])
      )
      expect(normalizedInputs.some((input) => input.includes('src/features/mcp/'))).toBeFalse()
    })
  )

  it.effect('memoises to one instance across repeated lookups', () =>
    Effect.sync(() => {
      expect(getOrCreateProcessRuntime()).toBe(getOrCreateProcessRuntime())
    })
  )

  it.effect('uses the runtime supplied to a feature register function', () =>
    Effect.gen(function* () {
      let subscriptions = 0
      const sentinelActivity: AgentActivityApi = {
        list: () => [],
        publish: () => Effect.void,
        subscribe: () => {
          subscriptions += 1
          return () => undefined
        },
      }
      const runtime: AppRuntime = ManagedRuntime.make(
        Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer, StatusBarLive, Layer.succeed(AgentActivity)(sentinelActivity))
      )
      yield* withProcessEnv('PI_SUBAGENT_OWNER_TOKEN', undefined, () =>
        Effect.sync(() => {
          statusPanel.implementation.register(createFakePi().pi, runtime)
          expect(subscriptions).toBe(1)
        })
      ).pipe(Effect.ensuring(Effect.promise(() => runtime.dispose())))
    })
  )

  it.effect('makes AgentActivity observable through aggregate and explicit feature registration', () =>
    Effect.gen(function* () {
      const script = sharedActivityScript({
        activity: fileURLToPath(new URL('../../src/shared/effect/app_services.ts', import.meta.url)),
        aggregate: fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
        runtime: fileURLToPath(new URL('../../src/config/runtime.ts', import.meta.url)),
        statusPanel: fileURLToPath(new URL('../../src/features/status_panel/index.ts', import.meta.url)),
      })
      const { PI_SUBAGENT_OWNER_TOKEN: _ownerToken, ...env } = process.env
      const child = Bun.spawn([process.execPath, '--eval', script], { env, stderr: 'pipe', stdout: 'pipe' })
      const [stdout, stderr, exitCode] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      )

      expect(exitCode, stderr).toBe(0)
      const result = parseJsonText(stdout.trim())
      expect(result).toEqual({
        explicit: expect.stringContaining('shared-agent'),
      })
    })
  )
})
