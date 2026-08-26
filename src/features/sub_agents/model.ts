import { Type, type Static, type TProperties } from 'typebox'

const closed = <Properties extends TProperties>(properties: Properties) => Type.Object(properties, { additionalProperties: false })

export const TaskNameSchema = Type.String({ maxLength: 64, minLength: 1, pattern: '^[A-Za-z0-9_.-]+$' })

const ToolErrorCodeSchema = Type.Union([
  Type.Literal('unknown_profile'),
  Type.Literal('duplicate_task_name'),
  Type.Literal('capacity_exceeded'),
  Type.Literal('missing_provider'),
  Type.Literal('missing_model'),
  Type.Literal('unavailable_tool'),
  Type.Literal('unsafe_tool'),
  Type.Literal('startup_timeout'),
  Type.Literal('startup_failed'),
  Type.Literal('frame_too_large'),
  Type.Literal('protocol_error'),
  Type.Literal('unknown_agent'),
  Type.Literal('empty_targets'),
  Type.Literal('duplicate_target'),
  Type.Literal('not_ready'),
  Type.Literal('follow_up_used'),
  Type.Literal('not_resumable'),
  Type.Literal('context_limit'),
  Type.Literal('agent_failed'),
  Type.Literal('turn_timeout'),
  Type.Literal('interrupted'),
  Type.Literal('result_too_large'),
  Type.Literal('session_unavailable'),
])
export type ToolErrorCode = Static<typeof ToolErrorCodeSchema>

const ProfileKeySchema = Type.Union([Type.Literal('scout'), Type.Literal('librarian'), Type.Literal('reviewer'), Type.Literal('implementer')])
export type ProfileKey = Static<typeof ProfileKeySchema>

const ErrorSchema = closed({ code: ToolErrorCodeSchema, message: Type.String() })

export const AgentResultSchema = Type.Union([
  closed({ conclusion: Type.String(), status: Type.Literal('completed'), task_name: TaskNameSchema, turn: Type.Integer() }),
  closed({
    conclusion: Type.String(),
    full_result_path: Type.String(),
    status: Type.Literal('completed'),
    task_name: TaskNameSchema,
    truncated: Type.Literal(true),
    turn: Type.Integer(),
  }),
  closed({
    error: ErrorSchema,
    status: Type.Union([Type.Literal('failed'), Type.Literal('interrupted')]),
    task_name: TaskNameSchema,
    turn: Type.Integer(),
  }),
])
export type AgentResult = Static<typeof AgentResultSchema>

const RunningAcceptanceSchema = closed({
  profile: ProfileKeySchema,
  status: Type.Literal('running'),
  task_name: TaskNameSchema,
  turn: Type.Integer(),
})
const SteeringAckSchema = closed({
  accepted: Type.Literal(true),
  status: Type.Literal('running'),
  task_name: TaskNameSchema,
  turn: Type.Integer(),
})
const CommandErrorSchema = Type.Union([
  closed({
    accepted: Type.Literal(false),
    error: closed({ code: Type.Literal('queue_rejected'), message: Type.String() }),
    status: Type.Literal('running'),
    task_name: TaskNameSchema,
    turn: Type.Integer(),
  }),
  closed({
    accepted: Type.Literal(false),
    error: closed({ code: Type.Literal('turn_settled'), message: Type.String() }),
    status: Type.Union([Type.Literal('completed'), Type.Literal('failed'), Type.Literal('interrupted')]),
    task_name: TaskNameSchema,
    turn: Type.Integer(),
  }),
])
export type CommandError = Static<typeof CommandErrorSchema>
const SettledInterruptNoopSchema = closed({
  interrupted: Type.Literal(false),
  status: Type.Union([Type.Literal('completed'), Type.Literal('failed'), Type.Literal('interrupted')]),
  task_name: TaskNameSchema,
  turn: Type.Integer(),
})
export const AgentListEntrySchema = closed({
  current_turn: Type.Integer(),
  follow_up_available: Type.Boolean(),
  profile: Type.String(),
  status: Type.Union([Type.Literal('running'), Type.Literal('completed'), Type.Literal('failed'), Type.Literal('interrupted')]),
  task_name: TaskNameSchema,
})
export const AgentRecordViewSchema = closed({
  profile: Type.String(),
  status: Type.Union([Type.Literal('running'), Type.Literal('completed'), Type.Literal('failed'), Type.Literal('interrupted')]),
  task_name: TaskNameSchema,
  turns: Type.Array(AgentResultSchema),
})

export const WaitAllInputSchema = closed({ targets: Type.Optional(Type.Array(TaskNameSchema, { minItems: 1 })) })
export const WaitAgentInputSchema = closed({ targets: Type.Optional(Type.Array(TaskNameSchema, { minItems: 1 })) })
export const ListAgentsInputSchema = closed({})
export const ReadAgentResponseInputSchema = closed({ target: TaskNameSchema })
export const SendMessageInputSchema = closed({ message: Type.String(), target: TaskNameSchema })
export const InterruptAgentInputSchema = closed({ target: TaskNameSchema })
export type RunningAcceptance = Static<typeof RunningAcceptanceSchema>
export type SteeringAck = Static<typeof SteeringAckSchema>
export type SettledInterruptNoop = Static<typeof SettledInterruptNoopSchema>
export type AgentListEntry = Static<typeof AgentListEntrySchema>
export type AgentRecordView = Static<typeof AgentRecordViewSchema>
export type SpawnAgentInput = Static<typeof SpawnAgentInputSchema>
export type WaitAllInput = Static<typeof WaitAllInputSchema>
export type WaitAgentInput = Static<typeof WaitAgentInputSchema>
export type ReadAgentResponseInput = Static<typeof ReadAgentResponseInputSchema>
export type SendMessageInput = Static<typeof SendMessageInputSchema>
export type InterruptAgentInput = Static<typeof InterruptAgentInputSchema>

interface ChildModel {
  readonly contextWindow: number
  /** Runtime-only maximum output size; absent for injected or older model views. */
  readonly maxTokens?: number
  readonly model: string
  readonly provider: string
}

export const toChildModel = (model: {
  readonly contextWindow: number
  readonly id: string
  readonly maxTokens?: number
  readonly provider: string
}): ChildModel =>
  model.maxTokens === undefined
    ? { contextWindow: model.contextWindow, model: model.id, provider: model.provider }
    : { contextWindow: model.contextWindow, maxTokens: model.maxTokens, model: model.id, provider: model.provider }
/** This is constructed by the adapter's child-equivalent runtime, never from parent-memory keys. */
export interface ChildModelView {
  readonly authenticated_providers: readonly string[]
  readonly models: readonly ChildModel[]
}
export interface AdmissionSnapshot {
  readonly agent_dir: string
  readonly child_model_view: ChildModelView
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly parent_model?: { readonly model: string; readonly provider: string }
  readonly project_trusted: boolean
  readonly registered_tools: readonly string[]
}

const ThinkingLevelSchema = Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])
export const PersistedResolvedProfileSchema = closed({
  contextCeiling: Type.Number(),
  key: ProfileKeySchema,
  model: Type.String(),
  prompt: Type.String(),
  provider: Type.String(),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  tools: Type.Array(Type.String()),
})
export type PersistedResolvedProfile = Static<typeof PersistedResolvedProfileSchema>
export const WorkerConfigSchema = closed({
  agentDir: Type.String(),
  contextCeiling: Type.Number(),
  cwd: Type.String(),
  memoryPolicy: closed({ inMemory: Type.Literal('fixed'), persistence: Type.Literal('session_file_only') }),
  model: Type.String(),
  projectTrusted: Type.Boolean(),
  prompt: Type.String(),
  provider: Type.String(),
  resourcePolicy: closed({
    configuredExtensions: Type.Literal(true),
    contextFiles: Type.Literal(false),
    promptTemplates: Type.Literal(false),
    skills: Type.Literal(false),
  }),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  tools: Type.Array(Type.String()),
  version: Type.Literal(1),
})
export type WorkerConfig = Static<typeof WorkerConfigSchema>

interface ProfileResolutionError {
  readonly code: Extract<ToolErrorCode, 'missing_model' | 'missing_provider' | 'unavailable_tool' | 'unknown_profile' | 'unsafe_tool'>
  readonly message: string
}
export type ProfileResolution =
  | { readonly maxOutputTokens?: number; readonly ok: true; readonly profile: PersistedResolvedProfile }
  | { readonly error: ProfileResolutionError; readonly ok: false }

export interface ProfileDefinition {
  readonly contextCeiling?: number
  readonly description: string
  readonly key: ProfileKey
  readonly prompt: string
  readonly requiredTools: readonly string[]
  readonly thinkingLevel: 'high' | 'low' | 'medium'
}

export const PROFILE_REGISTRY = {
  implementer: {
    description: 'Scoped code implementation and verification — write-capable',
    key: 'implementer',
    prompt: `You are a scoped implementation agent. Complete only the delegated task. Inspect
the relevant code, make the smallest correct change, and preserve validation,
security, data-loss prevention, and accessibility boundaries. Do not broaden the
task or refactor unrelated code. Run focused existing checks and return the
changed paths, verification results, and any blocker requiring a parent decision.\n`,
    requiredTools: ['read', 'ffgrep', 'fffind', 'bash', 'edit', 'write'],
    thinkingLevel: 'medium',
  },
  librarian: {
    description: 'Cited web and remote-system research — read-only by policy',
    key: 'librarian',
    prompt: `You are a cited research agent. Investigate only the delegated question using
local, web, and configured remote sources. Do not modify local or remote state.
Cite the source for each material claim, distinguish documented fact from
inference, and return a concise synthesis. If a source or operation is unavailable,
state the limitation rather than guessing.\n`,
    requiredTools: ['read', 'ffgrep', 'fffind', 'webfetch', 'mcp'],
    thinkingLevel: 'low',
  },
  reviewer: {
    description: 'Read-only plan and implementation review',
    key: 'reviewer',
    prompt: `You are a read-only code reviewer. Inspect the requested change and only the
context needed to assess it. Prioritize correctness, security, data loss, and
behavioral regressions. Report actionable findings in severity order with file
and line references and reasoning. Do not modify files, report unrelated
pre-existing issues, or raise style-only comments unless asked. If there are no
findings, say so explicitly.\n`,
    requiredTools: ['read', 'ffgrep', 'fffind', 'bash'],
    thinkingLevel: 'high',
  },
  scout: {
    description: 'Quick codebase exploration and focused implementation reconnaissance — read-only by policy',
    key: 'scout',
    prompt: `You are a fast codebase exploration agent. Investigate only the delegated task.
Use local read, search, and shell tools to inspect; do not modify files or external
systems. Return a concise conclusion with relevant paths, symbols, and evidence.
If the task requires a product decision or mutation, explain the blocker instead.\n`,
    requiredTools: ['read', 'ffgrep', 'fffind', 'bash'],
    thinkingLevel: 'low',
  },
} satisfies Readonly<Record<ProfileKey, ProfileDefinition>>

const ProfileAgentTypeSchema = Type.Union([
  Type.Literal('scout', { description: PROFILE_REGISTRY.scout.description }),
  Type.Literal('librarian', { description: PROFILE_REGISTRY.librarian.description }),
  Type.Literal('reviewer', { description: PROFILE_REGISTRY.reviewer.description }),
  Type.Literal('implementer', { description: PROFILE_REGISTRY.implementer.description }),
])
export const SpawnAgentInputSchema = closed({
  agent_type: ProfileAgentTypeSchema,
  message: Type.String(),
  run_in_background: Type.Optional(Type.Boolean()),
  task_name: TaskNameSchema,
})

type ToolClassification = 'async-process' | 'delegation' | 'local-read' | 'local-write' | 'network-read' | 'operator' | 'remote-gateway' | 'shell'
const TOOL_CLASSES = {
  ask_user: 'operator',
  background_poll: 'async-process',
  bash: 'shell',
  edit: 'local-write',
  fffind: 'local-read',
  ffgrep: 'local-read',
  hashline_read: 'local-read',
  hashline_write: 'local-write',
  interrupt_agent: 'delegation',
  list_agents: 'delegation',
  mcp: 'remote-gateway',
  read: 'local-read',
  read_agent_response: 'delegation',
  safe_rm: 'local-write',
  send_message: 'delegation',
  spawn_agent: 'delegation',
  wait_agent: 'delegation',
  wait_all_agents: 'delegation',
  webfetch: 'network-read',
  write: 'local-write',
} satisfies Readonly<Record<string, ToolClassification>>
interface ModelSelection {
  readonly model: string
  readonly provider: string
}

const modelFor = (key: ProfileKey, parentProvider: string | undefined): ModelSelection => {
  if (key === 'reviewer') {
    return parentProvider === 'openai' ? { model: 'claude-opus-5', provider: 'anthropic' } : { model: 'gpt-5.6-sol', provider: 'azure-openai' }
  }
  if (key === 'implementer') {
    return { model: 'gpt-5.6-terra', provider: 'azure-openai' }
  }
  return { model: 'gpt-5.6-luna', provider: 'azure-openai' }
}
const refusal = (code: ProfileResolutionError['code'], message: string): ProfileResolution => ({ error: { code, message }, ok: false })
const has = (values: readonly string[], value: string): boolean => values.includes(value)

const IMPLEMENTER_EXCLUDED_TOOL_CLASSES = new Set<ToolClassification>(['async-process', 'delegation', 'operator'])
const classificationOf = (tool: string): ToolClassification | undefined => Object.entries(TOOL_CLASSES).find(([name]) => name === tool)?.[1]
const isSafeRequiredTool = (tool: string): boolean => {
  const classification = classificationOf(tool)
  return classification !== undefined && !IMPLEMENTER_EXCLUDED_TOOL_CLASSES.has(classification)
}
const implementerTools = (registeredTools: readonly string[]): string[] => registeredTools.filter(isSafeRequiredTool)

export const resolveProfileWithRegistry = (
  key: string,
  snapshot: AdmissionSnapshot,
  registry: Readonly<Record<ProfileKey, ProfileDefinition>>
): ProfileResolution => {
  const profile = Object.values(registry).find((candidate) => candidate.key === key)
  if (profile === undefined) {
    return refusal('unknown_profile', `Unknown profile "${key}".`)
  }
  const selected = modelFor(profile.key, snapshot.parent_model?.provider)
  if (!has(snapshot.child_model_view.authenticated_providers, selected.provider)) {
    return refusal('missing_provider', `Selected provider "${selected.provider}" is unavailable to the child.`)
  }
  const model = snapshot.child_model_view.models.find(({ model: id, provider }) => id === selected.model && provider === selected.provider)
  if (model === undefined) {
    return refusal('missing_model', `Selected model "${selected.provider}/${selected.model}" is unavailable to the child.`)
  }
  const unsafe = profile.requiredTools.find((tool) => !isSafeRequiredTool(tool))
  if (unsafe !== undefined) {
    return refusal('unsafe_tool', `Configured tool "${unsafe}" is unsafe.`)
  }
  const missing = profile.requiredTools.find((tool) => !has(snapshot.registered_tools, tool))
  if (missing !== undefined) {
    return refusal('unavailable_tool', `Required tool "${missing}" is unavailable.`)
  }
  const tools = profile.key === 'implementer' ? implementerTools(snapshot.registered_tools) : [...new Set(profile.requiredTools)]
  const resolvedProfile = {
    contextCeiling: Math.min(profile.contextCeiling ?? 200_000, model.contextWindow),
    key: profile.key,
    model: selected.model,
    prompt: profile.prompt,
    provider: selected.provider,
    thinkingLevel: profile.thinkingLevel,
    tools: [...tools],
  }
  if (model.maxTokens === undefined) {
    return { ok: true, profile: resolvedProfile }
  }
  return { maxOutputTokens: model.maxTokens, ok: true, profile: resolvedProfile }
}

export const resolveProfile = (key: string, snapshot: AdmissionSnapshot): ProfileResolution =>
  resolveProfileWithRegistry(key, snapshot, PROFILE_REGISTRY)

export const deriveWorkerConfig = (profile: PersistedResolvedProfile, snapshot: AdmissionSnapshot): WorkerConfig => ({
  agentDir: snapshot.agent_dir,
  contextCeiling: profile.contextCeiling,
  cwd: snapshot.cwd,
  memoryPolicy: { inMemory: 'fixed', persistence: 'session_file_only' },
  model: profile.model,
  projectTrusted: snapshot.project_trusted,
  prompt: profile.prompt,
  provider: profile.provider,
  resourcePolicy: { configuredExtensions: true, contextFiles: false, promptTemplates: false, skills: false },
  thinkingLevel: profile.thinkingLevel,
  tools: [...profile.tools],
  version: 1,
})

export const ParentConfigFrameSchema = closed({
  agent_id: Type.String(),
  run_dir: Type.String(),
  session: Type.Union([
    closed({ expected_dir: Type.String(), mode: Type.Literal('create') }),
    closed({ canonical_path: Type.String(), mode: Type.Literal('open') }),
  ]),
  turn: Type.Integer(),
  type: Type.Literal('config'),
  version: Type.Literal(1),
  worker: WorkerConfigSchema,
})
const ParentCommandFields = { agent_id: Type.String(), command_id: Type.String(), message: Type.String(), turn: Type.Integer() }
export const ParentTaskFrameSchema = closed({ ...ParentCommandFields, type: Type.Literal('task') })
export const ParentSteerFrameSchema = closed({ ...ParentCommandFields, type: Type.Literal('steer') })
export const ParentInterruptFrameSchema = closed({
  agent_id: Type.String(),
  command_id: Type.String(),
  turn: Type.Integer(),
  type: Type.Literal('interrupt'),
})
export const ChildReadyFrameSchema = closed({
  agent_id: Type.String(),
  command_id: Type.String(),
  session_path: Type.String(),
  turn: Type.Integer(),
  type: Type.Literal('ready'),
})
export const ChildProgressFrameSchema = closed({
  activity: Type.Union([
    Type.Literal('agent_started'),
    Type.Literal('assistant_activity'),
    Type.Literal('tool_started'),
    Type.Literal('tool_finished'),
  ]),
  agent_id: Type.String(),
  command_id: Type.String(),
  turn: Type.Integer(),
  type: Type.Literal('progress'),
})
export const ChildSteerAckFrameSchema = closed({
  agent_id: Type.String(),
  command_id: Type.String(),
  turn: Type.Integer(),
  type: Type.Literal('steer_ack'),
})
export const ChildCommandErrorFrameSchema = Type.Union([
  closed({
    agent_id: Type.String(),
    code: Type.Literal('queue_rejected'),
    command_id: Type.String(),
    error: Type.String(),
    status: Type.Literal('running'),
    turn: Type.Integer(),
    type: Type.Literal('command_error'),
  }),
  closed({
    agent_id: Type.String(),
    code: Type.Literal('turn_settled'),
    command_id: Type.String(),
    error: Type.String(),
    status: Type.Union([Type.Literal('completed'), Type.Literal('failed'), Type.Literal('interrupted')]),
    turn: Type.Integer(),
    type: Type.Literal('command_error'),
  }),
])
const MAX_INLINE_RESULT_CHARS = 50 * 1024
const InlineResultSchema = Type.String({ maxLength: MAX_INLINE_RESULT_CHARS })

export const ChildResultFrameSchema = Type.Union([
  closed({
    agent_id: Type.String(),
    command_id: Type.String(),
    conclusion: InlineResultSchema,
    context_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
    status: Type.Literal('completed'),
    turn: Type.Integer(),
    type: Type.Literal('result'),
  }),
  closed({
    agent_id: Type.String(),
    command_id: Type.String(),
    conclusion_artifact: Type.String(),
    conclusion_bytes: Type.Integer({ maximum: 10 * 1024 * 1024, minimum: 1 }),
    conclusion_preview: InlineResultSchema,
    context_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
    status: Type.Literal('completed'),
    turn: Type.Integer(),
    type: Type.Literal('result'),
  }),
  closed({
    agent_id: Type.String(),
    command_id: Type.String(),
    error: closed({ code: Type.Union([Type.Literal('agent_failed'), Type.Literal('result_too_large')]), message: Type.String() }),
    status: Type.Literal('failed'),
    turn: Type.Integer(),
    type: Type.Literal('result'),
  }),
  closed({
    agent_id: Type.String(),
    command_id: Type.String(),
    error: closed({ code: Type.Literal('interrupted'), message: Type.String() }),
    status: Type.Literal('interrupted'),
    turn: Type.Integer(),
    type: Type.Literal('result'),
  }),
])

export const deriveChildEnvironment = (
  profile: Pick<PersistedResolvedProfile, 'key'>,
  snapshot: AdmissionSnapshot,
  agentId: string,
  uuid: () => string = () => Bun.randomUUIDv7()
): Readonly<Record<string, string>> => {
  const child = Object.fromEntries(Object.entries(snapshot.environment).filter(([key]) => !key.startsWith('PI_SUBAGENT')))
  child.PI_SUBAGENT = '1'
  child.PI_SUBAGENT_ID = agentId
  child.PI_SUBAGENT_OWNER_TOKEN = uuid()
  if (profile.key !== 'implementer') {
    child.PI_SUBAGENT_READONLY = '1'
  }
  return child
}
