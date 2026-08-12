import { describe, expect, test } from 'bun:test'

import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'

import { type CheckerRunner } from '@/features/comment_checker/checker.js'
import { register as commentChecker } from '@/features/comment_checker/index.js'

const context = {
  cwd: '/workspace',
  sessionManager: { getSessionId: () => 'session-1' },
}

describe('comment checker', () => {
  test('appends checker warnings after writes', async () => {
    const inputs: Parameters<CheckerRunner>[0][] = []
    const fixture = createFakePi()
    commentChecker(fixture.pi, runtime, async (input) => {
      inputs.push(input)
      return { exitCode: 2, stderr: 'remove this comment', stdout: '' }
    })

    const [result] = await fixture.emit(
      'tool_result',
      {
        content: [{ text: 'Wrote src/main.ts', type: 'text' }],
        input: { content: '// redundant\nconst value = 1;\n', path: 'src/main.ts' },
        isError: false,
        toolName: 'write',
      },
      context
    )

    expect(inputs).toEqual([
      {
        cwd: '/workspace',
        hook_event_name: 'PostToolUse',
        session_id: 'session-1',
        tool_input: {
          content: '// redundant\nconst value = 1;\n',
          file_path: 'src/main.ts',
        },
        tool_name: 'Write',
        transcript_path: '',
      },
    ])
    expect(result).toEqual({
      content: [
        { text: 'Wrote src/main.ts', type: 'text' },
        { text: '\n\nremove this comment', type: 'text' },
      ],
    })
  })

  test('converts Pi edit batches to MultiEdit input', async () => {
    const inputs: Parameters<CheckerRunner>[0][] = []
    const fixture = createFakePi()
    commentChecker(fixture.pi, runtime, async (input) => {
      inputs.push(input)
      return { exitCode: 0, stderr: '', stdout: '' }
    })

    const [result] = await fixture.emit(
      'tool_result',
      {
        content: [{ text: 'Edited src/main.ts', type: 'text' }],
        input: {
          edits: [
            { newText: 'const first = 1;', oldText: 'const one = 1;' },
            { newText: 'const second = 2;', oldText: 'const two = 2;' },
          ],
          path: 'src/main.ts',
        },
        isError: false,
        toolName: 'edit',
      },
      context
    )

    expect(inputs[0]?.tool_input).toEqual({
      edits: [
        { new_string: 'const first = 1;', old_string: 'const one = 1;' },
        { new_string: 'const second = 2;', old_string: 'const two = 2;' },
      ],
      file_path: 'src/main.ts',
    })
    expect(result).toBeUndefined()
  })

  test('silently ignores a missing comment-checker binary', async () => {
    const fixture = createFakePi()
    commentChecker(fixture.pi, runtime, async () => ({ exitCode: undefined, stderr: '', stdout: '' }))

    const [result] = await fixture.emit(
      'tool_result',
      {
        content: [{ text: 'Wrote src/main.ts', type: 'text' }],
        input: { content: 'const value = 1;\n', path: 'src/main.ts' },
        isError: false,
        toolName: 'write',
      },
      context
    )

    expect(result).toBeUndefined()
  })

  test('ignores failed and unrelated tool results', async () => {
    let calls = 0
    const fixture = createFakePi()
    commentChecker(fixture.pi, runtime, async () => {
      calls += 1
      return { exitCode: 0, stderr: '', stdout: '' }
    })

    await fixture.emit(
      'tool_result',
      {
        content: [],
        input: { content: 'const value = 1;', path: 'src/main.ts' },
        isError: true,
        toolName: 'write',
      },
      context
    )
    await fixture.emit('tool_result', { content: [], input: { path: 'src/main.ts' }, isError: false, toolName: 'read' }, context)

    expect(calls).toBe(0)
  })
})
