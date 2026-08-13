import { type ThemeColor } from '@earendil-works/pi-coding-agent'

import { isEmptyString } from '@/shared/utils/predicates.js'

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export interface AvailableModel {
  provider: string
  id: string
}

export interface ModelSelectorContext {
  availableModels: readonly Readonly<AvailableModel>[]
  parentModel: Readonly<AvailableModel>
}

type ModelSelector = string | ((context: ModelSelectorContext) => string)

export interface AgentConfig {
  allowedTools: readonly string[]
  model: ModelSelector
  prompt: string
  isReadonly: boolean
  description?: string
  thinking?: ThinkingLevel
  color?: ThemeColor
}

export interface ResolvedAgentConfig {
  key: string
  allowedTools: readonly string[]
  provider: string
  modelId: string
  prompt: string
  isReadonly: boolean
  description: string
  thinking: ThinkingLevel
  color: ThemeColor
}

const EXPLORATION_TOOLS = ['read', 'bash', 'grep', 'find', 'ls', 'mcp', 'fffind', 'ffgrep', 'fff-multi-grep'] as const

export const AGENT_CONFIGS = {
  librarian: {
    allowedTools: ['webfetch', 'mcp'],
    color: 'mdLink',
    description: 'Cited web and remote-system research',
    isReadonly: true,
    model: 'gpt-5.6-luna',
    prompt: `You are a research librarian. Investigate the assigned external, web, or remote-system question and return a concise synthesis. Cite source URLs or remote record identifiers for every important claim, distinguish facts from inference, and call out uncertainty. Do not modify remote or local state.`,
    thinking: 'low',
  },
  reviewer: {
    allowedTools: EXPLORATION_TOOLS,
    color: 'warning',
    description: 'Read-only plan and implementation review',
    isReadonly: true,
    model: 'gpt-5.6-sol',
    // Model: ({ parentModel }) => (parentModel.provider === 'anthropic' ? 'gpt-5.6-sol' : 'claude-opus-5'),
    prompt: `You are a read-only senior reviewer. Review the requested plan or implementation for correctness, security, performance, architecture, maintainability, and test coverage. Inspect evidence directly, prioritize actionable findings by severity, and include exact file and line references. Do not modify files or remote state.`,
    thinking: 'high',
  },
  scout: {
    allowedTools: EXPLORATION_TOOLS,
    color: 'accent',
    description: 'Quick codebase exploration and focused implementation reconnaissance',
    isReadonly: true,
    model: 'gpt-5.6-luna',
    prompt: `You are a fast codebase scout. Explore the assigned repository scope efficiently and return a concise, factual report for the parent agent. Identify the relevant files, symbols, behavior, tests, and risks. Quote exact paths and line references where useful. Do not modify files.`,
    thinking: 'low',
  },
} satisfies Record<string, AgentConfig>

export type AgentProfileName = keyof typeof AGENT_CONFIGS

// Order is semantic, so it is declared here rather than read back from the sorted lookup table.
export const AGENT_PROFILE_NAMES = Object.freeze(['scout', 'librarian', 'reviewer'] as const satisfies readonly AgentProfileName[])

const GOOGLE_PROVIDER_PATTERN = /(?:^|[-_])(?<provider>google|gemini)(?:$|[-_])/i
const GOOGLE_MODEL_PATTERN = /^gemini(?:$|[-_.])/i
const OFFICIAL_OPENAI_PROVIDERS = new Set(['openai-codex', 'azure-openai', 'azure-openai-responses'])
const OFFICIAL_ANTHROPIC_PROVIDERS = new Set(['anthropic-oauth', 'amazon-bedrock', 'aws-bedrock', 'anthropic-vertex'])

const isGoogleCandidate = (model: AvailableModel): boolean => GOOGLE_PROVIDER_PATTERN.test(model.provider) || GOOGLE_MODEL_PATTERN.test(model.id)
export const isClaudeModelId = (modelId: string): boolean => /^claude(?:-|$)/i.test(modelId)

const canonicalProvider = (modelId: string): 'openai' | 'anthropic' | undefined => {
  if (/^(?:gpt-|o[1-9](?:-|$)|chatgpt-)/i.test(modelId)) {
    return 'openai'
  }
  return isClaudeModelId(modelId) ? 'anthropic' : undefined
}

const providerRank = (provider: string, modelId: string): number => {
  const canonical = canonicalProvider(modelId)
  if (provider === canonical) {
    return 0
  }
  if (
    (canonical === 'openai' && OFFICIAL_OPENAI_PROVIDERS.has(provider)) ||
    (canonical === 'anthropic' && OFFICIAL_ANTHROPIC_PROVIDERS.has(provider))
  ) {
    return 1
  }
  return 2
}

export const hasModelId = (models: readonly AvailableModel[], id: string): boolean =>
  models.some((model) => model.id === id && !isGoogleCandidate(model))

export const parseModelSelector = (selector: string): { provider?: string; id: string } => {
  const normalized = selector.trim()
  if (isEmptyString(normalized)) {
    throw new Error('Model selector must not be empty.')
  }
  const slash = normalized.indexOf('/')
  if (slash === -1) {
    return { id: normalized }
  }
  const provider = normalized.slice(0, slash).trim()
  const id = normalized.slice(slash + 1).trim()
  if (isEmptyString(provider) || isEmptyString(id)) {
    throw new Error(`Invalid provider-qualified model selector: ${selector}`)
  }
  return { id, provider }
}

export const resolveModelSelector = (selector: string, availableModels: readonly AvailableModel[]): AvailableModel => {
  const parsed = parseModelSelector(selector)
  const candidates = availableModels.filter(
    (model) => model.id === parsed.id && (parsed.provider === undefined || model.provider === parsed.provider) && !isGoogleCandidate(model)
  )
  if (candidates.length === 0) {
    throw new Error(`Configured model is not authenticated or available: ${selector}`)
  }
  return [...candidates].toSorted(
    (left, right) =>
      providerRank(left.provider, left.id) - providerRank(right.provider, right.id) ||
      left.provider.localeCompare(right.provider) ||
      left.id.localeCompare(right.id)
  )[0]
}

export const firstAvailable = (models: readonly AvailableModel[], ...selectors: readonly string[]): string | undefined =>
  selectors.find((selector) => {
    try {
      resolveModelSelector(selector, models)
      return true
    } catch {
      return false
    }
  })

export const getAgentProfileNames = (registry?: Readonly<Record<string, AgentConfig>>): readonly string[] =>
  registry === undefined ? AGENT_PROFILE_NAMES : Object.freeze(Object.keys(registry))

export const getAgentProfilesDescription = (registry?: Readonly<Record<string, AgentConfig>>): string => {
  const configs: Readonly<Record<string, AgentConfig>> = registry ?? AGENT_CONFIGS
  return getAgentProfileNames(registry)
    .map((key) => {
      const config = configs[key]
      return `- \`${key}\` — ${config.description?.trim() || key} — ${config.isReadonly ? 'read-only' : 'write-capable'}`
    })
    .join('\n')
}

export const resolveAgentConfig = (
  key: string,
  context: ModelSelectorContext,
  registry: Readonly<Record<string, AgentConfig>> = AGENT_CONFIGS
): ResolvedAgentConfig => {
  const config = registry[key]
  if (config === undefined) {
    throw new Error(`Unknown agent profile: ${key}`)
  }
  const availableModels = Object.freeze(context.availableModels.map((model) => Object.freeze({ id: model.id, provider: model.provider })))
  const selectorContext = Object.freeze({
    availableModels,
    parentModel: Object.freeze({
      id: context.parentModel.id,
      provider: context.parentModel.provider,
    }),
  })
  const selector = typeof config.model === 'function' ? config.model(selectorContext) : config.model
  if (typeof selector !== 'string') {
    throw new Error(`Agent profile ${key} returned an invalid model selector.`)
  }
  const selected = resolveModelSelector(selector, availableModels)
  const allowedTools = Object.freeze([...new Set(config.allowedTools.map((tool) => tool.trim()).filter(Boolean))])
  if (allowedTools.length === 0) {
    throw new Error(`Agent profile ${key} must allow at least one tool.`)
  }
  if (isEmptyString(config.prompt.trim())) {
    throw new Error(`Agent profile ${key} must define a prompt.`)
  }
  return Object.freeze({
    allowedTools,
    color: config.color ?? 'accent',
    description: config.description?.trim() || key,
    isReadonly: config.isReadonly,
    key,
    modelId: selected.id,
    prompt: config.prompt,
    provider: selected.provider,
    thinking: config.thinking ?? 'high',
  })
}

export const THEME_COLOR_VALUES = [
  'accent',
  'border',
  'borderAccent',
  'borderMuted',
  'success',
  'error',
  'warning',
  'muted',
  'dim',
  'text',
  'thinkingText',
  'userMessageText',
  'customMessageText',
  'customMessageLabel',
  'toolTitle',
  'toolOutput',
  'mdHeading',
  'mdLink',
  'mdLinkUrl',
  'mdCode',
  'mdCodeBlock',
  'mdCodeBlockBorder',
  'mdQuote',
  'mdQuoteBorder',
  'mdHr',
  'mdListBullet',
  'toolDiffAdded',
  'toolDiffRemoved',
  'toolDiffContext',
  'syntaxComment',
  'syntaxKeyword',
  'syntaxFunction',
  'syntaxVariable',
  'syntaxString',
  'syntaxNumber',
  'syntaxType',
  'syntaxOperator',
  'syntaxPunctuation',
  'thinkingOff',
  'thinkingMinimal',
  'thinkingLow',
  'thinkingMedium',
  'thinkingHigh',
  'thinkingXhigh',
  'thinkingMax',
  'bashMode',
] as const satisfies readonly ThemeColor[]

const THEME_COLORS: ReadonlySet<string> = new Set<ThemeColor>(THEME_COLOR_VALUES)

export const configuredProfileColor = (profile: unknown): ThemeColor => {
  if (typeof profile !== 'string') {
    return 'muted'
  }
  const config = (AGENT_CONFIGS as Readonly<Record<string, AgentConfig>>)[profile]
  return config === undefined ? 'muted' : (config.color ?? 'accent')
}

const isThemeColor = (value: unknown): value is ThemeColor => typeof value === 'string' && THEME_COLORS.has(value)

export const persistedProfileColor = (profile: unknown, color: unknown): ThemeColor =>
  typeof profile === 'string' && isThemeColor(color) ? color : 'muted'
