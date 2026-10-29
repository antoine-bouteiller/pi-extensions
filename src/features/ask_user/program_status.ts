import { type EnvApi } from '#shared/effect/env'

export type StatusWriter = (sequence: string) => void

const CONTROL_CHARACTERS = /\p{Cc}+/gu
const MAX_MESSAGE_BYTES = 2048

/** Same sanitizing and byte limit as Pi's own OSC 7501 reports, so terminals do not discard the record. */
const encodeMessage = (text: string): string => {
  let message = text.replace(CONTROL_CHARACTERS, ' ').trim()
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
const enabled = (environment: EnvApi, mode: string): boolean => {
  if (mode !== 'tui') {
    return false
  }
  const override = environment.all.PI_PROGRAM_STATUS
  if (override !== undefined) {
    return override === '1'
  }
  return environment.all.TERM_PROGRAM === 'rex' && environment.all.TMUX === undefined && environment.all.HERDR_ENV !== '1'
}

/**
 * Reports each open question as its own OSC 7501 child record. Pi owns the root record and every report
 * replaces its record completely, so a child record is the only way to add `blocked` without clobbering Pi.
 */
export const makeQuestionStatus = (environment: EnvApi, write: StatusWriter) => {
  let next = 0
  return {
    close: (id: string | undefined) => {
      if (id !== undefined) {
        write(`\u001B]7501;state=clear:id=${id}\u001B\\`)
      }
    },
    open: (mode: string, question: string): string | undefined => {
      if (!enabled(environment, mode)) {
        return undefined
      }
      const id = `ask_user/${++next}`
      write(`\u001B]7501;state=blocked:id=${id}:kind=question:app=pi:msg=${encodeMessage(question)}\u001B\\`)
      return id
    },
  }
}

export type QuestionStatus = ReturnType<typeof makeQuestionStatus>
