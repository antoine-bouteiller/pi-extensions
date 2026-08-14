/*
 * A minimal quote-aware shell lexer. It exists so the pattern scanner can tell a command word
 * from prose sitting in an argument, and so a compound command can be inspected segment by
 * segment instead of as one flat string.
 *
 * ponytail: single-pass lexer with no expansion, heredoc, or subshell modelling; swap in a real
 * shell parser if guard decisions ever need to follow substitutions.
 */

interface Token {
  readonly start: number
  readonly end: number
  readonly text: string
}

interface Segment {
  readonly text: string
  readonly tokens: readonly Token[]
}

const OPERATOR_CHARS = new Set([';', '&', '|', '\n', '\r', '(', ')'])
const PROSE_FLAGS = new Set(['-am', '-b', '-m', '--body', '--description', '--message', '--title'])
const PROSE_ASSIGNMENT = /^--(?:body|description|message|title)=/

const lexCommand = (command: string): Segment[] => {
  const segments: Segment[] = []
  let tokens: Token[] = []
  let tokenStart = -1
  let tokenText = ''
  let segmentStart = 0
  let index = 0

  const endToken = (): void => {
    if (tokenStart !== -1) {
      tokens.push({ end: index, start: tokenStart, text: tokenText })
      tokenStart = -1
      tokenText = ''
    }
  }

  const endSegment = (end: number): void => {
    endToken()
    if (tokens.length > 0) {
      segments.push({ text: command.slice(segmentStart, end), tokens })
      tokens = []
    }
  }

  while (index < command.length) {
    const char = command[index] ?? ''
    if (char === '\\' && index + 1 < command.length) {
      tokenStart = tokenStart === -1 ? index : tokenStart
      tokenText += command[index + 1]
      index += 2
      continue
    }
    if (char === "'" || char === '"') {
      const close = command.indexOf(char, index + 1)
      const end = close === -1 ? command.length : close
      tokenStart = tokenStart === -1 ? index : tokenStart
      tokenText += command.slice(index + 1, end)
      index = end + 1
      continue
    }
    if (char === ' ' || char === '\t') {
      endToken()
      index += 1
      continue
    }
    if (OPERATOR_CHARS.has(char)) {
      endSegment(index)
      index += 1
      segmentStart = index
      continue
    }
    tokenStart = tokenStart === -1 ? index : tokenStart
    tokenText += char
    index += 1
  }
  endSegment(command.length)
  return segments
}

export const commandSegments = (command: string): string[] => lexCommand(command).map((segment) => segment.text)

/**
 * Blanks out message-style argument values so a commit message, PR body, or title cannot trip a
 * pattern that is looking for a real command. Line structure is preserved for excerpt reporting.
 */
export const maskProse = (command: string): string => {
  const hidden: [number, number][] = []
  for (const segment of lexCommand(command)) {
    for (const [index, token] of segment.tokens.entries()) {
      const assignment = PROSE_ASSIGNMENT.exec(token.text)
      if (assignment !== null) {
        hidden.push([token.start + assignment[0].length, token.end])
        continue
      }
      if (PROSE_FLAGS.has(segment.tokens[index - 1]?.text ?? '')) {
        hidden.push([token.start, token.end])
      }
    }
  }

  let masked = ''
  let cursor = 0
  for (const [start, end] of hidden) {
    masked += command.slice(cursor, start) + command.slice(start, end).replaceAll(/[^\r\n]/g, 'x')
    cursor = end
  }
  return masked + command.slice(cursor)
}
