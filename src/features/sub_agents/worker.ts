import { dlopen } from 'bun:ffi'

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent'
import { Value } from 'typebox/value'

import { createPrivateSessionFilePromise, writePrivateUniqueFilePromise } from '#shared/effect/bun_host_file_system'
import { bunPath } from '#shared/effect/bun_services'

import {
  ChildCommandErrorFrameSchema,
  ChildProgressFrameSchema,
  ChildReadyFrameSchema,
  ChildResultFrameSchema,
  ChildSteerAckFrameSchema,
  type ChildFrame,
  type ChildResultFrame,
  type ParentConfigFrame,
  type ParentFrame,
  type ParentSteerFrame,
  JsonlDecoder,
  MAX_ARTIFACT_BYTES,
  MAX_INLINE_BYTES,
  MAX_INLINE_LINES,
  ProtocolError,
  encodeFrame,
  isInlineConclusion,
} from './protocol.js'

type WorkerState = 'awaiting_config' | 'awaiting_task' | 'starting' | 'running' | 'settled' | 'exiting'
export interface Output {
  readonly write: (value: string) => void | Promise<void>
}

export interface SessionFactory {
  readonly create: typeof createAgentSession
  readonly resourceLoader: typeof DefaultResourceLoader
  readonly runtime: typeof ModelRuntime
  readonly sessionManager: typeof SessionManager
  readonly settings: typeof SettingsManager
}

const sdk: SessionFactory = {
  create: createAgentSession,
  resourceLoader: DefaultResourceLoader,
  runtime: ModelRuntime,
  sessionManager: SessionManager,
  settings: SettingsManager,
}

interface Deferred {
  readonly promise: Promise<void>
  readonly reject: (error: Error) => void
  readonly resolve: () => void
}
const deferred = (): Deferred => {
  const result = Promise.withResolvers<void>()
  return { promise: result.promise, reject: result.reject, resolve: result.resolve }
}
const utf8 = new TextEncoder()
// Ponytail: Cap pending progress writes at 64; upgrade to byte accounting if progress frames grow beyond fixed metadata.
const MAX_PENDING_PROGRESS_WRITES = 64
/** Keeps terminal result frames encodable: an unbounded SDK error message would exceed the 1 MiB frame limit. */
const MAX_ERROR_MESSAGE_CHARS = 4096
const diagnostic = (message: string): void => {
  process.stderr.write(`[sub-agent worker] ${message}\n`)
}
const failed = (
  agent_id: string,
  command_id: string,
  turn: number,
  code: 'agent_failed' | 'result_too_large',
  message: string
): ChildResultFrame => ({
  agent_id,
  command_id,
  error: { code, message },
  status: 'failed',
  turn,
  type: 'result',
})
const interrupted = (agent_id: string, command_id: string, turn: number): ChildResultFrame => ({
  agent_id,
  command_id,
  error: { code: 'interrupted', message: 'The sub-agent was interrupted.' },
  status: 'interrupted',
  turn,
  type: 'result',
})

const lastAssistant = (session: AgentSession) => {
  const { messages } = session
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') {
      continue
    }
    return message
  }
  return undefined
}
const lastAssistantText = (session: AgentSession): string =>
  lastAssistant(session)?.content.reduce((text, part) => (part.type === 'text' ? `${text}${part.text}` : text), '') ?? ''

/** A strict, single-turn protocol worker. Exported for deterministic stream-level tests. */
export class SubagentWorker {
  #config: ParentConfigFrame | undefined
  readonly #output: Output
  readonly #sdk: SessionFactory
  #session: AgentSession | undefined
  #state: WorkerState = 'awaiting_config'
  #taskId: string | undefined
  #settled = false
  #disposed = false
  #interrupted = false
  #winnerStatus: 'completed' | 'failed' | 'interrupted' = 'failed'
  readonly #preflight = deferred()
  readonly #started = deferred()
  readonly #finished = deferred()
  #control: Promise<void> = Promise.resolve()
  #writes: Promise<void> = Promise.resolve()
  #pendingWrites = 0

  constructor(output: Output, factory: SessionFactory = sdk) {
    this.#output = output
    this.#sdk = factory
  }

  get state(): WorkerState {
    return this.#state
  }

  waitForSettlement(): Promise<void> {
    return this.#finished.promise
  }

  accept(frame: ParentFrame): Promise<void> {
    return this.#serialize(() => {
      if (frame.type === 'config') {
        return this.#acceptConfig(frame)
      }
      if (this.#config === undefined) {
        throw new ProtocolError('A config frame is required before commands.')
      }
      this.#assertIdentity(frame.agent_id, frame.turn)
      if (frame.type === 'task') {
        return this.#start(frame.command_id, frame.message)
      }
      if (frame.type === 'steer') {
        return this.#steer(frame)
      }
      return this.#interrupt(frame.command_id)
    })
  }

  parentEof(): Promise<void> {
    if (this.#state === 'exiting') {
      return Promise.resolve()
    }
    diagnostic('parent stdin reached EOF')
    if (this.#state !== 'running' && this.#state !== 'starting') {
      return Promise.reject(new ProtocolError('Parent stdin ended before worker completion.'))
    }
    this.#interrupted = true
    return Promise.resolve(this.#session?.abort())
      .then(() => this.#disposeSession())
      .then(() => Promise.reject(new ProtocolError('Parent stdin ended before worker completion.')))
  }

  #acceptConfig(frame: ParentConfigFrame): Promise<void> {
    if (this.#state !== 'awaiting_config') {
      throw new ProtocolError('Duplicate or out-of-order config frame.')
    }
    this.#config = frame
    this.#state = 'awaiting_task'
    return Promise.resolve()
  }

  #start(command_id: string, message: string): Promise<void> {
    if (this.#state !== 'awaiting_task') {
      throw new ProtocolError('Task is invalid in the current worker state.')
    }
    this.#state = 'starting'
    this.#taskId = command_id
    void this.#boot(command_id, message).catch((error: unknown) => {
      this.#state = 'exiting'
      this.#disposeSession()
      this.#finished.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    })
    return Promise.resolve()
  }

  #boot(command_id: string, message: string): Promise<void> {
    const config = this.#requiredConfig()
    const settingsManager = this.#sdk.settings.create(config.worker.cwd, config.worker.agentDir, { projectTrusted: config.worker.projectTrusted })
    return this.#openSession(config)
      .then((sessionManager) =>
        this.#sdk.runtime
          .create({
            authPath: bunPath.join(config.worker.agentDir, 'auth.json'),
            modelsPath: bunPath.join(config.worker.agentDir, 'models.json'),
          })
          .then((modelRuntime) => ({ modelRuntime, sessionManager }))
      )
      .then(({ modelRuntime, sessionManager }) => {
        const resourceLoader = new this.#sdk.resourceLoader({
          agentDir: config.worker.agentDir,
          appendSystemPrompt: [config.worker.prompt],
          cwd: config.worker.cwd,
          noContextFiles: true,
          noPromptTemplates: true,
          noSkills: true,
          settingsManager,
        })
        return resourceLoader.reload().then(() => ({ modelRuntime, resourceLoader, sessionManager }))
      })
      .then(({ modelRuntime, resourceLoader, sessionManager }) => {
        const model = modelRuntime.getModel(config.worker.provider, config.worker.model)
        if (model === undefined) {
          throw new Error(`Configured model ${config.worker.provider}/${config.worker.model} is unavailable.`)
        }
        return this.#sdk.create({
          cwd: config.worker.cwd,
          model,
          modelRuntime,
          resourceLoader,
          sessionManager,
          settingsManager,
          thinkingLevel: config.worker.thinkingLevel,
          tools: [...config.worker.tools],
        })
      })
      .then((result) => {
        this.#session = result.session
        if (this.#interrupted) {
          throw new ProtocolError('Parent stdin ended before worker completion.')
        }
        return this.#session.bindExtensions({ mode: 'print' })
      })
      .then(() => {
        const session = this.#requiredSession()
        session.setActiveToolsByName([...config.worker.tools])
        const activeTools = session.getActiveToolNames()
        const unavailableTool = config.worker.tools.find((tool) => !activeTools.includes(tool))
        const unexpectedTool = activeTools.find((tool) => !config.worker.tools.includes(tool))
        if (unavailableTool !== undefined || unexpectedTool !== undefined || activeTools.length !== config.worker.tools.length) {
          throw new Error(`Configured tool "${unavailableTool ?? unexpectedTool ?? 'set'}" is unavailable after extension loading.`)
        }
        if (
          session.model?.provider !== config.worker.provider ||
          session.model.id !== config.worker.model ||
          (config.worker.thinkingLevel !== undefined && session.thinkingLevel !== config.worker.thinkingLevel)
        ) {
          throw new Error('SDK changed the configured model or thinking level.')
        }
        session.subscribe((event) => this.#serialize(() => this.#event(event)))
        const prompt = session.prompt(message, {
          expandPromptTemplates: false,
          preflightResult: (accepted) => (accepted ? this.#preflight.resolve() : this.#preflight.reject(new Error('Prompt preflight was rejected.'))),
        })
        void prompt.catch((error: unknown) =>
          this.#serialize(() => this.#settle(failed(config.agent_id, command_id, config.turn, 'agent_failed', errorMessage(error))))
        )
        return this.#preflight.promise.then(() => this.#started.promise)
      })
      .then(() => {
        const sessionPath = this.#requiredSession().sessionManager.getSessionFile()
        if (sessionPath === undefined) {
          throw new Error('SDK did not materialize the session header.')
        }
        return this.#emit({ agent_id: config.agent_id, command_id, session_path: sessionPath, turn: config.turn, type: 'ready' })
      })
      .catch((error: unknown) => Promise.reject(error instanceof Error ? error : new Error(errorMessage(error))))
  }

  #openSession(config: ParentConfigFrame): Promise<SessionManager> {
    if (config.session.mode === 'open') {
      return Promise.resolve(this.#sdk.sessionManager.open(config.session.canonical_path, undefined, config.worker.cwd))
    }
    const directory = config.session.expected_dir
    return createPrivateSessionFilePromise(directory).then((path) => this.#sdk.sessionManager.open(path, directory, config.worker.cwd))
  }

  #event(event: AgentSessionEvent): Promise<void> {
    if (event.type === 'agent_start' && this.#state === 'starting') {
      this.#state = 'running'
      return this.#emit({
        activity: 'agent_started',
        agent_id: this.#requiredConfig().agent_id,
        command_id: this.#requiredTaskId(),
        turn: this.#requiredConfig().turn,
        type: 'progress',
      }).then(() => this.#started.resolve())
    }
    if (this.#state !== 'running') {
      return Promise.resolve()
    }
    const activity = progressFor(event)
    const progress =
      activity === undefined
        ? Promise.resolve()
        : this.#emit({
            activity,
            agent_id: this.#requiredConfig().agent_id,
            command_id: this.#requiredTaskId(),
            turn: this.#requiredConfig().turn,
            type: 'progress',
          })
    return progress.then(() => (event.type === 'agent_settled' ? this.#complete() : undefined))
  }

  #steer(frame: ParentSteerFrame): Promise<void> {
    const config = this.#requiredConfig()
    if (this.#state !== 'running' && !this.#settled) {
      throw new ProtocolError('Steer is invalid before the task is running.')
    }
    if (this.#settled) {
      return this.#emit({
        agent_id: config.agent_id,
        code: 'turn_settled',
        command_id: frame.command_id,
        error: 'The turn has already settled.',
        status: this.#terminalStatus(),
        turn: config.turn,
        type: 'command_error',
      })
    }
    return Promise.resolve(this.#session?.steer(frame.message))
      .then(() => this.#emit({ agent_id: config.agent_id, command_id: frame.command_id, turn: config.turn, type: 'steer_ack' }))
      .catch((error: unknown) =>
        this.#emit({
          agent_id: config.agent_id,
          code: 'queue_rejected',
          command_id: frame.command_id,
          error: errorMessage(error),
          status: 'running',
          turn: config.turn,
          type: 'command_error',
        })
      )
  }

  #interrupt(_command_id: string): Promise<void> {
    if (this.#state !== 'running' || this.#settled) {
      throw new ProtocolError('Interrupt is invalid unless the task is running.')
    }
    this.#interrupted = true
    return Promise.resolve(this.#session?.abort()).then(() => undefined)
  }

  #complete(): Promise<void> {
    const config = this.#requiredConfig()
    const taskId = this.#requiredTaskId()
    if (this.#interrupted) {
      return this.#settle(interrupted(config.agent_id, taskId, config.turn))
    }
    const session = this.#requiredSession()
    const assistant = lastAssistant(session)
    if (assistant?.stopReason === 'error' || assistant?.stopReason === 'aborted') {
      return this.#settle(failed(config.agent_id, taskId, config.turn, 'agent_failed', assistant.errorMessage ?? 'The model failed.'))
    }
    const conclusion = lastAssistantText(session)
    const usage = session.getContextUsage()
    const context =
      usage?.tokens !== null && usage?.tokens !== undefined && Number.isSafeInteger(usage.tokens) && usage.tokens >= 0
        ? { context_tokens: usage.tokens }
        : {}
    if (utf8.encode(conclusion).byteLength > MAX_ARTIFACT_BYTES) {
      return this.#settle(failed(config.agent_id, taskId, config.turn, 'result_too_large', 'The conclusion exceeds 10 MiB.'))
    }
    if (isInlineConclusion(conclusion)) {
      return this.#settle({
        agent_id: config.agent_id,
        command_id: taskId,
        conclusion,
        ...context,
        status: 'completed',
        turn: config.turn,
        type: 'result',
      })
    }
    return writePrivateUniqueFilePromise(config.run_dir, '.txt', conclusion).then((artifact) =>
      this.#settle({
        agent_id: config.agent_id,
        command_id: taskId,
        conclusion_artifact: artifact,
        conclusion_bytes: utf8.encode(conclusion).byteLength,
        conclusion_preview: boundedPreview(conclusion),
        ...context,
        status: 'completed',
        turn: config.turn,
        type: 'result',
      })
    )
  }

  #settle(frame: ChildResultFrame): Promise<void> {
    if (this.#settled) {
      return Promise.resolve()
    }
    this.#settled = true
    this.#winnerStatus = frame.status
    this.#state = 'settled'
    return this.#emit(frame).finally(() => {
      this.#disposeSession()
      this.#state = 'exiting'
      this.#finished.resolve()
    })
  }

  #disposeSession(): void {
    if (this.#session === undefined || this.#disposed) {
      return
    }
    this.#disposed = true
    this.#session.dispose()
  }

  #assertIdentity(agentId: string, turn: number): void {
    const config = this.#requiredConfig()
    if (config.agent_id !== agentId || config.turn !== turn) {
      throw new ProtocolError('Command correlation does not match config.')
    }
  }
  #requiredConfig(): ParentConfigFrame {
    if (this.#config === undefined) {
      throw new ProtocolError('Worker config is missing.')
    }
    return this.#config
  }
  #requiredSession(): AgentSession {
    if (this.#session === undefined) {
      throw new ProtocolError('SDK session is missing.')
    }
    return this.#session
  }
  #requiredTaskId(): string {
    if (this.#taskId === undefined) {
      throw new ProtocolError('Task command id is missing.')
    }
    return this.#taskId
  }
  #terminalStatus(): 'completed' | 'failed' | 'interrupted' {
    return this.#winnerStatus
  }
  #serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.#control.then(operation)
    this.#control = next.catch(() => undefined)
    return next
  }
  #emit(frame: ChildFrame): Promise<void> {
    if (!isChildFrame(frame)) {
      throw new ProtocolError('Worker attempted to emit an invalid child frame.')
    }
    if (frame.type === 'progress' && this.#pendingWrites >= MAX_PENDING_PROGRESS_WRITES) {
      return Promise.resolve()
    }
    this.#pendingWrites += 1
    this.#writes = this.#writes.catch(() => undefined).then(() => this.#output.write(encodeFrame(frame)))
    return this.#writes.finally(() => {
      this.#pendingWrites -= 1
    })
  }
}

const progressFor = (event: AgentSessionEvent): 'assistant_activity' | 'tool_finished' | 'tool_started' | undefined => {
  if (event.type === 'message_update') {
    return 'assistant_activity'
  }
  if (event.type === 'tool_execution_start') {
    return 'tool_started'
  }
  if (event.type === 'tool_execution_end') {
    return 'tool_finished'
  }
  return undefined
}
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message.slice(0, MAX_ERROR_MESSAGE_CHARS) : 'Unknown worker failure.'
const isChildFrame = (frame: ChildFrame): boolean =>
  Value.Check(ChildCommandErrorFrameSchema, frame) ||
  Value.Check(ChildProgressFrameSchema, frame) ||
  Value.Check(ChildReadyFrameSchema, frame) ||
  Value.Check(ChildResultFrameSchema, frame) ||
  Value.Check(ChildSteerAckFrameSchema, frame)
const utf8ByteLength = (character: string): number => {
  const codePoint = character.codePointAt(0)
  if (codePoint === undefined || codePoint <= 127) {
    return 1
  }
  if (codePoint <= 2047) {
    return 2
  }
  if (codePoint <= 65_535) {
    return 3
  }
  return 4
}
const boundedPreview = (value: string): string => {
  const preview: string[] = []
  let bytes = 0
  let lines = 1
  for (const character of value) {
    const nextLines = lines + (character === '\n' ? 1 : 0)
    const nextBytes = bytes + utf8ByteLength(character)
    if (nextLines > MAX_INLINE_LINES || nextBytes > MAX_INLINE_BYTES) {
      break
    }
    preview.push(character)
    bytes = nextBytes
    lines = nextLines
  }
  return preview.join('')
}

export const runWorker = (input: AsyncIterable<Uint8Array>, output: Output, factory: SessionFactory = sdk): Promise<void> => {
  const decoder = new JsonlDecoder()
  const worker = new SubagentWorker(output, factory)
  const iterator = input[Symbol.asyncIterator]()
  const next = (): Promise<void> =>
    Promise.race([iterator.next(), worker.waitForSettlement().then(() => undefined)]).then((value) => {
      if (value === undefined) {
        return undefined
      }
      if (value.done === true) {
        decoder.end()
        return worker.parentEof()
      }
      return decoder
        .push(value.value)
        .reduce((accepted, frame) => accepted.then(() => worker.accept(frame)), Promise.resolve())
        .then(next)
    })
  return next()
}

const isolatedProtocolOutput = (): Output => {
  if (process.platform === 'win32') {
    throw new Error('Windows sub-agent workers are unsupported')
  }
  const library = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    dup2: { args: ['i32', 'i32'], returns: 'i32' },
    open: { args: ['cstring', 'i32'], returns: 'i32' },
  })
  try {
    const descriptor = library.symbols.open(process.platform === 'darwin' ? '/dev/fd/1' : '/proc/self/fd/1', 1)
    if (descriptor < 0 || library.symbols.dup2(2, 1) < 0) {
      throw new Error('Could not isolate worker stdout')
    }
    const protocol = Bun.file(descriptor)
    return { write: (value) => Bun.write(protocol, value).then(() => undefined) }
  } finally {
    library.close()
  }
}

if (import.meta.main) {
  const output = isolatedProtocolOutput()
  void runWorker(Bun.stdin.stream(), output).then(
    () => process.exit(0),
    (error: unknown) => {
      diagnostic(errorMessage(error))
      process.exitCode = 1
    }
  )
}
