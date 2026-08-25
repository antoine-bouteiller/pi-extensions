import { Data } from 'effect'
import { type Static } from 'typebox'
import { Value } from 'typebox/value'

import {
  ParentConfigFrameSchema,
  ParentInterruptFrameSchema,
  ParentSteerFrameSchema,
  ParentTaskFrameSchema,
  type ChildCommandErrorFrameSchema,
  type ChildProgressFrameSchema,
  type ChildReadyFrameSchema,
  type ChildResultFrameSchema,
  type ChildSteerAckFrameSchema,
} from './model.js'

export {
  ChildCommandErrorFrameSchema,
  ChildProgressFrameSchema,
  ChildReadyFrameSchema,
  ChildResultFrameSchema,
  ChildSteerAckFrameSchema,
} from './model.js'

export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_INLINE_BYTES = 50 * 1024
export const MAX_INLINE_LINES = 2000
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024

export type ParentConfigFrame = Static<typeof ParentConfigFrameSchema>
type ParentTaskFrame = Static<typeof ParentTaskFrameSchema>
export type ParentSteerFrame = Static<typeof ParentSteerFrameSchema>
type ParentInterruptFrame = Static<typeof ParentInterruptFrameSchema>
export type ParentFrame = ParentConfigFrame | ParentInterruptFrame | ParentSteerFrame | ParentTaskFrame
export type ChildFrame =
  | Static<typeof ChildCommandErrorFrameSchema>
  | Static<typeof ChildProgressFrameSchema>
  | Static<typeof ChildReadyFrameSchema>
  | Static<typeof ChildResultFrameSchema>
  | Static<typeof ChildSteerAckFrameSchema>
export type ChildResultFrame = Static<typeof ChildResultFrameSchema>

export class ProtocolError extends Data.TaggedError('ProtocolError')<{ readonly message: string }> {
  constructor(message: string) {
    super({ message })
  }
}

const bytes = new TextEncoder()
const text = new TextDecoder('utf-8', { fatal: true })

export const encodeFrame = (frame: unknown): string => {
  const line = `${JSON.stringify(frame)}\n`
  if (bytes.encode(line).byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError('Frame exceeds the 1 MiB limit.')
  }
  return line
}

export const parseParentFrame = (line: Uint8Array): ParentFrame => {
  if (line.byteLength === 0 || line.byteLength > MAX_FRAME_BYTES || line.at(-1) !== 10 || line.includes(13)) {
    throw new ProtocolError('Frames must be non-empty strict-LF JSONL within 1 MiB.')
  }
  let value: unknown
  try {
    value = JSON.parse(text.decode(line.subarray(0, -1)))
  } catch {
    throw new ProtocolError('Frame is not valid UTF-8 JSON.')
  }
  if (
    !Value.Check(ParentConfigFrameSchema, value) &&
    !Value.Check(ParentInterruptFrameSchema, value) &&
    !Value.Check(ParentSteerFrameSchema, value) &&
    !Value.Check(ParentTaskFrameSchema, value)
  ) {
    throw new ProtocolError('Frame does not match the closed parent protocol schema.')
  }
  return value
}

export class JsonlDecoder {
  #parts: Uint8Array[] = []
  #size = 0

  push(chunk: Uint8Array): ParentFrame[] {
    const frames: ParentFrame[] = []
    let start = 0
    for (let index = 0; index < chunk.byteLength; index += 1) {
      this.#size += 1
      if (this.#size > MAX_FRAME_BYTES) {
        throw new ProtocolError('Frame exceeds the 1 MiB limit.')
      }
      if (chunk[index] !== 10) {
        continue
      }
      this.#parts.push(chunk.slice(start, index + 1))
      const line = new Uint8Array(this.#size)
      let offset = 0
      for (const part of this.#parts) {
        line.set(part, offset)
        offset += part.byteLength
      }
      frames.push(parseParentFrame(line))
      this.#parts = []
      this.#size = 0
      start = index + 1
    }
    if (start < chunk.byteLength) {
      this.#parts.push(chunk.slice(start))
    }
    return frames
  }

  end(): void {
    if (this.#size > 0) {
      throw new ProtocolError('Parent stdin ended with an unterminated frame.')
    }
  }
}

export const isInlineConclusion = (value: string): boolean =>
  bytes.encode(value).byteLength <= MAX_INLINE_BYTES && value.split('\n').length <= MAX_INLINE_LINES
