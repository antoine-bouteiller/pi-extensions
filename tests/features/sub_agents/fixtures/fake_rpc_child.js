#!/usr/bin/env node
// oxlint-disable effecttsgo/node-builtin-import effecttsgo/global-timers effecttsgo/new-promise effecttsgo/async-function -- This standalone Node fixture runs without Effect at all.

/*
 * Deliberately dependency-free: this fixture is spawned once per child-process test, so it runs on
 * plain Node without jiti or any `#shared` import, which each cost hundreds of milliseconds per
 * spawn. The quota handoff below therefore restates the producer side of
 * `src/shared/state/azure_quota.ts`; the parent still consumes it with the production reader, so a
 * format change fails the quota test loudly.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const sessionIndex = process.argv.indexOf('--session')
const sessionFile = sessionIndex === -1 ? undefined : process.argv[sessionIndex + 1]
const getStateDelay = Number(process.env.PI_SUBAGENT_TEST_GET_STATE_DELAY_MS || 0)
const ownerToken = process.env.PI_SUBAGENT_OWNER_TOKEN || ''

/** @param {number} ms */
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** @param {Record<string, unknown>} value */
const record = (value) => {
  if (sessionFile === undefined) {
    return
  }
  const descriptor = openSync(sessionFile, 'a')
  try {
    writeSync(descriptor, `${JSON.stringify({ pid: process.pid, ...value })}\n`)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

/** @param {unknown} value */
const send = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
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
record(started)

/** @param {string} input */
const settle = (input) => {
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
    process.stdout.write(`${JSON.stringify(messageEnd)}\n${JSON.stringify({ type: 'agent_settled' })}\n`, () => process.exit(0))
    return
  }
  if (input.startsWith('garbage')) {
    process.stdout.write('{ not json\n')
  }
  send(messageEnd)
  send({ type: 'agent_settled' })
}

/** @param {string} message */
const reportQuota = (message) => {
  if (!message.startsWith('quota') || !TOKEN_PATTERN.test(ownerToken)) {
    return
  }
  const directory = join(process.env.PI_SUBAGENT_TEMP_DIR || tmpdir(), 'pi-codex-subagents', userInfo().username, 'quota')
  const target = join(directory, `${ownerToken}.json`)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(directory, { mode: 0o700, recursive: true })
    writeFileSync(temporary, JSON.stringify(73), { mode: 0o600 })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

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

/**
 * @param {string} message
 * @param {string | undefined} id
 */
const handlePrompt = async (message, id) => {
  if (message.startsWith('reject')) {
    send({ error: 'fake prompt rejection', id, success: false, type: 'response' })
    return
  }
  reportQuota(message)
  send({ data: {}, id, success: true, type: 'response' })
  send({ type: 'agent_start' })
  if (message.startsWith('close-stdin')) {
    input.close()
    closeSync(0)
    process.stdin.destroy()
    // oxlint-disable-next-line effecttsgo/global-timers -- The child must remain alive after closing stdin so the parent proves it terminates the process.
    setInterval(() => undefined, 1000)
    return
  }
  if (staysAlive(message)) {
    return
  }
  if (message.startsWith('crash')) {
    await sleep(20)
    process.exit(23)
  }
  if (!message.startsWith('immediate')) {
    await sleep(message.startsWith('slow') ? 200 : 50)
  }
  settle(message)
}

/** @param {string} line */
const handle = async (line) => {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return
  }
  const command = {
    id: typeof parsed.id === 'string' ? parsed.id : undefined,
    message: parsed.message,
    type: typeof parsed.type === 'string' ? parsed.type : undefined,
  }
  if (command.type === 'get_state') {
    if (getStateDelay > 0) {
      await sleep(getStateDelay)
    }
    send({ data: {}, id: command.id, success: true, type: 'response' })
    return
  }
  if (command.type === 'prompt') {
    const message = promptMessage(command.message)
    record({ message: command.message, type: 'prompt' })
    await handlePrompt(message, command.id)
    return
  }
  if (command.type === 'steer' || command.type === 'abort') {
    send({ data: {}, id: command.id, success: true, type: 'response' })
  }
}

const input = createInterface({ input: process.stdin })
let commands = Promise.resolve()
input.on('line', (line) => {
  commands = commands.then(() => handle(line))
})
