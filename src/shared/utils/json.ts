import { Schema } from 'effect'

// Unlike `JSON.stringify`, these reject non-serializable values instead of returning `undefined`.
export const jsonText: (value: unknown) => string = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

export const prettyJsonText: (value: unknown) => string = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
