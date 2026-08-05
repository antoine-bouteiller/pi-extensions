import { type BeforeProviderHeadersEvent, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Effect, Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { makeEventHandler } from '@/shared/effect/runtime.js'
import { isEmptyString, isNullOrUndefined } from '@/shared/utils/predicates.js'

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

const isMeridianRequest = (event: BeforeProviderHeadersEvent, ctx: ExtensionContext): boolean => {
  if (hasHeader(event.headers, MERIDIAN_AGENT_HEADER)) {
    return true
  }

  const configuredBaseUrl = process.env.MERIDIAN_BASE_URL ?? DEFAULT_MERIDIAN_BASE_URL
  return normalizedUrl(ctx.model?.baseUrl) === normalizedUrl(configuredBaseUrl)
}

const setCanonicalHeader = (headers: BeforeProviderHeadersEvent['headers'], name: string, value: string): void => {
  for (const existingName of Object.keys(headers)) {
    if (existingName !== name && existingName.toLowerCase() === name) {
      delete headers[existingName]
    }
  }
  headers[name] = value
}

const applySessionAffinity = (event: BeforeProviderHeadersEvent, ctx: ExtensionContext): Effect.Effect<void> =>
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

export const register: {
  (runtime: AppRuntime): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime): void
} = Function.dual(
  (args) => typeof args[0].on === 'function',
  (pi: ExtensionAPI, runtime: AppRuntime): void => {
    pi.on('before_provider_headers', makeEventHandler(runtime)(applySessionAffinity))
  }
)
