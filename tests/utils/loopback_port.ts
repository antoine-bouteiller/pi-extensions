import { BunHttpServer } from '@effect/platform-bun'
import { Effect } from 'effect'

export const freeLoopbackPort: Effect.Effect<number> = Effect.scoped(
  Effect.gen(function* () {
    const server = yield* BunHttpServer.make({ hostname: '127.0.0.1', port: 0 })
    if (server.address._tag !== 'TcpAddress') {
      return yield* Effect.die(new Error('missing address'))
    }
    return server.address.port
  })
)
