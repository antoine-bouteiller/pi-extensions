import { type BeforeAgentStartEvent, type BeforeProviderHeadersEvent, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { isEmptyString, isNullOrUndefined } from '#shared/utils/predicates'

import { scrubPiFingerprints } from './scrub.js'

const DEFAULT_MERIDIAN_BASE_URL = 'http://127.0.0.1:3456'
const MERIDIAN_AGENT_HEADER = 'x-meridian-agent'
const SESSION_AFFINITY_HEADER = 'x-session-affinity'

const normalizedUrl = (value: string | undefined): string | undefined => {
  if (isNullOrUndefined(value) || isEmptyString(value)) {
    return undefined
  }

  try {
    const url = new URL(value)
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/$/, '')
  } catch {
    return value.replace(/\/+$/, '')
  }
}

const hasHeader = (headers: BeforeProviderHeadersEvent['headers'], expectedName: string): boolean =>
  Object.entries(headers).some(([name, value]) => name.toLowerCase() === expectedName && typeof value === 'string')

const isMeridianModel = (ctx: ExtensionContext): boolean => {
  if (!isNullOrUndefined(ctx.model) && hasHeader(ctx.model.headers ?? {}, MERIDIAN_AGENT_HEADER)) {
    return true
  }

  const configuredBaseUrl = process.env.MERIDIAN_BASE_URL ?? DEFAULT_MERIDIAN_BASE_URL
  return normalizedUrl(ctx.model?.baseUrl) === normalizedUrl(configuredBaseUrl)
}

const isMeridianRequest = (event: BeforeProviderHeadersEvent, ctx: ExtensionContext): boolean =>
  hasHeader(event.headers, MERIDIAN_AGENT_HEADER) || isMeridianModel(ctx)

const setCanonicalHeader = (headers: BeforeProviderHeadersEvent['headers'], name: string, value: string): void => {
  for (const existingName of Object.keys(headers)) {
    if (existingName !== name && existingName.toLowerCase() === name) {
      delete headers[existingName]
    }
  }
  headers[name] = value
}

export const applySessionAffinity = (event: BeforeProviderHeadersEvent, ctx: ExtensionContext): Effect.Effect<void> =>
  Effect.sync(() => {
    if (!isMeridianRequest(event, ctx)) {
      return
    }

    const sessionId = ctx.sessionManager.getSessionId()
    if (isNullOrUndefined(sessionId) || isEmptyString(sessionId)) {
      return
    }

    setCanonicalHeader(event.headers, SESSION_AFFINITY_HEADER, sessionId)
  })

export interface ScrubRequest {
  readonly ctx: ExtensionContext
  readonly event: BeforeAgentStartEvent
}

export const scrubbedSystemPrompt = ({ ctx, event }: ScrubRequest): { systemPrompt: string } | undefined => {
  if (!isMeridianModel(ctx)) {
    return undefined
  }

  const systemPrompt = scrubPiFingerprints(event.systemPrompt)
  return systemPrompt === event.systemPrompt ? undefined : { systemPrompt }
}
