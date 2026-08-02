import { type BeforeProviderHeadersEvent, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'

const DEFAULT_MERIDIAN_BASE_URL = 'http://127.0.0.1:3456'
const MERIDIAN_AGENT_HEADER = 'x-meridian-agent'
const SESSION_AFFINITY_HEADER = 'x-session-affinity'

const normalizedUrl = (value: string | undefined): string | undefined => {
  if (!value) {
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

export const createMeridianSessionAffinityExtension = (pi: ExtensionAPI): void => {
  pi.on('before_provider_headers', (event, ctx) => {
    if (!isMeridianRequest(event, ctx)) {
      return
    }

    const sessionId = ctx.sessionManager.getSessionId()
    if (!sessionId) {
      return
    }

    setCanonicalHeader(event.headers, SESSION_AFFINITY_HEADER, sessionId)
  })
}

export default createMeridianSessionAffinityExtension
