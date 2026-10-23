import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

export type ThinkingLevel = ReturnType<ExtensionAPI['getThinkingLevel']>

export interface ModelInfoState {
  modelId: string
  thinking: ThinkingLevel
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

export const emptyModelInfoState = (): ModelInfoState => ({
  cacheHitPercent: undefined,
  contextPercent: undefined,
  contextTokens: undefined,
  contextWindow: 0,
  modelId: 'no-model',
  thinking: 'off',
  tokensPerSecond: undefined,
})
