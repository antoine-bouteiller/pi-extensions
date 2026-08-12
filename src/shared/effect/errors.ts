import { Schema } from 'effect'

export class ToolFailure extends Schema.TaggedError<ToolFailure>()('ToolFailure', {
  cause: Schema.optional(Schema.Unknown),
  message: Schema.String,
}) {}
