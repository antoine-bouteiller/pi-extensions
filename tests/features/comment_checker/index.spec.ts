import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect, FileSystem, Path } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { makeCommentCheckerRunner, type CheckerRunner } from '@/features/comment_checker/checker.js'
import { feature } from '@/features/comment_checker/index.js'
import { jsonText } from '@/shared/utils/json.js'

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

const preparedFeature = (runner: CheckerRunner, executable = '/tools/comment-checker') =>
  feature({ dependencies: { makeRunner: (path) => (expect(path).toBe(executable), runner), which: () => executable } }).prepare

describe('comment checker', () => {
  it('retains the ChildProcessSpawner requirement when dependencies omit makeRunner', () => {
    const { prepare } = feature({ dependencies: { which: () => '/tools/comment-checker' } })

    type Requirements = typeof prepare extends Effect.Effect<unknown, unknown, infer Value> ? Value : never
    type IsExactMatch<Left, Right> = [Left, Right] extends [Right, Left] ? true : false
    type Assert<Condition extends true> = Condition
    const requiredEnvironment: Assert<IsExactMatch<Requirements, Path.Path | ChildProcessSpawner>> = true

    expect(prepare).toBeDefined()
    expect(requiredEnvironment).toBe(true)
  })

  it.effect('prepares an implementation using the resolved absolute executable', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const implementation = yield* preparedFeature(() => Effect.succeed({ exitCode: 0, stderr: '', stdout: '' }), '/opt/bin/comment-checker')

      implementation.register(fixture.pi, runtime)

      expect(fixture.state.handlers.get('tool_result')).toHaveLength(1)
    })
  )

  it.effect('fails safely for missing or relative executable resolution without registering callbacks', () =>
    Effect.gen(function* () {
      for (const resolved of [undefined, 'comment-checker', './comment-checker']) {
        const fixture = createFakePi()
        let runnerCreated = 0
        const error = yield* Effect.flip(
          feature({
            dependencies: {
              makeRunner: () => {
                runnerCreated += 1
                return () => Effect.succeed({ exitCode: 0, stderr: '', stdout: '' })
              },
              which: () => resolved,
            },
          }).prepare
        )

        expect(error).toEqual({ _tag: 'CommentCheckerUnavailable' })
        expect(fixture.state.handlers.get('tool_result')).toBeUndefined()
        expect(runnerCreated).toBe(0)
      }
    })
  )

  it.effect('does not invoke a checker process when preflight fails', () =>
    Effect.gen(function* () {
      let processCalls = 0
      const error = yield* Effect.flip(
        feature({
          dependencies: {
            makeRunner: () => () => {
              processCalls += 1
              return Effect.succeed({ exitCode: 0, stderr: '', stdout: '' })
            },
            which: () => undefined,
          },
        }).prepare
      )

      expect(error).toEqual({ _tag: 'CommentCheckerUnavailable' })
      expect(processCalls).toBe(0)
    })
  )

  it.effect('preserves callback filtering, JSON input, and warning augmentation after preparation', () =>
    Effect.gen(function* () {
      const inputs: Parameters<CheckerRunner>[0][] = []
      const fixture = createFakePi()
      const implementation = yield* preparedFeature((input) =>
        Effect.sync(() => {
          inputs.push(input)
          return { exitCode: 2, stderr: 'remove this comment', stdout: '' }
        })
      )
      implementation.register(fixture.pi, runtime)

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
          tool_input: { content: '// redundant\nconst value = 1;\n', file_path: 'src/main.ts' },
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

  it.effect('converts Pi edit batches to MultiEdit input and ignores unrelated results', () =>
    Effect.gen(function* () {
      const inputs: Parameters<CheckerRunner>[0][] = []
      const fixture = createFakePi()
      const implementation = yield* preparedFeature((input) =>
        Effect.sync(() => {
          inputs.push(input)
          return { exitCode: 0, stderr: '', stdout: '' }
        })
      )
      implementation.register(fixture.pi, runtime)

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
      yield* Effect.promise(() =>
        fixture.emit(
          'tool_result',
          { content: [], input: { content: 'const value = 1;', path: 'src/main.ts' }, isError: true, toolName: 'write' },
          context
        )
      )
      yield* Effect.promise(() =>
        fixture.emit('tool_result', { content: [], input: { path: 'src/main.ts' }, isError: false, toolName: 'read' }, context)
      )

      expect(inputs[0]?.tool_input).toEqual({
        edits: [
          { new_string: 'const first = 1;', old_string: 'const one = 1;' },
          { new_string: 'const second = 2;', old_string: 'const two = 2;' },
        ],
        file_path: 'src/main.ts',
      })
      expect(result).toBeUndefined()
      expect(inputs).toHaveLength(1)
    })
  )

  it.scoped('checks hashline multi-file writes and move destinations, skips deletions, and appends all warnings', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: 'comment-checker-hashline-' })
      const ctx = { ...context, cwd }
      const inputs: Parameters<CheckerRunner>[0][] = []
      const fixture = createFakePi()
      const implementation = yield* preparedFeature((input) =>
        Effect.sync(() => {
          inputs.push(input)
          return { exitCode: 2, stderr: `warning: ${input.tool_input.file_path}`, stdout: '' }
        })
      )
      implementation.register(fixture.pi, runtime)
      yield* fs.writeFileString(path.join(cwd, 'updated.ts'), '// updated\n')
      yield* fs.writeFileString(path.join(cwd, 'renamed.ts'), '// original\n')
      const input = { patch: '[updated.ts#ABCD]\nPUT 1.=1:\n+// updated\n[source.ts#ABCD]\nMV renamed.ts\n[deleted.ts#ABCD]\nREM' }
      const output = {
        content: [{ text: 'update updated.ts\nupdate renamed.ts\ndelete deleted.ts', type: 'text' }],
        details: {
          sections: [
            { op: 'update', path: 'updated.ts' },
            { moveDest: 'renamed.ts', op: 'update', path: 'renamed.ts', sourcePath: 'source.ts' },
            { op: 'delete', path: 'deleted.ts' },
          ],
        },
      }
      const [result] = yield* Effect.promise(() => fixture.emit('tool_result', { ...output, input, isError: false, toolName: 'write' }, ctx))

      expect(inputs.map(({ tool_input, tool_name }) => ({ tool_input, tool_name }))).toEqual([
        { tool_input: { content: '// updated\n', file_path: 'updated.ts' }, tool_name: 'Write' },
        { tool_input: { content: '// original\n', file_path: 'renamed.ts' }, tool_name: 'Write' },
      ])
      expect(inputs.every((hook) => hook.cwd === cwd && hook.session_id === 'session-1')).toBe(true)
      expect(result).toEqual({
        content: [...output.content, { text: '\n\nwarning: updated.ts', type: 'text' }, { text: '\n\nwarning: renamed.ts', type: 'text' }],
      })
    })
  )

  it.scoped('ignores failed or malformed hashline results and skips unavailable, protected, and unchanged files', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: 'comment-checker-filter-' })
      yield* fs.writeFileString(path.join(cwd, 'valid.ts'), '// comment\n')
      yield* fs.writeFileString(path.join(cwd, '.env'), 'SECRET=value')
      yield* fs.symlink(path.join(cwd, '.env'), path.join(cwd, 'alias.ts'))
      const inputs: Parameters<CheckerRunner>[0][] = []
      const fixture = createFakePi()
      const implementation = yield* preparedFeature((input) =>
        Effect.sync(() => {
          inputs.push(input)
          return { exitCode: 0, stderr: '', stdout: '' }
        })
      )
      implementation.register(fixture.pi, runtime)
      const event = { content: [], input: { patch: 'patch' }, isError: false, toolName: 'write' }
      for (const overrides of [
        { details: { sections: [{ op: 'update', path: 'valid.ts' }] }, isError: true },
        { details: { sections: [{ op: 'update', path: 'valid.ts' }] }, toolName: 'read' },
        { details: {} },
        { details: { sections: 'invalid' } },
        {
          details: {
            sections: [
              null,
              { op: 'update', path: 123 },
              { op: 'unknown', path: 'valid.ts' },
              { op: 'noop', path: 'valid.ts' },
              { op: 'delete', path: 'valid.ts' },
              { op: 'update', path: 'missing.ts' },
              { op: 'update', path: '.env' },
              { op: 'update', path: 'alias.ts' },
              { op: 'create', path: 'valid.ts' },
            ],
          },
        },
      ]) {
        const [result] = yield* Effect.promise(() => fixture.emit('tool_result', { ...event, ...overrides }, { ...context, cwd }))
        expect(result).toBeUndefined()
      }
      expect(inputs.map((input) => input.tool_input)).toEqual([{ content: '// comment\n', file_path: 'valid.ts' }])
    })
  )

  it.scoped('runs the Effect child process with bounded output and JSON stdin', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'comment-checker-' })
      const executable = path.join(directory, 'comment-checker')
      yield* fs.writeFileString(
        executable,
        `#!/usr/bin/env bun
let input = ''
for await (const chunk of Bun.stdin.stream()) input += new TextDecoder().decode(chunk)
if (input.includes('overflow')) process.stdout.write('x'.repeat(${64 * 1024 + 1}))
else process.stdout.write(input)
process.exit(2)
`,
        { mode: 0o700 }
      )

      const spawner = runtime.runSync(ChildProcessSpawner)
      const runner = makeCommentCheckerRunner(executable, (command) => spawner.spawn(command))
      expect(yield* runner(checkerInput)).toEqual({
        exitCode: 2,
        stderr: '',
        stdout: jsonText(checkerInput),
      })
      expect(yield* runner({ ...checkerInput, tool_input: { content: 'overflow', file_path: checkerInput.tool_input.file_path } })).toEqual({
        exitCode: undefined,
        stderr: '',
        stdout: '',
      })
    })
  )
})
