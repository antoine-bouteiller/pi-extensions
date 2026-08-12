import { type ExtensionAPI, formatSize } from '@earendil-works/pi-coding-agent'
import { Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'

import {
  makeWebfetchRunner,
  MAX_DOWNLOAD_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  renderWebfetchResult,
  WebfetchParams,
  type WebfetchDependencies,
} from './fetch.js'

// oxlint-disable-next-line effecttsgo/missing-pipeable-signature -- Function.dual provides the data-last overload declared below.
export const createWebfetchExtension: {
  (runtime: AppRuntime): (overrides: Partial<WebfetchDependencies>) => (pi: ExtensionAPI) => void
  (overrides: Partial<WebfetchDependencies>, runtime: AppRuntime): (pi: ExtensionAPI) => void
} = Function.dual(
  2,
  (overrides: Partial<WebfetchDependencies>, runtime: AppRuntime) =>
    function webfetchExtension(pi: ExtensionAPI): void {
      const runWebfetch = makeWebfetchRunner({ overrides, runtime })

      pi.registerTool({
        description: `Fetch an HTTP(S) URL and return its content as markdown, plain text, or raw HTML. HTML defaults to markdown. Downloads are limited to ${formatSize(MAX_DOWNLOAD_BYTES)}; output is truncated to ${MAX_OUTPUT_LINES} lines or ${formatSize(MAX_OUTPUT_BYTES)} and saved to a temporary file when larger.`,
        execute: (_toolCallId, params, signal, onUpdate) => runWebfetch(params, signal ?? undefined, onUpdate),
        label: 'Web Fetch',
        name: 'webfetch',
        parameters: WebfetchParams,
        promptGuidelines: [
          'Use webfetch to read a known static web page or HTTP endpoint. Use agent-browser instead when the task requires interaction, authentication, screenshots, or JavaScript-rendered content.',
        ],
        promptSnippet: 'Fetch and read static web pages or HTTP endpoints',
        renderResult: renderWebfetchResult,
      })
    }
)

export const register: {
  (runtime: AppRuntime): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime): void
} = Function.dual(2, (pi: ExtensionAPI, runtime: AppRuntime): void => createWebfetchExtension({}, runtime)(pi))
