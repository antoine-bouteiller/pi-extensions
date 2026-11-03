import { type EnvApi } from '#shared/effect/env'
import { encodeMessage, programStatusEnabled, type StatusWriter } from '#shared/state/program_status'

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
      if (!programStatusEnabled(environment, mode)) {
        return undefined
      }
      const id = `ask_user/${++next}`
      write(`\u001B]7501;state=blocked:id=${id}:kind=question:app=pi:msg=${encodeMessage(question)}\u001B\\`)
      return id
    },
  }
}

export type QuestionStatus = ReturnType<typeof makeQuestionStatus>
