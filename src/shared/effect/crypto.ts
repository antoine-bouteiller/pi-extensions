import { Effect, Encoding } from 'effect'
import { Crypto } from 'effect/Crypto'

const utf8 = new TextEncoder()

/** Digesting a fixed algorithm over in-memory bytes cannot fail, so the platform error is a defect. */
export const sha256Hex = (text: string): Effect.Effect<string, never, Crypto> =>
  Crypto.pipe(
    Effect.flatMap((crypto) => crypto.digest('SHA-256', utf8.encode(text))),
    Effect.map(Encoding.encodeHex),
    Effect.orDie
  )
