import { type AssistantMessage } from '@earendil-works/pi-ai'
import { type MessageEndEvent } from '@earendil-works/pi-coding-agent'

const RETRY_PREFIX = 'server error: '
// SDKs often throw before after_provider_response, retaining the HTTP status only in their error text.
const HTTP_ERROR = /^(?:Error:\s*)?(?:HTTP\s+)?(?<status>[345]\d{2})(?=[:\s]|$)|^(?:Error:\s*)?[\w -]*API error \((?<prefixedStatus>[345]\d{2})\):/i

export const classifyProviderError = ({ message }: MessageEndEvent, responseStatus?: number): { message: AssistantMessage } | undefined => {
  if (message.role !== 'assistant' || message.stopReason !== 'error') {
    return undefined
  }
  const errorMessage = message.errorMessage ?? 'Unknown provider error'
  if (errorMessage.startsWith(RETRY_PREFIX)) {
    return undefined
  }

  const groups = HTTP_ERROR.exec(errorMessage.trim())?.groups
  const textStatus = groups === undefined ? undefined : Number(groups.status ?? groups.prefixedStatus)
  // A successful HTTP response can still fail mid-stream; it supplies no failure status.
  const status = responseStatus !== undefined && responseStatus >= 300 ? responseStatus : textStatus
  if (status !== undefined && (status < 500 || status >= 600)) {
    return undefined
  }

  // Preserve the diagnostic so Pi's native quota/overflow exclusions, retry budget, and cancellation still apply.
  return { message: { ...message, errorMessage: `${RETRY_PREFIX}${errorMessage}` } }
}
