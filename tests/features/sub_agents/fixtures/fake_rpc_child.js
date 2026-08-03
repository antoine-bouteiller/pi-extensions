#!/usr/bin/env node

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const sessionIndex = process.argv.indexOf('--session')
const sessionFile = sessionIndex === -1 ? undefined : process.argv[sessionIndex + 1]

const record = (value) => {
  if (sessionFile) {
    appendFileSync(sessionFile, `${JSON.stringify({ pid: process.pid, ...value })}\n`)
  }
}

const send = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

record({
  args: process.argv.slice(2),
  env: Object.fromEntries(
    [
      'PI_SESSION_ID',
      'PI_SESSION_FILE',
      'PI_PROVIDER',
      'PI_MODEL',
      'PI_REASONING_LEVEL',
      'PI_SUBAGENT_OWNER_TOKEN',
      'PI_SUBAGENT_PROFILE',
      'PI_SUBAGENT_READONLY',
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))
  ),
  type: 'started',
})
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    const delay = Number(process.env.PI_SUBAGENT_TEST_GET_STATE_DELAY_MS || 0)
    if (delay > 0) {
      setTimeout(() => send({ data: {}, id: command.id, success: true, type: 'response' }), delay)
    } else {
      send({ data: {}, id: command.id, success: true, type: 'response' })
    }
    return
  }
  if (command.type === 'prompt') {
    record({ message: command.message, type: 'prompt' })
    if (String(command.message).startsWith('reject')) {
      send({ error: 'fake prompt rejection', id: command.id, success: false, type: 'response' })
      return
    }
    send({ data: {}, id: command.id, success: true, type: 'response' })
    send({ type: 'agent_start' })
    if (String(command.message).startsWith('hold')) {
      return
    }
    if (String(command.message).startsWith('crash')) {
      setTimeout(() => process.exit(23), 20)
      return
    }
    const message = String(command.message)
    setTimeout(
      () => {
        const failing = message.startsWith('fail')
        const response = message.startsWith('large') ? 'x'.repeat(60 * 1024) : `response:${message}`
        send({
          message: {
            content: [{ text: response, type: 'text' }],
            role: 'assistant',
            stopReason: failing ? 'error' : 'stop',
            ...(failing ? { errorMessage: 'fake failure' } : {}),
          },
          type: 'message_end',
        })
        send({ type: 'agent_settled' })
      },
      message.startsWith('slow') ? 200 : 50
    )
    return
  }
  if (command.type === 'steer' || command.type === 'abort') {
    send({ data: {}, id: command.id, success: true, type: 'response' })
  }
})
