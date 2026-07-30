export interface ProviderQuota {
  label: string;
  percent: number;
  detail?: string;
}

export interface ModelInfoState {
  provider: string;
  modelId: string;
  thinking: string;
  contextTokens: number | null;
  contextWindow: number;
  contextPercent: number | null;
}

export interface PullRequestInfo {
  number: number;
  url: string;
}

export interface GitInfoState {
  branch: string | null;
  changedFiles: number;
  pullRequest: PullRequestInfo | null;
}

export function emptyModelInfoState(): ModelInfoState {
  return {
    provider: "",
    modelId: "no-model",
    thinking: "off",
    contextTokens: null,
    contextWindow: 0,
    contextPercent: null,
  };
}

export function emptyGitInfoState(): GitInfoState {
  return {
    branch: null,
    changedFiles: 0,
    pullRequest: null,
  };
}
