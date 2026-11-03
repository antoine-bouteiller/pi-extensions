import { type EnvApi } from '#shared/effect/env'
import { encodeMessage, programStatusEnabled, type StatusWriter } from '#shared/state/program_status'

const PARENT = 'background_poll'

/**
 * Reports each pending poll as an OSC 7501 `working` child record. The run that registered the poll has ended,
 * so Pi's root record says `done`; the child record keeps Rex showing the session as working until the poll wakes it.
 * Ids come from a counter because tool call ids can break the record id grammar.
 */
export const makePollProgramStatus = (environment: EnvApi, write: StatusWriter) => {
  let next = 0
  const open = new Set<string>()
  return {
    /** Clearing the parent removes every child record, even for polls whose fibers are still being interrupted. */
    clearAll: () => {
      if (open.size > 0) {
        open.clear()
        write(`\u001B]7501;state=clear:id=${PARENT}\u001B\\`)
      }
    },
    end: (id: string | undefined) => {
      if (id !== undefined && open.delete(id)) {
        write(`\u001B]7501;state=clear:id=${id}\u001B\\`)
      }
    },
    start: (mode: string, label: string): string | undefined => {
      if (!programStatusEnabled(environment, mode)) {
        return undefined
      }
      const id = `${PARENT}/${++next}`
      open.add(id)
      write(`\u001B]7501;state=working:id=${id}:app=pi:msg=${encodeMessage(label)}\u001B\\`)
      return id
    },
  }
}

export type PollProgramStatus = ReturnType<typeof makePollProgramStatus>
