import { createServer } from 'node:net'

import { Effect } from 'effect'

export const freeLoopbackPort: Effect.Effect<number> = Effect.callback((resume) => {
  const server = createServer()
  let settled = false

  const settle = (result: Effect.Effect<number>) => {
    if (settled) {
      return
    }
    settled = true
    server.off('error', onError)
    server.close((error) => resume(error === undefined ? result : Effect.die(error)))
  }

  const onError = (error: Error) => settle(Effect.die(error))

  server.once('error', onError)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      settle(Effect.die(new Error('missing address')))
      return
    }
    settle(Effect.succeed(address.port))
  })
})
