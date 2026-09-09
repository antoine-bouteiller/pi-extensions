type ProviderQuotaLabel = 'anthropic' | 'azure'

export interface QuotaWindow {
  label: string
  percent: number
  detail?: string
  resetsIn?: string
}

export interface ProviderQuota {
  label: ProviderQuotaLabel
  percent: number
  detail?: string
  windows?: readonly QuotaWindow[]
}

export type ProviderQuotas = Partial<Record<ProviderQuotaLabel, ProviderQuota>>

export interface ModelInfoState {
  provider: string
  modelId: string
  thinking: string
  contextTokens: number | undefined
  contextWindow: number
  contextPercent: number | undefined
  cacheHitPercent: number | undefined
  tokensPerSecond: number | undefined
}

interface TurnMetricsInput {
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
  timestamp: number
}

export const turnMetrics = ({ usage, timestamp }: TurnMetricsInput, now: number): Pick<ModelInfoState, 'cacheHitPercent' | 'tokensPerSecond'> => {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite
  const seconds = (now - timestamp) / 1000
  return {
    cacheHitPercent: promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined,
    tokensPerSecond: seconds > 0 && usage.output > 0 ? usage.output / seconds : undefined,
  }
}

interface PullRequestInfo {
  number: number
  url: string
}

export interface GitInfoState {
  branch: string | undefined
  changedFiles: number
  pullRequest: PullRequestInfo | undefined
}

export const emptyModelInfoState = (): ModelInfoState => ({
  cacheHitPercent: undefined,
  contextPercent: undefined,
  contextTokens: undefined,
  contextWindow: 0,
  modelId: 'no-model',
  provider: '',
  thinking: 'off',
  tokensPerSecond: undefined,
})

export const emptyGitInfoState = (): GitInfoState => ({
  branch: undefined,
  changedFiles: 0,
  pullRequest: undefined,
})

export interface PanelState {
  activity: 'ready' | 'working'
  model: ModelInfoState
  git: GitInfoState
  quotas: ProviderQuotas
}

export const emptyPanelState = (): PanelState => ({
  activity: 'ready',
  git: emptyGitInfoState(),
  model: emptyModelInfoState(),
  quotas: {},
})
