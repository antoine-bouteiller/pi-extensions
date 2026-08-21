import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppServices, type AppRuntime } from '#shared/effect/app_services'
import { perInvocation, type HandlerServices } from '#shared/effect/runtime'

import { makeHashlineTools, readSchema, renderHashlineRead, writeSchema, type HashlineToolError } from './tools.js'

export const register = (pi: ExtensionAPI, runtime: AppRuntime): void => {
  const tools = makeHashlineTools(runtime)

  /*
   * `makeToolExecutor` doesn't hand the raw AbortSignal to the body, but hashline needs it for
   * CwdFilesystem and the post-lock TOCTOU re-check, so this bridge threads the signal instead.
   *
   * `{ signal }` is deliberately not passed to runPromise: that makes Effect interrupt the fiber the
   * instant the signal fires, discarding the in-flight mutation-queue wait and replacing hashline's
   * cooperative `throwIfAborted` message with Effect's generic interrupted-fiber one.
   */
  const runTool =
    <Params, Result>(
      body: (params: Params, signal: AbortSignal | undefined) => Effect.Effect<Result, HashlineToolError, HandlerServices | AppServices>
    ) =>
    async (_toolCallId: string, params: Params, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<Result> =>
      runtime.runPromise(body(params, signal).pipe(Effect.provide(perInvocation(ctx))))

  pi.registerTool({
    description: `Read a file with stable line anchors and a content hash for write. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. Text output is bounded; use offset and limit for large files. Protected credential paths are refused by this tool itself.`,
    execute: runTool(tools.read),
    label: 'Read',
    name: 'read',
    parameters: readSchema,
    promptSnippet: 'Read text files with stable line anchors and images as attachments.',
    renderResult: renderHashlineRead,
  })

  pi.registerTool({
    description:
      'Apply a hashline patch produced from read. Use hashline operations (PUT, CUT, MV, or REM), not unified-diff @@ hunks. Patches are content-hash anchored, reject stale edits, and refuse protected credential paths.',
    execute: runTool(tools.write),
    label: 'Write',
    name: 'write',
    parameters: writeSchema,
    promptGuidelines: [
      'Use read before write so every section has a current [path#TAG] anchor.',
      'In write, replace lines with `PUT N.=M:` followed by `+` body rows; never use unified-diff @@ headers.',
    ],
    promptSnippet: 'Apply content-hash-anchored patches to files.',
  })
}
