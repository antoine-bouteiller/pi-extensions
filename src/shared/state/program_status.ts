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

/**
 * OSC 7501 `working` child records under one parent id. Once a run ends Pi's root record says `done`,
 * so these keep Rex showing the session as working while work the run started continues.
 * Ids come from a counter because caller ids can break the record id grammar.
 */
export const makeWorkingRecords = (parent: string, environment: EnvApi, write: StatusWriter) => {
  let next = 0
  const open = new Set<string>()
  return {
    /** Clearing the parent removes every child record, including ones whose owners have not ended them yet. */
    clearAll: () => {
      if (open.size > 0) {
        open.clear()
        write(`\u001B]7501;state=clear:id=${parent}\u001B\\`)
      }
    },
    end: (id: string | undefined) => {
      if (id !== undefined && open.delete(id)) {
        write(`\u001B]7501;state=clear:id=${id}\u001B\\`)
      }
    },
    start: (mode: string, message: string): string | undefined => {
      if (!programStatusEnabled(environment, mode)) {
        return undefined
      }
      const id = `${parent}/${++next}`
      open.add(id)
      write(`\u001B]7501;state=working:id=${id}:app=pi:msg=${encodeMessage(message)}\u001B\\`)
      return id
    },
  }
}

export type WorkingRecords = ReturnType<typeof makeWorkingRecords>
