import { Effect, FileSystem, Path } from 'effect'

import { makeCommentCheckerRunner, type CheckerRunner } from '#features/comment_checker/checker'
import { register as commentChecker } from '#features/comment_checker/index'
import { jsonText } from '#shared/utils/json'
import { promiseFromEffect, describe, expect, it } from '#tests/utils/effect'
import { createFakePi } from '#tests/utils/fake_pi'
import { runtime } from '#tests/utils/runtime'

const context = {
  cwd: '/workspace',
  sessionManager: { getSessionId: () => 'session-1' },
}
const checkerInput: Parameters<CheckerRunner>[0] = {
  cwd: '/workspace',
  hook_event_name: 'PostToolUse',
  session_id: 'session-1',
  tool_input: { content: 'const value = 1;', file_path: 'src/main.ts' },
  tool_name: 'Write',
  transcript_path: '',
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
  it.effect('runs the Effect child process with bounded output and JSON stdin', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'comment-checker-' })
      const executable = path.join(directory, 'comment-checker')
      yield* fs.writeFileString(
        executable,
        `#!/usr/bin/env node
let input = ''
for await (const chunk of process.stdin) input += chunk.toString()
if (input.includes('overflow')) process.stdout.write('x'.repeat(${64 * 1024 + 1}), () => process.exit(2))
else process.stdout.write(input, () => process.exit(2))
`,
        { mode: 0o700 }
      )

      const runner = makeCommentCheckerRunner(executable)
      expect(yield* Effect.promise(() => runner(checkerInput))).toEqual({ exitCode: 2, stderr: '', stdout: jsonText(checkerInput) })
      expect(
        yield* Effect.promise(() => runner({ ...checkerInput, tool_input: { content: 'overflow', file_path: checkerInput.tool_input.file_path } }))
      ).toEqual({ exitCode: undefined, stderr: '', stdout: '' })
    })
  )
})
