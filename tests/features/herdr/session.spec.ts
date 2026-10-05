import { createAssistantMessageEventStream, type AssistantMessage, type Message } from '@earendil-works/pi-ai'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { deferred } from '@tests/utils/deferred.js'
import { Effect } from 'effect'
import { type Crypto } from 'effect/Crypto'
import { FileSystem } from 'effect/FileSystem'
import { Type } from 'typebox'

import { makeHerdrHandlers, RESULT_MESSAGE, SPAWN_ENTRY } from '@/features/herdr/herdr.js'
import { makeEnvironment } from '@/shared/effect/env.js'
import { jsonText } from '@/shared/utils/json.js'
import { join } from '@/shared/utils/path.js'

const PROVIDER = 'herdr-session-test'
const MODEL = 'parent'
const CHILD_RESULT = 'The delegated review found a missing authorization check.'

const messageText = (message: Message): string =>
  typeof message.content === 'string' ? message.content : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')

describe('Herdr session integration', () => {
  it.scoped('includes a result received while the parent is busy in its next request before its final answer', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem
      const services = yield* Effect.context<FileSystem | Crypto>()
      const run = Effect.runPromiseWith(services)
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'herdr-session-' })
      const agentDir = join(root, 'agent')
      yield* fs.makeDirectory(agentDir)
      const sessionManager = SessionManager.create(root, join(root, 'sessions'))
      const childSession = join(root, 'child.jsonl')
      const child = {
        agent: 'pi',
        agent_session: { agent: 'pi', kind: 'path', value: childSession },
        agent_status: 'idle',
        pane_id: 'w1:p2',
        tab_id: 'w1:t2',
        terminal_id: 'child-terminal',
        workspace_id: 'w1',
      }
      sessionManager.appendCustomEntry(SPAWN_ENTRY, {
        awaiting: true,
        model: `${PROVIDER}/${MODEL}`,
        owner: sessionManager.getSessionFile(),
        pane_id: child.pane_id,
        request_id: 'review-request',
        target: { pane_id: child.pane_id, session_file: childSession, terminal_id: child.terminal_id },
      })

      const requests: Message[][] = []
      const toolStarted = deferred<void>()
      const finishTool = deferred<void>()
      const poll = deferred<() => Promise<void>>()
      const modelRuntime = yield* Effect.promise(() =>
        ModelRuntime.create({
          authPath: join(agentDir, 'auth.json'),
          modelsPath: join(agentDir, 'models.json'),
          refreshOnCreate: false,
        })
      )
      modelRuntime.registerProvider(PROVIDER, {
        api: 'herdr-session-test',
        apiKey: 'test-key',
        baseUrl: 'https://unused.invalid',
        models: [
          {
            contextWindow: 8192,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
            id: MODEL,
            input: ['text'],
            maxTokens: 1024,
            name: MODEL,
            reasoning: false,
          },
        ],
        streamSimple: (model, context) => {
          requests.push([...context.messages])
          const first = requests.length === 1
          const response: AssistantMessage = {
            api: model.api,
            content: first
              ? [{ arguments: {}, id: 'parent-work', name: 'independent_work', type: 'toolCall' }]
              : [{ text: 'Parent final answer.', type: 'text' }],
            model: model.id,
            provider: model.provider,
            role: 'assistant',
            stopReason: first ? 'toolUse' : 'stop',
            timestamp: 0,
            usage: {
              cacheRead: 0,
              cacheWrite: 0,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
              input: 0,
              output: 0,
              totalTokens: 0,
            },
          }
          const stream = createAssistantMessageEventStream()
          stream.push({ partial: response, type: 'start' })
          stream.push({ message: response, reason: first ? 'toolUse' : 'stop', type: 'done' })
          stream.end()
          return stream
        },
      })
      const model = modelRuntime.getModel(PROVIDER, MODEL)
      if (model === undefined) {
        throw new Error('Controlled parent model was not loaded.')
      }
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
      const resourceLoader = new DefaultResourceLoader({
        agentDir,
        cwd: root,
        extensionFactories: [
          (pi) => {
            const handlers = makeHerdrHandlers(
              {
                ...pi,
                exec: (command, args) => {
                  if (command !== 'herdr' || args.join(' ') !== `pane get ${child.pane_id}`) {
                    throw new Error(`Unexpected CLI command: ${command} ${args.join(' ')}`)
                  }
                  return Promise.resolve({ code: 0, killed: false, stderr: '', stdout: jsonText({ result: { pane: child } }) })
                },
              },
              makeEnvironment({ HERDR_ENV: '1' })
            )
            // Restore the owned child, then stop the timer: this test explicitly drives one watcher pass.
            pi.on('session_start', (_event, ctx) =>
              run(Effect.scoped(handlers.activate(ctx))).then(() => {
                poll.resolve(() => run(handlers.poll(ctx)))
              })
            )
            pi.registerTool({
              description: 'Finish independent parent work.',
              execute: () => {
                toolStarted.resolve()
                return finishTool.promise.then(() => ({
                  content: [{ text: 'Independent work complete.', type: 'text' as const }],
                  details: undefined,
                }))
              },
              label: 'Independent work',
              name: 'independent_work',
              parameters: Type.Object({}),
            })
          },
        ],
        noContextFiles: true,
        noExtensions: true,
        noPromptTemplates: true,
        noSkills: true,
        noThemes: true,
        settingsManager,
        systemPromptOverride: () => 'Complete independent work, then give a final answer using the delegated review.',
      })
      yield* Effect.promise(() => resourceLoader.reload())
      const { session } = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createAgentSession({
            agentDir,
            cwd: root,
            model,
            modelRuntime,
            resourceLoader,
            sessionManager,
            settingsManager,
            thinkingLevel: 'off',
            tools: ['independent_work'],
          })
        ),
        ({ session: active }) =>
          Effect.promise(() => {
            finishTool.resolve()
            return active.abort().then(() => active.dispose())
          })
      )
      yield* Effect.promise(() => session.bindExtensions({ mode: 'print' }))
      const prompt = session.prompt('Review is delegated; continue independent work and then conclude.')
      yield* Effect.promise(() => toolStarted.promise)
      expect(session.isStreaming).toBe(true)
      const resultsDirectory = `${childSession}.exit.d`
      yield* fs.makeDirectory(resultsDirectory)
      yield* fs.writeFileString(
        join(resultsDirectory, '000000000001-review.json'),
        jsonText({ request_id: 'review-request', text: CHILD_RESULT, type: 'done' })
      )
      const pollOnce = yield* Effect.promise(() => poll.promise)
      yield* Effect.promise(pollOnce)
      finishTool.resolve()
      yield* Effect.promise(() => prompt)

      expect(requests[1]?.some((message) => message.role === 'user' && messageText(message).includes(CHILD_RESULT))).toBe(true)
      const resultIndex = session.messages.findIndex((message) => message.role === 'custom' && message.customType === RESULT_MESSAGE)
      const finalIndex = session.messages.findIndex((message) => message.role === 'assistant' && message.stopReason === 'stop')
      expect(resultIndex).toBeGreaterThanOrEqual(0)
      expect(resultIndex).toBeLessThan(finalIndex)
      expect(requests).toHaveLength(2)
    })
  )
})
