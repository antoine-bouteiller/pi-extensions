import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Value } from 'typebox/value'

import {
  AgentListEntrySchema,
  AgentRecordViewSchema,
  AgentResultSchema,
  ChildCommandErrorFrameSchema,
  ChildProgressFrameSchema,
  ChildReadyFrameSchema,
  ChildResultFrameSchema,
  ChildSteerAckFrameSchema,
  deriveChildEnvironment,
  deriveWorkerConfig,
  InterruptAgentInputSchema,
  ListAgentsInputSchema,
  ParentConfigFrameSchema,
  ParentInterruptFrameSchema,
  ParentSteerFrameSchema,
  ParentTaskFrameSchema,
  PROFILE_REGISTRY,
  ReadAgentResponseInputSchema,
  resolveProfile,
  resolveProfileWithRegistry,
  SendMessageInputSchema,
  SpawnAgentInputSchema,
  TaskNameSchema,
  toChildModel,
  WaitAgentInputSchema,
  WaitAllInputSchema,
  WorkerConfigSchema,
} from '../../../src/features/sub_agents/model.js'

const tools = ['read', 'ffgrep', 'fffind', 'bash', 'edit', 'write', 'hashline_read', 'hashline_write', 'safe_rm', 'webfetch', 'mcp']
const snapshot = (registeredTools = tools) => ({
  agent_dir: '/agent',
  child_model_view: {
    authenticated_providers: ['anthropic', 'azure-openai'],
    models: [
      { contextWindow: 300_000, model: 'gpt-5.6-luna', provider: 'azure-openai' },
      { contextWindow: 250_000, model: 'gpt-5.6-terra', provider: 'azure-openai' },
      { contextWindow: 150_000, model: 'gpt-5.6-sol', provider: 'azure-openai' },
      { contextWindow: 220_000, model: 'claude-opus-5', provider: 'anthropic' },
    ],
  },
  cwd: '/work',
  environment: {
    API_KEY: 'parent-memory-must-not-leak',
    KEEP: 'yes',
    PI_SUBAGENT: 'old',
    PI_SUBAGENT_ID: 'old',
    PI_SUBAGENT_READONLY: 'old',
    PI_SUBAGENT_STALE: 'x',
  },
  parent_model: { model: 'parent', provider: 'openai' },
  project_trusted: true,
  registered_tools: registeredTools,
})

const prompts = {
  implementer: `You are a scoped implementation agent. Complete only the delegated task. Inspect
the relevant code, make the smallest correct change, and preserve validation,
security, data-loss prevention, and accessibility boundaries. Do not broaden the
task or refactor unrelated code. Run focused existing checks and return the
changed paths, verification results, and any blocker requiring a parent decision.\n`,
  librarian: `You are a cited research agent. Investigate only the delegated question using
local, web, and configured remote sources. Do not modify local or remote state.
Cite the source for each material claim, distinguish documented fact from
inference, and return a concise synthesis. If a source or operation is unavailable,
state the limitation rather than guessing.\n`,
  reviewer: `You are a read-only code reviewer. Inspect the requested change and only the
context needed to assess it. Prioritize correctness, security, data loss, and
behavioral regressions. Report actionable findings in severity order with file
and line references and reasoning. Do not modify files, report unrelated
pre-existing issues, or raise style-only comments unless asked. If there are no
findings, say so explicitly.\n`,
  scout: `You are a fast codebase exploration agent. Investigate only the delegated task.
Use local read, search, and shell tools to inspect; do not modify files or external
systems. Return a concise conclusion with relevant paths, symbols, and evidence.
If the task requires a product decision or mutation, explain the blocker instead.\n`,
} as const
const descriptions = {
  implementer: 'Scoped code implementation and verification — write-capable',
  librarian: 'Cited web and remote-system research — read-only by policy',
  reviewer: 'Read-only plan and implementation review',
  scout: 'Quick codebase exploration and focused implementation reconnaissance — read-only by policy',
} as const

const resolvedProfile = (key: keyof typeof prompts) => {
  const result = resolveProfile(key, snapshot())
  if (!result.ok) {
    throw new Error(`expected ${key} resolution`)
  }
  return result.profile
}

describe('sub-agent model', () => {
  it('routes profiles and keeps prompts and descriptions bound to the specification literals', () => {
    const cases = [
      ['scout', 'azure-openai', 'gpt-5.6-luna'],
      ['librarian', 'azure-openai', 'gpt-5.6-luna'],
      ['implementer', 'azure-openai', 'gpt-5.6-terra'],
      ['reviewer', 'anthropic', 'claude-opus-5'],
    ] as const
    for (const [key, provider, model] of cases) {
      const profile = resolvedProfile(key)
      expect(profile.contextCeiling).toBe(200_000)
      expect(profile.model).toBe(model)
      expect(profile.prompt).toBe(prompts[key])
      expect(profile.provider).toBe(provider)
      expect(PROFILE_REGISTRY[key].description).toBe(descriptions[key])
    }
  })

  it('routes reviewer to Azure for non-OpenAI and absent parent models', () => {
    for (const parent_model of [undefined, { model: 'parent', provider: 'anthropic' }]) {
      const result = resolveProfile('reviewer', { ...snapshot(), parent_model })
      expect(result.ok && result.profile).toMatchObject({ model: 'gpt-5.6-sol', provider: 'azure-openai' })
    }
  })

  it('refuses unknown, unavailable-provider, and unavailable-model selections without fallback', () => {
    expect(resolveProfile('unknown', snapshot())).toEqual({ error: { code: 'unknown_profile', message: 'Unknown profile "unknown".' }, ok: false })
    expect(resolveProfile('Scout', snapshot())).toEqual({ error: { code: 'unknown_profile', message: 'Unknown profile "Scout".' }, ok: false })
    expect(
      resolveProfile('scout', { ...snapshot(), child_model_view: { ...snapshot().child_model_view, authenticated_providers: ['anthropic'] } })
    ).toEqual({
      error: { code: 'missing_provider', message: 'Selected provider "azure-openai" is unavailable to the child.' },
      ok: false,
    })
    expect(
      resolveProfile('scout', {
        ...snapshot(),
        child_model_view: {
          ...snapshot().child_model_view,
          models: snapshot().child_model_view.models.filter(({ model }) => model !== 'gpt-5.6-luna'),
        },
      })
    ).toEqual({
      error: { code: 'missing_model', message: 'Selected model "azure-openai/gpt-5.6-luna" is unavailable to the child.' },
      ok: false,
    })
  })

  it('narrows model context windows and lets an explicit profile ceiling win', () => {
    const narrow = snapshot()
    narrow.child_model_view.models[0] = { contextWindow: 128_000, model: 'gpt-5.6-luna', provider: 'azure-openai' }
    const narrowResult = resolveProfile('scout', narrow)
    expect(narrowResult.ok && narrowResult.profile.contextCeiling).toBe(128_000)
    expect(resolvedProfile('scout').contextCeiling).toBe(200_000)
    const registry = { ...PROFILE_REGISTRY, scout: { ...PROFILE_REGISTRY.scout, contextCeiling: 100_000 } }
    const result = resolveProfileWithRegistry('scout', snapshot(), registry)
    expect(result.ok && result.profile.contextCeiling).toBe(100_000)
  })

  it('projects runtime model output limits through the child view and profile resolution', () => {
    expect(toChildModel({ contextWindow: 300_000, id: 'gpt-5.6-luna', maxTokens: 16_384, provider: 'azure-openai' })).toEqual({
      contextWindow: 300_000,
      maxTokens: 16_384,
      model: 'gpt-5.6-luna',
      provider: 'azure-openai',
    })
    expect(toChildModel({ contextWindow: 300_000, id: 'gpt-5.6-luna', provider: 'azure-openai' })).toEqual({
      contextWindow: 300_000,
      model: 'gpt-5.6-luna',
      provider: 'azure-openai',
    })
    const base = snapshot()
    const resolved = resolveProfile('scout', {
      ...base,
      child_model_view: {
        authenticated_providers: base.child_model_view.authenticated_providers,
        models: [{ contextWindow: 300_000, maxTokens: 16_384, model: 'gpt-5.6-luna', provider: 'azure-openai' }],
      },
    })
    expect(resolved.ok && resolved.maxOutputTokens).toBe(16_384)
    const fallback = resolveProfile('scout', snapshot())
    expect(fallback.ok && fallback.maxOutputTokens).toBeUndefined()
  })

  it('refuses unsafe configuration before missing tools and derives implementer tools from safe classifications', () => {
    const malformed = { ...PROFILE_REGISTRY, scout: { ...PROFILE_REGISTRY.scout, requiredTools: ['ask_user'] } }
    expect(resolveProfileWithRegistry('scout', snapshot(), malformed)).toEqual({
      error: { code: 'unsafe_tool', message: 'Configured tool "ask_user" is unsafe.' },
      ok: false,
    })
    expect(resolveProfile('scout', snapshot(tools.filter((tool) => tool !== 'read')))).toEqual({
      error: { code: 'unavailable_tool', message: 'Required tool "read" is unavailable.' },
      ok: false,
    })
    expect(resolvedProfile('scout').tools).toEqual(['read', 'ffgrep', 'fffind', 'bash'])
    expect(resolvedProfile('librarian').tools).toEqual(['read', 'ffgrep', 'fffind', 'webfetch', 'mcp'])
    expect(resolvedProfile('reviewer').tools).toEqual(['read', 'ffgrep', 'fffind', 'bash'])
    const registered = [...tools, 'background_poll', 'ask_user', 'spawn_agent', 'unknown_tool']
    const result = resolveProfile('implementer', snapshot(registered))
    expect(result.ok ? result.profile.tools : []).toEqual(tools)
    const requiredOnly = resolveProfile('implementer', snapshot(['read', 'ffgrep', 'fffind', 'bash', 'edit', 'write']))
    expect(requiredOnly.ok ? requiredOnly.profile.tools : []).toEqual(['read', 'ffgrep', 'fffind', 'bash', 'edit', 'write'])
  })

  it('constructs a child environment with fresh reserved values and read-only policy', () => {
    const parent = { ...snapshot(), environment: { ...snapshot().environment, PI_SUBAGENT_CUSTOM: 'stale' } }
    for (const key of ['implementer', 'scout', 'librarian', 'reviewer'] as const) {
      const environment = deriveChildEnvironment(resolvedProfile(key), parent, 'agent')
      expect(environment.API_KEY).toBe('parent-memory-must-not-leak')
      expect(environment.KEEP).toBe('yes')
      expect(environment.PI_SUBAGENT).toBe('1')
      expect(environment.PI_SUBAGENT_ID).toBe('agent')
      expect(environment.PI_SUBAGENT_OWNER_TOKEN).toBeString()
      expect(environment.PI_SUBAGENT_STALE).toBeUndefined()
      expect(environment.PI_SUBAGENT_CUSTOM).toBeUndefined()
      if (key === 'implementer') {
        expect(environment.PI_SUBAGENT_READONLY).toBeUndefined()
        expect(
          Object.keys(environment)
            .filter((name) => name.startsWith('PI_SUBAGENT'))
            .toSorted()
        ).toEqual(['PI_SUBAGENT', 'PI_SUBAGENT_ID', 'PI_SUBAGENT_OWNER_TOKEN'])
      } else {
        expect(environment.PI_SUBAGENT_READONLY).toBe('1')
        expect(
          Object.keys(environment)
            .filter((name) => name.startsWith('PI_SUBAGENT'))
            .toSorted()
        ).toEqual(['PI_SUBAGENT', 'PI_SUBAGENT_ID', 'PI_SUBAGENT_OWNER_TOKEN', 'PI_SUBAGENT_READONLY'])
      }
    }
  })

  it('uses closed schemas, complete input coverage, and redacted persisted worker configuration', () => {
    expect(Value.Check(TaskNameSchema, 'a'.repeat(64))).toBe(true)
    expect(Value.Check(TaskNameSchema, 'bad/name')).toBe(false)
    const inputs = [
      [InterruptAgentInputSchema, { target: 'task' }],
      [ListAgentsInputSchema, {}],
      [ReadAgentResponseInputSchema, { target: 'task' }],
      [SendMessageInputSchema, { message: 'm', target: 'task' }],
      [SpawnAgentInputSchema, { agent_type: 'scout', message: 'm', task_name: 'task' }],
      [WaitAgentInputSchema, { targets: ['task'] }],
      [WaitAllInputSchema, { targets: ['task'] }],
    ] as const
    for (const [schema, input] of inputs) {
      expect(Value.Check(schema, input)).toBe(true)
      expect(Value.Check(schema, { ...input, unexpected: true })).toBe(false)
    }
    const profile = resolvedProfile('scout')
    const config = deriveWorkerConfig(profile, snapshot())
    expect(Object.keys(profile).toSorted()).toEqual(['contextCeiling', 'key', 'model', 'prompt', 'provider', 'thinkingLevel', 'tools'])
    expect(Object.keys(config).toSorted()).toEqual([
      'agentDir',
      'contextCeiling',
      'cwd',
      'memoryPolicy',
      'model',
      'projectTrusted',
      'prompt',
      'provider',
      'resourcePolicy',
      'thinkingLevel',
      'tools',
      'version',
    ])
    expect(config.projectTrusted).toBe(true)
    expect(JSON.stringify({ config, profile })).not.toContain('parent-memory-must-not-leak')
    expect(Value.Check(WorkerConfigSchema, { ...config, secret: 'no' })).toBe(false)
  })

  it('accepts historical list/read records but excludes starting and validates public result variants', () => {
    const entry = { current_turn: 1, follow_up_available: false, profile: 'removed-profile', status: 'completed', task_name: 'task' }
    const record = { profile: 'removed-profile', status: 'interrupted', task_name: 'task', turns: [] }
    expect(Value.Check(AgentListEntrySchema, entry)).toBe(true)
    expect(Value.Check(AgentListEntrySchema, { ...entry, status: 'starting' })).toBe(false)
    expect(Value.Check(AgentRecordViewSchema, record)).toBe(true)
    expect(Value.Check(AgentRecordViewSchema, { ...record, status: 'starting' })).toBe(false)
    for (const result of [
      { conclusion: 'done', status: 'completed', task_name: 'task', turn: 1 },
      { conclusion: 'done', full_result_path: '/result', status: 'completed', task_name: 'task', truncated: true, turn: 1 },
      { error: { code: 'agent_failed', message: 'no' }, status: 'failed', task_name: 'task', turn: 1 },
      { error: { code: 'interrupted', message: 'no' }, status: 'interrupted', task_name: 'task', turn: 1 },
    ]) {
      expect(Value.Check(AgentResultSchema, result)).toBe(true)
    }
    expect(Value.Check(AgentResultSchema, { conclusion: 'done', status: 'completed', task_name: 'task', truncated: false, turn: 1 })).toBe(false)
  })

  it('validates protocol discriminants and rejects mixed or out-of-bound result frames', () => {
    const worker = deriveWorkerConfig(resolvedProfile('scout'), snapshot())
    const frames = [
      [
        ParentConfigFrameSchema,
        {
          agent_id: 'a',
          run_dir: '/run',
          session: { expected_dir: '/session', mode: 'create' },
          turn: 1,
          type: 'config',
          version: 1,
          worker,
        },
      ],
      [ParentInterruptFrameSchema, { agent_id: 'a', command_id: 'c', turn: 1, type: 'interrupt' }],
      [ParentSteerFrameSchema, { agent_id: 'a', command_id: 'c', message: 'steer', turn: 1, type: 'steer' }],
      [ParentTaskFrameSchema, { agent_id: 'a', command_id: 'c', message: 'task', turn: 1, type: 'task' }],
      [
        ChildCommandErrorFrameSchema,
        { agent_id: 'a', code: 'queue_rejected', command_id: 'c', error: 'no', status: 'running', turn: 1, type: 'command_error' },
      ],
      [ChildProgressFrameSchema, { activity: 'agent_started', agent_id: 'a', command_id: 'c', turn: 1, type: 'progress' }],
      [ChildReadyFrameSchema, { agent_id: 'a', command_id: 'c', session_path: '/session', turn: 1, type: 'ready' }],
      [ChildSteerAckFrameSchema, { agent_id: 'a', command_id: 'c', turn: 1, type: 'steer_ack' }],
    ] as const
    for (const [schema, frame] of frames) {
      expect(Value.Check(schema, frame)).toBe(true)
      expect(Value.Check(schema, { ...frame, type: 'invalid' })).toBe(false)
    }
    const artifact = {
      agent_id: 'a',
      command_id: 'c',
      conclusion_artifact: 'f',
      conclusion_bytes: 1,
      conclusion_preview: 'p',
      status: 'completed',
      turn: 1,
      type: 'result',
    }
    expect(Value.Check(ChildResultFrameSchema, artifact)).toBe(true)
    expect(Value.Check(ChildResultFrameSchema, { ...artifact, conclusion_bytes: 0 })).toBe(false)
    expect(Value.Check(ChildResultFrameSchema, { ...artifact, conclusion_bytes: -1 })).toBe(false)
    expect(Value.Check(ChildResultFrameSchema, { ...artifact, conclusion_bytes: 1.5 })).toBe(false)
    expect(Value.Check(ChildResultFrameSchema, { ...artifact, conclusion_bytes: 10 * 1024 * 1024 + 1 })).toBe(false)
    expect(Value.Check(ChildResultFrameSchema, { ...artifact, conclusion_preview: 'x'.repeat(50 * 1024 + 1) })).toBe(false)
    expect(
      Value.Check(ChildResultFrameSchema, {
        agent_id: 'a',
        command_id: 'c',
        conclusion: 'x'.repeat(50 * 1024 + 1),
        status: 'completed',
        turn: 1,
        type: 'result',
      })
    ).toBe(false)
    expect(Value.Check(ChildResultFrameSchema, { ...artifact, conclusion: 'mixed' })).toBe(false)
    expect(
      Value.Check(ChildResultFrameSchema, {
        agent_id: 'a',
        command_id: 'c',
        error: { code: 'interrupted', message: 'no' },
        status: 'failed',
        turn: 1,
        type: 'result',
      })
    ).toBe(false)
  })
})
