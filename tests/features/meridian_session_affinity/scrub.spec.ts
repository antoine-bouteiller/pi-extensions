import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'

import { scrubPiFingerprints } from '@/features/meridian_session_affinity/scrub.js'

const PI_IDENTITY =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n'

const PI_DOCS = `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /home/user/pi-coding-agent/README.md
- Additional docs: /home/user/pi-coding-agent/docs`

const PROMPT = `${PI_IDENTITY}
Available tools:
- read: Read files

Here is some useful information about the environment you are running in:
<env>
Working directory: /duplicate
</env>

${PI_DOCS}

<project_context>
Follow the house style.
</project_context>

Current date: 7/10/2026
Current working directory: /repo`

const MINIMAL_PROMPT = `${PI_IDENTITY}
Available tools:
- read: Read files

${PI_DOCS}
Current working directory: /repo`

describe('scrubPiFingerprints', () => {
  it.effect('removes Pi fingerprints while preserving useful prompt content', () =>
    Effect.sync(() => {
      const scrubbed = scrubPiFingerprints(PROMPT)

      expect(scrubbed).toStartWith('You are an expert coding assistant.')
      expect(scrubbed).not.toContain('operating inside pi')
      expect(scrubbed).not.toContain('Pi documentation')
      expect(scrubbed).not.toContain('/duplicate')
      expect(scrubbed).toContain('Available tools:')
      expect(scrubbed).toContain('<project_context>')
      expect(scrubbed).toContain('Follow the house style.')
      expect(scrubbed).toContain('Current working directory: /repo')
    })
  )

  it.effect('preserves the working directory when it immediately follows Pi documentation', () =>
    Effect.sync(() => {
      const scrubbed = scrubPiFingerprints(MINIMAL_PROMPT)

      expect(scrubbed).not.toContain('Pi documentation')
      expect(scrubbed).toContain('Current working directory: /repo')
    })
  )

  it.effect('is idempotent and leaves prompts without Pi fingerprints unchanged', () =>
    Effect.sync(() => {
      const cleanPrompt = "You are Claude Code, Anthropic's official CLI for Claude.\n\nDo things well.\n"
      const quotedDocs = 'Explain this text:\nPi documentation (read only when quoted)\nKeep it intact.\n'
      const scrubbed = scrubPiFingerprints(PROMPT)

      expect(scrubPiFingerprints('')).toBe('')
      expect(scrubPiFingerprints(cleanPrompt)).toBe(cleanPrompt)
      expect(scrubPiFingerprints(quotedDocs)).toBe(quotedDocs)
      expect(scrubPiFingerprints(scrubbed)).toBe(scrubbed)
    })
  )
})
