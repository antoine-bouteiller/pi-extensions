import { BunHttpServer } from '@effect/platform-bun'
import { Effect } from 'effect'
import { NetAddress } from 'effect/unstable/net'

export const freeLoopbackPort: Effect.Effect<number> = Effect.scoped(
  Effect.gen(function* () {
    const server = yield* BunHttpServer.make({ hostname: '127.0.0.1', port: 0 }).pipe(Effect.orDie)
    if (!NetAddress.isInetAddress(server.address)) {
      return yield* Effect.die(new Error('missing address'))
    }
    return server.address.port
  })
)
