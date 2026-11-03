import { type EnvApi } from '#shared/effect/env'

export type StatusWriter = (sequence: string) => void

export const writeStdout: StatusWriter = (sequence) => {
  process.stdout.write(sequence)
}

const CONTROL_CHARACTERS = /\p{Cc}+/gu
const MAX_MESSAGE_BYTES = 2048

/** Same sanitizing and byte limit as Pi's own OSC 7501 reports, so terminals do not discard the record. */
export const encodeMessage = (text: string): string => {
  let message = text.replaceAll(CONTROL_CHARACTERS, ' ').trim()
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
    let bytes = 0
    let end = 0
    for (const character of message) {
      const size = Buffer.byteLength(character, 'utf8')
      if (bytes + size > MAX_MESSAGE_BYTES) {
        break
      }
      bytes += size
      end += character.length
    }
    message = message.slice(0, end)
  }
  return Buffer.from(message, 'utf8').toString('base64')
}

/* Pi's support detection is private and the terminal's reply is unreadable from an extension, so this reuses Pi's override variable. */
export const programStatusEnabled = (environment: EnvApi, mode: string): boolean => {
  if (mode !== 'tui') {
    return false
  }
  const override = environment.all.PI_PROGRAM_STATUS
  if (override !== undefined) {
    return override === '1'
  }
  return environment.all.TERM_PROGRAM === 'rex' && environment.all.TMUX === undefined
}

interface TextStream {
  // Method syntax keeps the parameters bivariant, so `process.stdout`'s overloaded `write` fits.
  // oxlint-disable-next-line typescript/method-signature-style
  write(chunk: string | Uint8Array, ...rest: unknown[]): boolean
}

interface RootStatus {
  readonly acquire: () => void
  readonly release: () => void
}

const REPORT_PREFIX = '\u001B]7501;'
const RESTING_STATES = new Set(['state=done', 'state=idle'])

const isResting = (body: string) => body.split(':').some((pair) => RESTING_STATES.has(pair))
const asWorking = (body: string) =>
  body
    .split(':')
    .map((pair) => (RESTING_STATES.has(pair) ? 'state=working' : pair))
    .join(':')
const report = (body: string) => `${REPORT_PREFIX}${body}\u001B\\`

/**
 * Pi owns the root OSC 7501 record and reports `done` or `idle` when its run ends, which hides work the run
 * left behind. While any work is held, Pi's resting root reports are rewritten to `working` on their way to
 * the terminal; releasing the last hold writes Pi's latest root report back unchanged. The wrapper stays
 * installed once added, because removing it would drop any wrapper installed after it.
 *
 * @internal
 */
export const makeRootStatus = (stream: TextStream): RootStatus => {
  let original: TextStream['write'] | undefined
  let held = 0
  let lastRoot: string | undefined
  let rewritten = false

  const rewriteBody = (body: string) => {
    if (body.startsWith('?') || body.split(':').some((pair) => pair.startsWith('id='))) {
      return body
    }
    lastRoot = body
    rewritten = held > 0 && isResting(body)
    return rewritten ? asWorking(body) : body
  }

  const rewrite = (chunk: string) => {
    let start = chunk.indexOf(REPORT_PREFIX)
    let output = ''
    let copied = 0
    while (start !== -1) {
      const bodyStart = start + REPORT_PREFIX.length
      const ends = [chunk.indexOf('\u0007', bodyStart), chunk.indexOf('\u001B', bodyStart)].filter((index) => index !== -1)
      if (ends.length === 0) {
        break
      }
      const end = Math.min(...ends)
      output += chunk.slice(copied, bodyStart) + rewriteBody(chunk.slice(bodyStart, end))
      copied = end
      start = chunk.indexOf(REPORT_PREFIX, end)
    }
    return copied === 0 ? chunk : output + chunk.slice(copied)
  }

  const install = () => {
    const write = stream.write.bind(stream)
    original = write
    stream.write = (chunk, ...rest) => write(typeof chunk === 'string' ? rewrite(chunk) : chunk, ...rest)
    return write
  }

  return {
    acquire: () => {
      const write = original ?? install()
      held++
      if (held === 1 && lastRoot !== undefined && isResting(lastRoot)) {
        rewritten = true
        write(report(asWorking(lastRoot)))
      }
    },
    release: () => {
      if (held === 0) {
        return
      }
      held--
      if (held === 0 && rewritten && lastRoot !== undefined && original !== undefined) {
        rewritten = false
        original(report(lastRoot))
      }
    },
  }
}

export interface StatusOutput {
  readonly root: RootStatus
  readonly write: StatusWriter
}

export const stdoutOutput: StatusOutput = { root: makeRootStatus(process.stdout), write: writeStdout }

/**
 * OSC 7501 `working` child records under one parent id, each holding the root record at `working`. The child
 * records name the work; the hold keeps Rex showing the session as working after Pi's run ends.
 * Ids come from a counter because caller ids can break the record id grammar.
 */
export const makeWorkingRecords = (parent: string, environment: EnvApi, output: StatusOutput) => {
  let next = 0
  const open = new Set<string>()
  return {
    /** Clearing the parent removes every child record, including ones whose owners have not ended them yet. */
    clearAll: () => {
      if (open.size > 0) {
        const count = open.size
        open.clear()
        output.write(`\u001B]7501;state=clear:id=${parent}\u001B\\`)
        for (let index = 0; index < count; index++) {
          output.root.release()
        }
      }
    },
    end: (id: string | undefined) => {
      if (id !== undefined && open.delete(id)) {
        output.write(`\u001B]7501;state=clear:id=${id}\u001B\\`)
        output.root.release()
      }
    },
    start: (mode: string, message: string): string | undefined => {
      if (!programStatusEnabled(environment, mode)) {
        return undefined
      }
      const id = `${parent}/${++next}`
      open.add(id)
      output.write(`\u001B]7501;state=working:id=${id}:app=pi:msg=${encodeMessage(message)}\u001B\\`)
      output.root.acquire()
      return id
    },
  }
}

export type WorkingRecords = ReturnType<typeof makeWorkingRecords>
