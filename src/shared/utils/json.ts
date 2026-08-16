import { Schema } from 'effect'

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject {
  [key: string]: JsonValue | undefined
}

// Unlike `JSON.stringify`, these reject non-serializable values instead of returning `undefined`.
export const jsonText: (value: unknown) => string = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

export const prettyJsonText: (value: unknown) => string = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

export const parseJsonText: (text: string) => unknown = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
