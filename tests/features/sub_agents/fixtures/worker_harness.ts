import { type AgentSession, type AgentSessionEvent } from '@earendil-works/pi-coding-agent'

import { type SessionFactory } from '../../../../src/features/sub_agents/worker.js'
import { asNarrowed } from '../../../utils/casts.js'

interface PromptOptions {
  readonly preflightResult: (accepted: boolean) => void
}

export interface WorkerHarness {
  readonly factory: SessionFactory
  readonly aborts: () => number
  readonly disposed: () => number
  readonly emit: (event: AgentSessionEvent) => Promise<void>
  readonly prompt: () => string | undefined
  readonly promptStarted: () => Promise<void>
  readonly rejectSteer: (message: string) => void
  readonly releaseCreate: () => void
  readonly settle: (content: string, stopReason?: 'aborted' | 'error') => Promise<void>
  readonly start: () => Promise<void>
}

const event = (type: AgentSessionEvent['type']): AgentSessionEvent => asNarrowed<AgentSessionEvent, object>({ type })
const noop = (): void => undefined

export const workerHarness = (
  options: {
    readonly activeTools?: readonly string[]
    readonly contextTokens?: number | null
    readonly holdCreate?: boolean
    readonly model?: { readonly id: string; readonly provider: string }
  } = {}
): WorkerHarness => {
  let abortCount = 0
  let disposeCount = 0
  let listener: ((value: AgentSessionEvent) => void | Promise<void>) | undefined
  let prompted: string | undefined
  const promptStartedDeferred = Promise.withResolvers<void>()
  const promptStarted = promptStartedDeferred.promise
  let steerError: Error | undefined
  const activeTools = [...(options.activeTools ?? [])]
  const model = options.model ?? { id: 'fake', provider: 'fake' }
  const messages: unknown[] = []
  const sessionManager = asNarrowed<AgentSession['sessionManager'], object>({ getSessionFile: () => '/tmp/session.jsonl' })
  const session = asNarrowed<AgentSession, object>({
    abort: () => {
      abortCount += 1
      return Promise.resolve()
    },
    bindExtensions: () => Promise.resolve(),
    dispose: () => {
      disposeCount += 1
    },
    getActiveToolNames: () => activeTools,
    getContextUsage: () => ({ contextWindow: 200_000, percent: 0, tokens: options.contextTokens === undefined ? 100 : options.contextTokens }),
    messages,
    model,
    prompt: (message: string, value: PromptOptions) => {
      prompted = message
      value.preflightResult(true)
      promptStartedDeferred.resolve()
      return Promise.resolve()
    },
    sessionManager,
    setActiveToolsByName: () => undefined,
    steer: () => (steerError === undefined ? Promise.resolve() : Promise.reject(steerError)),
    subscribe: (value: (event: AgentSessionEvent) => void | Promise<void>) => {
      listener = value
      return noop
    },
  })
  const held = Promise.withResolvers<void>()
  const factory = asNarrowed<SessionFactory, object>({
    create: () => (options.holdCreate === true ? held.promise.then(() => ({ session })) : Promise.resolve({ session })),
    resourceLoader: class {
      reload(): Promise<void> {
        return Promise.resolve()
      }
    },
    runtime: { create: () => Promise.resolve({ getModel: () => model }) },
    sessionManager: { open: () => sessionManager },
    settings: { create: () => ({}) },
  })
  const emit = (value: AgentSessionEvent): Promise<void> => {
    if (listener === undefined) {
      return Promise.reject(new Error('Worker did not subscribe to session events.'))
    }
    return Promise.resolve(listener(value)).then(() => undefined)
  }
  return {
    aborts: () => abortCount,
    disposed: () => disposeCount,
    emit,
    factory,
    prompt: () => prompted,
    promptStarted: () => promptStarted,
    rejectSteer: (message) => {
      steerError = new Error(message)
    },
    releaseCreate: () => {
      held.resolve()
    },
    settle: (content, stopReason) => {
      messages.push({ content: [{ text: content, type: 'text' }], role: 'assistant', stopReason })
      return emit(event('agent_settled'))
    },
    start: () => emit(event('agent_start')),
  }
}
