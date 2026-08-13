import { StringDecoder } from 'node:string_decoder'

import { isEmptyString } from '@/shared/utils/predicates.js'

export class RpcJsonlDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const lines: string[] = []
    while (true) {
      const index = this.buffer.indexOf('\n')
      if (index === -1) {
        break
      }
      let line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      lines.push(line)
    }
    return lines
  }

  end(): string[] {
    this.buffer += this.decoder.end()
    if (isEmptyString(this.buffer)) {
      return []
    }
    const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer
    this.buffer = ''
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
