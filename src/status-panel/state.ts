export interface QuotaWindow {
  label: string
  percent: number
  resetsIn?: string
}

export interface ProviderQuota {
  label: string
  percent: number
  detail?: string
  windows?: readonly QuotaWindow[]
}

export interface ModelInfoState {
  provider: string
  modelId: string
  thinking: string
  contextTokens: number | undefined
  contextWindow: number
  contextPercent: number | undefined
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
  contextPercent: undefined,
  contextTokens: undefined,
  contextWindow: 0,
  modelId: 'no-model',
  provider: '',
  thinking: 'off',
})

export const emptyGitInfoState = (): GitInfoState => ({
  branch: undefined,
  changedFiles: 0,
  pullRequest: undefined,
})
