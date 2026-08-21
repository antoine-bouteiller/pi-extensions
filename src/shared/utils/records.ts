import { type JsonObject } from '#shared/utils/json'

export const isRecord = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null
