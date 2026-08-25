import { type ExtensionAPI, formatSize } from '@earendil-works/pi-coding-agent'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeaturePlugin } from '#shared/effect/feature'
import { makeToolExecutor } from '#shared/effect/runtime'

import { MAX_DOWNLOAD_BYTES, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, renderWebfetchResult, webfetchEffect, WebfetchParams } from './fetch.js'

type EagerFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'eager' }>

export const feature = {
  bootstrap: 'eager',
  id: 'webfetch',
  implementation: {
    register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
      pi.registerTool({
        description: `Fetch an HTTP(S) URL and return its content as markdown, plain text, or raw HTML. HTML defaults to markdown. Downloads are limited to ${formatSize(MAX_DOWNLOAD_BYTES)}; output is truncated to ${MAX_OUTPUT_LINES} lines or ${formatSize(MAX_OUTPUT_BYTES)} and saved to a temporary file when larger.`,
        execute: makeToolExecutor(runtime)(({ onUpdate, params, signal }) => webfetchEffect(params, signal, onUpdate), { interruptOnAbort: false }),
        label: 'Web Fetch',
        name: 'webfetch',
        parameters: WebfetchParams,
        promptGuidelines: [
          'Use webfetch to read a known static web page or HTTP endpoint. Use agent-browser instead when the task requires interaction, authentication, screenshots, or JavaScript-rendered content.',
        ],
        promptSnippet: 'Fetch and read static web pages or HTTP endpoints',
        renderResult: renderWebfetchResult,
      })
    },
  },
  status: { icon: '🌐', name: 'webfetch' },
} satisfies EagerFeaturePlugin
