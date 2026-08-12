import { Schema } from 'effect'

export class InvalidPathError extends Schema.TaggedError<InvalidPathError>()('InvalidPathError', {
  message: Schema.String,
}) {}

export class GitMetadataError extends Schema.TaggedError<GitMetadataError>()('GitMetadataError', {
  message: Schema.String,
}) {}

export class GitRepositoryError extends Schema.TaggedError<GitRepositoryError>()('GitRepositoryError', {
  message: Schema.String,
}) {}

export class OutsideAllowedRootError extends Schema.TaggedError<OutsideAllowedRootError>()('OutsideAllowedRootError', {
  message: Schema.String,
}) {}

export class SymlinkEscapeError extends Schema.TaggedError<SymlinkEscapeError>()('SymlinkEscapeError', {
  message: Schema.String,
}) {}

export class RecursiveRequiredError extends Schema.TaggedError<RecursiveRequiredError>()('RecursiveRequiredError', {
  message: Schema.String,
}) {}

export class TargetChangedError extends Schema.TaggedError<TargetChangedError>()('TargetChangedError', {
  message: Schema.String,
}) {}

export class OverlappingTargetsError extends Schema.TaggedError<OverlappingTargetsError>()('OverlappingTargetsError', {
  message: Schema.String,
}) {}

export class CancelledError extends Schema.TaggedError<CancelledError>()('CancelledError', {
  message: Schema.String,
}) {}
