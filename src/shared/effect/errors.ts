import { Cause, Schema } from 'effect'

/** Wrap an unknown thrown value as `Cause.UnknownError`, keeping one that already is. */
export const unknownError = (cause: unknown): Cause.UnknownError =>
  Cause.isUnknownError(cause) ? cause : new Cause.UnknownError(cause, cause instanceof Error ? cause.message : String(cause))

export class ToolFailure extends Schema.TaggedError<ToolFailure>()('ToolFailure', {
  cause: Schema.optional(Schema.Unknown),
  message: Schema.String,
}) {}
