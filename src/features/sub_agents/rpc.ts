import { StringDecoder } from 'node:string_decoder'

import { Data } from 'effect'

import { isEmptyString } from '#shared/utils/predicates'

/**
 * A child must not be able to grow the parent's heap without bound, whether it never terminates a
 * line or terminates an arbitrarily long one. Every frame is measured, not just the pending tail.
 */
export const MAX_RPC_FRAME_CHARS = 16 * 1024 * 1024

class RpcFrameTooLargeError extends Data.TaggedError('RpcFrameTooLargeError')<{ readonly message: string }> {}

const withoutTrailingCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line)

const frameTooLarge = (): never => {
  throw new RpcFrameTooLargeError({ message: `Child Pi process sent an RPC frame over the ${MAX_RPC_FRAME_CHARS}-character limit.` })
}

export class RpcJsonlDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''

  /** Splits in one pass: repeated `slice` off the head is quadratic when a child emits many lines. */
  push(chunk: Buffer | string): string[] {
    const parts = (this.buffer + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk))).split('\n')
    this.buffer = parts.pop() ?? ''
    /*
     * A terminated frame is bounded exactly like the pending tail: splitting first would otherwise
     * let a child hand `JSON.parse` a gigabyte simply by appending a newline.
     */
    if (this.buffer.length > MAX_RPC_FRAME_CHARS || parts.some((part) => part.length > MAX_RPC_FRAME_CHARS)) {
      this.buffer = ''
      return frameTooLarge()
    }
    return parts.map(withoutTrailingCr)
  }

  end(): string[] {
    this.buffer += this.decoder.end()
    if (isEmptyString(this.buffer)) {
      return []
    }
    const line = withoutTrailingCr(this.buffer)
    this.buffer = ''
    if (line.length > MAX_RPC_FRAME_CHARS) {
      return frameTooLarge()
    }
    return [line]
  }
}

interface MailboxEvent {
  parentSessionId: string
  agentName: string
}

const consumeFirstMatchingMailboxEvent = <TEvent extends MailboxEvent>(
  events: TEvent[],
  parentSessionId: string,
  targets?: Set<string>
): TEvent | undefined => {
  const index = events.findIndex((event) => event.parentSessionId === parentSessionId && (targets === undefined || targets.has(event.agentName)))
  if (index === -1) {
    return undefined
  }
  return events.splice(index, 1)[0]
}

export { consumeFirstMatchingMailboxEvent }
