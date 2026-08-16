#!/usr/bin/env node

// oxlint-disable-next-line effecttsgo/node-builtin-import -- This standalone Node fixture must explicitly close its stdin descriptor.
import { closeSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { Effect } from 'effect'

import { nodeFileSystem } from '#shared/effect/node_services'
import { writeSubagentAzureQuota } from '#shared/state/azure_quota'
import { jsonText, parseJsonText } from '#shared/utils/json'
import { isRecord } from '#shared/utils/records'

const encode = (value) => new TextEncoder().encode(value)
const sessionIndex = process.argv.indexOf('--session')
const sessionFile = sessionIndex === -1 ? undefined : process.argv[sessionIndex + 1]
const getStateDelay = Number(process.env.PI_SUBAGENT_TEST_GET_STATE_DELAY_MS || 0)
const ownerToken = process.env.PI_SUBAGENT_OWNER_TOKEN || ''

/** @param {Record<string, unknown>} value */
const record = (value) => {
  if (sessionFile === undefined) {
    return Effect.void
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const file = yield* nodeFileSystem.open(sessionFile, { flag: 'a' })
      yield* file.writeAll(encode(`${jsonText({ pid: process.pid, ...value })}\n`))
      yield* file.sync
    })
  )
}

/** @param {unknown} value */
const send = (value) => {
  process.stdout.write(`${jsonText(value)}\n`)
}

const started = {
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
  runtime: 'node',
  type: 'started',
}
await Effect.runPromise(record(started))

/** @param {string} input */
const settle = (input) =>
  Effect.sync(() => {
    const failing = input.startsWith('fail')
    const response = input.startsWith('large') || input.startsWith('exit-after-output') ? 'x'.repeat(60 * 1024) : `response:${input}`
    const resultMessage = {
      content: [{ text: response, type: 'text' }],
      role: 'assistant',
      stopReason: failing ? 'error' : 'stop',
    }
    if (failing) {
      resultMessage.errorMessage = 'fake failure'
    }
    const messageEnd = { message: resultMessage, type: 'message_end' }
    if (input.startsWith('exit-after-output')) {
      process.stderr.write('final stderr before exit')
      process.stdout.write(`${jsonText(messageEnd)}\n${jsonText({ type: 'agent_settled' })}\n`, () => process.exit(0))
      return
    }
    if (input.startsWith('garbage')) {
      process.stdout.write('{ not json\n')
    }
    send(messageEnd)
    send({ type: 'agent_settled' })
  })

/** @param {string} message */
const reportQuota = (message) => (message.startsWith('quota') ? writeSubagentAzureQuota(ownerToken, 73) : Effect.void)

/**
 * `survive-stdin` outlives its own stdin, so the parent proves which signals it does and does not send.
 *
 * @param {string} message
 */
const staysAlive = (message) => {
  if (message.startsWith('survive-stdin')) {
    // oxlint-disable-next-line effecttsgo/global-timers -- A pending timer is what keeps the child running once stdin is gone.
    setInterval(() => undefined, 1000)
    return true
  }
  return message.startsWith('hold')
}

const promptMessage = (value) => (typeof value === 'string' ? value : '')

/** @param {string} line */
const handle = (line) =>
  Effect.gen(function* () {
    const parsed = parseJsonText(line)
    if (!isRecord(parsed)) {
      return
    }
    const command = {
      id: typeof parsed.id === 'string' ? parsed.id : undefined,
      message: parsed.message,
      type: typeof parsed.type === 'string' ? parsed.type : undefined,
    }
    if (command.type === 'get_state') {
      if (getStateDelay > 0) {
        yield* Effect.sleep(getStateDelay)
      }
      send({ data: {}, id: command.id, success: true, type: 'response' })
      return
    }
    if (command.type === 'prompt') {
      const message = promptMessage(command.message)
      yield* record({ message: command.message, type: 'prompt' })
      if (message.startsWith('reject')) {
        send({ error: 'fake prompt rejection', id: command.id, success: false, type: 'response' })
        return
      }
      yield* reportQuota(message)
      send({ data: {}, id: command.id, success: true, type: 'response' })
      send({ type: 'agent_start' })
      if (message.startsWith('close-stdin')) {
        input.close()
        closeSync(0)
        process.stdin.destroy()
        // oxlint-disable-next-line effecttsgo/global-timers-in-effect -- The child must remain alive after closing stdin so the parent proves it terminates the process.
        setInterval(() => undefined, 1000)
        return
      }
      if (staysAlive(message)) {
        return
      }
      if (message.startsWith('crash')) {
        yield* Effect.sleep(20)
        process.exit(23)
      }
      if (!message.startsWith('immediate')) {
        yield* Effect.sleep(message.startsWith('slow') ? 200 : 50)
      }
      yield* settle(message)
      return
    }
    if (command.type === 'steer' || command.type === 'abort') {
      send({ data: {}, id: command.id, success: true, type: 'response' })
    }
  })

const input = createInterface({ input: process.stdin })
let commands = Promise.resolve()
input.on('line', (line) => {
  commands = commands.then(() => Effect.runPromise(handle(line)))
})
