import { Result, Schema } from 'effect'

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject {
  [key: string]: JsonValue | undefined
}

// Unlike `JSON.stringify`, these reject non-serializable values instead of returning `undefined`.
const JsonTextSchema = Schema.fromJsonString(Schema.Unknown)

export const jsonText = (value: unknown): string => Result.getOrThrow(Schema.encodeUnknownResult(JsonTextSchema)(value))

export const parseJsonText = (text: string): unknown => Result.getOrThrow(Schema.decodeResult(JsonTextSchema)(text))
