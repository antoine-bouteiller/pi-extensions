import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Deferred, Effect, Fiber } from 'effect'

import { mutationQueueSlot } from '@/shared/effect/mutation_queue.js'

const path = '/tmp/pi-extensions-mutation-queue-probe'

describe('mutationQueueSlot', () => {
  it.live('serializes holders of the same path and runs the guarded work on the calling fiber', () =>
    Effect.gen(function* () {
      const order: string[] = []
      const hold = (name: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* mutationQueueSlot(path)
            order.push(`${name}:enter`)
            yield* Effect.yieldNow
            order.push(`${name}:exit`)
          })
        )

      yield* Effect.all([hold('first'), hold('second')], { concurrency: 'unbounded' })

      expect(order).toEqual(['first:enter', 'first:exit', 'second:enter', 'second:exit'])
    })
  )

  it.live('releases a slot abandoned by interruption instead of holding the queue forever', () =>
    Effect.gen(function* () {
      const holding = yield* Deferred.make<void>()
      const releaseHolder = yield* Deferred.make<void>()
      const holder = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            yield* mutationQueueSlot(path)
            yield* Deferred.succeed(holding, undefined)
            yield* Deferred.await(releaseHolder)
          })
        )
      )
      yield* Deferred.await(holding)

      const queued = yield* Effect.forkChild(Effect.scoped(mutationQueueSlot(path)))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(queued)

      yield* Deferred.succeed(releaseHolder, undefined)
      yield* Fiber.join(holder)

      // Hangs forever if the interrupted waiter leaked the queue slot.
      yield* Effect.scoped(mutationQueueSlot(path)).pipe(Effect.timeoutOrElse({ duration: 2000, orElse: () => Effect.fail('queue slot leaked') }))
    })
  )
})
