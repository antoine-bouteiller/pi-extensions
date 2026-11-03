import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'

import { makeRootStatus } from '@/shared/state/program_status.js'

const report = (body: string) => `\u001B]7501;${body}\u001B\\`
const DONE = report('state=done:app=pi:msg=c2Vzc2lvbg==')
const WORKING = report('state=working:app=pi:msg=c2Vzc2lvbg==')

const setup = () => {
  const received: (string | Uint8Array)[] = []
  const stream = {
    write: (chunk: string | Uint8Array) => {
      received.push(chunk)
      return true
    },
  }
  const original = stream.write
  return { original, received, root: makeRootStatus(stream), stream }
}

describe('root program status', () => {
  it.effect('leaves the stream untouched until work is first held', () =>
    Effect.sync(() => {
      const fixture = setup()
      expect(fixture.stream.write).toBe(fixture.original)
      fixture.root.acquire()
      expect(fixture.stream.write).not.toBe(fixture.original)
    })
  )

  it.effect("reports Pi's resting root record as working while work is held, then restores it", () =>
    Effect.sync(() => {
      const fixture = setup()
      fixture.root.acquire()
      fixture.root.acquire()
      fixture.stream.write(`frame${DONE}frame`)
      fixture.stream.write(report('state=idle:app=pi'))
      expect(fixture.received).toEqual([`frame${WORKING}frame`, report('state=working:app=pi')])

      fixture.root.release()
      expect(fixture.received).toHaveLength(2)
      fixture.root.release()
      expect(fixture.received.at(-1)).toBe(report('state=idle:app=pi'))
    })
  )

  it.effect('passes through error, blocked, child records, queries, and binary chunks', () =>
    Effect.sync(() => {
      const fixture = setup()
      fixture.root.acquire()
      const chunks = [
        report('state=error:app=pi:msg=Ym9vbQ=='),
        report('state=blocked:kind=question:app=pi'),
        report('state=done:id=ask_user/1:app=pi'),
        report('?'),
        Buffer.from(DONE),
      ]
      for (const chunk of chunks) {
        fixture.stream.write(chunk)
      }
      expect(fixture.received).toEqual(chunks)
      fixture.root.release()
      expect(fixture.received).toHaveLength(chunks.length)
    })
  )

  it.effect('reports working at once when work starts after Pi already rested', () =>
    Effect.sync(() => {
      const fixture = setup()
      fixture.root.acquire()
      fixture.root.release()
      fixture.stream.write(DONE)
      fixture.root.acquire()
      expect(fixture.received).toEqual([DONE, WORKING])
      fixture.root.release()
      expect(fixture.received).toEqual([DONE, WORKING, DONE])
    })
  )
})
