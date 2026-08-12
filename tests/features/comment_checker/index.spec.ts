import { promiseFromEffect, describe, expect, it } from '@tests/utils/bun_effect.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect } from 'effect'

import { type CheckerRunner } from '@/features/comment_checker/checker.js'
import { register as commentChecker } from '@/features/comment_checker/index.js'

const context = {
  cwd: '/workspace',
  sessionManager: { getSessionId: () => 'session-1' },
}

describe('comment checker', () => {
  it.effect('appends checker warnings after writes', () =>
    Effect.gen(function* () {
      const inputs: Parameters<CheckerRunner>[0][] = []
      const fixture = createFakePi()
      commentChecker(fixture.pi, runtime, (input) =>
        promiseFromEffect(
          Effect.sync(() => {
            inputs.push(input)
            return { exitCode: 2, stderr: 'remove this comment', stdout: '' }
          })
        )
      )

      const [result] = yield* Effect.promise(() =>
        fixture.emit(
          'tool_result',
          {
            content: [{ text: 'Wrote src/main.ts', type: 'text' }],
            input: { content: '// redundant\nconst value = 1;\n', path: 'src/main.ts' },
            isError: false,
            toolName: 'write',
          },
          context
        )
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
  )

  it.effect('converts Pi edit batches to MultiEdit input', () =>
    Effect.gen(function* () {
      const inputs: Parameters<CheckerRunner>[0][] = []
      const fixture = createFakePi()
      commentChecker(fixture.pi, runtime, (input) =>
        promiseFromEffect(
          Effect.sync(() => {
            inputs.push(input)
            return { exitCode: 0, stderr: '', stdout: '' }
          })
        )
      )

      const [result] = yield* Effect.promise(() =>
        fixture.emit(
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
  )

  it.effect('silently ignores a missing comment-checker binary', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      commentChecker(fixture.pi, runtime, () => promiseFromEffect(Effect.succeed({ exitCode: undefined, stderr: '', stdout: '' })))

      const [result] = yield* Effect.promise(() =>
        fixture.emit(
          'tool_result',
          {
            content: [{ text: 'Wrote src/main.ts', type: 'text' }],
            input: { content: 'const value = 1;\n', path: 'src/main.ts' },
            isError: false,
            toolName: 'write',
          },
          context
        )
      )

      expect(result).toBeUndefined()
    })
  )

  it.effect('ignores failed and unrelated tool results', () =>
    Effect.gen(function* () {
      let calls = 0
      const fixture = createFakePi()
      commentChecker(fixture.pi, runtime, () =>
        promiseFromEffect(
          Effect.sync(() => {
            calls += 1
            return { exitCode: 0, stderr: '', stdout: '' }
          })
        )
      )

      yield* Effect.promise(() =>
        fixture.emit(
          'tool_result',
          {
            content: [],
            input: { content: 'const value = 1;', path: 'src/main.ts' },
            isError: true,
            toolName: 'write',
          },
          context
        )
      )
      yield* Effect.promise(() =>
        fixture.emit('tool_result', { content: [], input: { path: 'src/main.ts' }, isError: false, toolName: 'read' }, context)
      )

      expect(calls).toBe(0)
    })
  )
})
