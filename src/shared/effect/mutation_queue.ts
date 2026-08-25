import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { Cause, Effect, type Scope } from 'effect'

/**
 * Holds a file's Pi mutation-queue slot for the enclosing scope.
 *
 * Pi's queue is a promise API that takes the guarded work as a callback, which forces effectful
 * callers to re-enter the runtime and lose interruption and resource ownership. Acquiring the slot
 * as a resource instead keeps the guarded work on the calling fiber: the queue callback returns a
 * promise this scope resolves on release, so the queue stays held until the scope closes.
 */
export const mutationQueueSlot = (path: string): Effect.Effect<void, Cause.UnknownError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<() => void, Cause.UnknownError>((resume) => {
      let abandoned = false
      let release: (() => void) | undefined
      const held = withFileMutationQueue(
        path,
        () =>
          // oxlint-disable-next-line effecttsgo/new-promise -- permanent: the queue is held open by a promise only this scope resolves, which no Effect promise constructor expresses.
          new Promise<void>((resolveHeld) => {
            release = resolveHeld
            if (abandoned) {
              resolveHeld()
              return
            }
            resume(Effect.succeed(resolveHeld))
          })
      )
      // Rejects only when the queue never granted the slot, so the waiting fiber must be failed.
      void held.catch((error: unknown) => {
        if (release === undefined && !abandoned) {
          resume(Effect.fail(new Cause.UnknownError(error)))
        }
      })
      // Interruption while queued: release the slot as soon as the queue hands it over.
      return Effect.sync(() => {
        abandoned = true
        release?.()
      })
    }),
    (release) => Effect.sync(release),
    // Waiting for the queue must not outlive an interrupt: shutdown cannot block on an unrelated write.
    { interruptible: true }
  ).pipe(Effect.asVoid)
