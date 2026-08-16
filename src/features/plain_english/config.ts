import { Option } from 'effect'

const DEFAULT_MIN_CHARS = 200
const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_MD_TIMEOUT_MS = 150_000

export interface PlainEnglishConfig {
  readonly model: Option.Option<{ provider: string; modelId: string }>
  readonly minChars: number
  readonly timeoutMs: number
  readonly mdTimeoutMs: number
}

const positiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const modelFrom = (value: string | undefined): Option.Option<{ provider: string; modelId: string }> => {
  if (value === undefined) {
    return Option.none()
  }
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) {
    return Option.none()
  }
  return Option.some({ modelId: value.slice(separator + 1), provider: value.slice(0, separator) })
}

export const loadConfig = (environment: Readonly<Record<string, string | undefined>> = process.env): PlainEnglishConfig => ({
  mdTimeoutMs: positiveNumber(environment.PI_PLAIN_ENGLISH_MD_TIMEOUT_MS, DEFAULT_MD_TIMEOUT_MS),
  minChars: positiveNumber(environment.PI_PLAIN_ENGLISH_MIN_CHARS, DEFAULT_MIN_CHARS),
  model: modelFrom(environment.PI_PLAIN_ENGLISH_MODEL),
  timeoutMs: positiveNumber(environment.PI_PLAIN_ENGLISH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
})

export const makeToggle = () => {
  let enabled = true
  return {
    get: () => enabled,
    set: (next: boolean) => {
      enabled = next
    },
  }
}

export const proseLength = (text: string): number => text.replaceAll(/```[\s\S]*?```/g, '').length
