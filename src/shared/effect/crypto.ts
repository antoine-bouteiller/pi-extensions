import { Effect } from 'effect'
import { Digest, sha256 } from 'effect/crypto/Digest'

const utf8 = new TextEncoder()

export const sha256Hex = (text: string): Effect.Effect<string, never, Digest> =>
  Digest.pipe(Effect.flatMap((digest) => digest.digestHex(sha256, utf8.encode(text))))
