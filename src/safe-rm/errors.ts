import { Schema } from 'effect'

export class InvalidPathError extends Schema.TaggedErrorClass<InvalidPathError>()('InvalidPathError', {
  message: Schema.String,
}) {}

export class GitMetadataError extends Schema.TaggedErrorClass<GitMetadataError>()('GitMetadataError', {
  message: Schema.String,
}) {}

export class GitRepositoryError extends Schema.TaggedErrorClass<GitRepositoryError>()('GitRepositoryError', {
  message: Schema.String,
}) {}

export class OutsideAllowedRootError extends Schema.TaggedErrorClass<OutsideAllowedRootError>()('OutsideAllowedRootError', {
  message: Schema.String,
}) {}

export class SymlinkEscapeError extends Schema.TaggedErrorClass<SymlinkEscapeError>()('SymlinkEscapeError', {
  message: Schema.String,
}) {}

export class RecursiveRequiredError extends Schema.TaggedErrorClass<RecursiveRequiredError>()('RecursiveRequiredError', {
  message: Schema.String,
}) {}

export class TargetChangedError extends Schema.TaggedErrorClass<TargetChangedError>()('TargetChangedError', {
  message: Schema.String,
}) {}

export class OverlappingTargetsError extends Schema.TaggedErrorClass<OverlappingTargetsError>()('OverlappingTargetsError', {
  message: Schema.String,
}) {}

export class CancelledError extends Schema.TaggedErrorClass<CancelledError>()('CancelledError', {
  message: Schema.String,
}) {}
