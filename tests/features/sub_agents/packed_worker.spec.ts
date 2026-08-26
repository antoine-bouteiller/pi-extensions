import { describe, expect, it } from '@tests/utils/bun_effect.js'

import { startFakeProvider } from './fixtures/fake_provider.js'

const frame = (value: unknown): string => `${JSON.stringify(value)}\n`
const strictFrames = (stdout: string): readonly unknown[] =>
  stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
const typeOf = (value: unknown): string | undefined => {
  const type = typeof value === 'object' && value !== null ? Reflect.get(value, 'type') : undefined
  return typeof type === 'string' ? type : undefined
}
const run = (command: readonly string[], cwd: string): void => {
  const result = Bun.spawnSync([...command], { cwd, stderr: 'pipe', stdout: 'pipe' })
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
}
const temporaryDirectory = (): string => {
  const result = Bun.spawnSync(['mktemp', '-d', '/tmp/sub-agent-packed-XXXXXX'], { stderr: 'pipe', stdout: 'pipe' })
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
  return new TextDecoder().decode(result.stdout).trim()
}

describe('packed sub-agent worker', () => {
  it('runs the unpacked worker from outside the repository against the loopback provider', () => {
    const temporary = temporaryDirectory()
    const repository = new URL('../../../', import.meta.url).pathname
    const packed = `${temporary}/packed`
    const outside = `${temporary}/outside`
    run(['mkdir', '-p', packed, outside], temporary)
    run(['npm', 'pack', '--pack-destination', packed], repository)
    const [archive] = [...new Bun.Glob('*.tgz').scanSync({ cwd: packed })]
    if (archive === undefined) {
      throw new Error('npm pack did not create an archive.')
    }
    run(['tar', '-xzf', `${packed}/${archive}`, '-C', packed], temporary)
    const unpacked = `${packed}/package`
    run(['ln', '-s', `${repository}node_modules`, `${unpacked}/node_modules`], temporary)
    const agentDir = `${temporary}/agent`
    const runDir = `${temporary}/run`
    const sessions = `${temporary}/sessions`
    run(['mkdir', '-p', agentDir], temporary)
    const provider = startFakeProvider('packed deterministic conclusion')
    return Bun.write(
      `${agentDir}/models.json`,
      JSON.stringify({
        providers: {
          fake: {
            api: 'openai-completions',
            apiKey: 'test-key',
            baseUrl: `${provider.url}/v1`,
            models: [{ contextWindow: 8192, id: 'fake-model', maxTokens: 1024 }],
          },
        },
      })
    )
      .then(() => {
        const config = {
          agent_id: 'agent',
          run_dir: runDir,
          session: { expected_dir: sessions, mode: 'create' as const },
          turn: 1,
          type: 'config' as const,
          version: 1 as const,
          worker: {
            agentDir,
            contextCeiling: 100,
            cwd: outside,
            memoryPolicy: { inMemory: 'fixed' as const, persistence: 'session_file_only' as const },
            model: 'fake-model',
            projectTrusted: true,
            prompt: 'exact prompt',
            provider: 'fake',
            resourcePolicy: {
              configuredExtensions: true as const,
              contextFiles: false as const,
              promptTemplates: false as const,
              skills: false as const,
            },
            tools: [],
            version: 1 as const,
          },
        }
        const task = { agent_id: 'agent', command_id: 'task-command', message: 'say hello', turn: 1, type: 'task' as const }
        const child = Bun.spawn([process.execPath, `${unpacked}/src/features/sub_agents/worker.ts`], {
          cwd: outside,
          env: { ...process.env, PI_OFFLINE: '1' },
          stderr: 'pipe',
          stdin: 'pipe',
          stdout: 'pipe',
        })
        void child.stdin.write(frame(config))
        void child.stdin.write(frame(task))
        void child.stdin.flush()
        return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      })
      .then(([stdout, stderr, exitCode]) => {
        expect(exitCode, stderr).toBe(0)
        const frames = strictFrames(stdout)
        const ready = frames.findIndex((candidate) => typeOf(candidate) === 'ready')
        const result = frames.findIndex((candidate) => typeOf(candidate) === 'result')
        expect(ready, stdout).toBeGreaterThanOrEqual(0)
        expect(result).toBeGreaterThan(ready)
        expect(frames[result]).toEqual({
          agent_id: 'agent',
          command_id: 'task-command',
          conclusion: 'packed deterministic conclusion',
          context_tokens: 11,
          status: 'completed',
          turn: 1,
          type: 'result',
        })
      })
      .finally(() => {
        provider.close()
        run(['rm', '-rf', temporary], '/tmp')
      })
  }, 30_000)
})
