import { Schema } from 'effect'

export class ToolFailure extends Schema.TaggedErrorClass<ToolFailure>()('ToolFailure', {
  cause: Schema.optional(Schema.Unknown),
  message: Schema.String,
}) {}
