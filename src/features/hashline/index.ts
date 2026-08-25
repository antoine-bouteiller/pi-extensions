import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { type Effect } from 'effect'

import { type AppServices, type AppRuntime } from '#shared/effect/app_services'
import { type FeaturePlugin } from '#shared/effect/feature'
import { makeToolExecutor, type HandlerServices, type ToolInvocation } from '#shared/effect/runtime'

import { makeHashlineTools, readSchema, renderHashlineRead, writeSchema, type HashlineToolError } from './tools.js'

type EagerFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'eager' }>

export const feature = {
  bootstrap: 'eager',
  id: 'hashline',
  implementation: {
    register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
      const tools = makeHashlineTools()

      /*
       * Interruption is deliberately left to the body: hashline needs the raw signal for CwdFilesystem
       * and the post-lock TOCTOU re-check, and an interrupted fiber would discard the in-flight
       * mutation-queue wait and replace its cooperative `throwIfAborted` message with a generic one.
       */
      const runTool = <Params, Result>(
        body: (params: Params, signal: AbortSignal | undefined) => Effect.Effect<Result, HashlineToolError, HandlerServices | AppServices>
      ) => makeToolExecutor(runtime)(({ params, signal }: ToolInvocation<Params>) => body(params, signal), { interruptOnAbort: false })

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
    },
  },
  status: { icon: '#️⃣', name: 'hashline' },
} satisfies EagerFeaturePlugin
