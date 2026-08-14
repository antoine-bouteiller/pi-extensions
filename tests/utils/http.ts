import { Effect } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'

import { runtime } from './runtime.js'

export const httpGet = (url: string): Promise<{ status: number; text: () => Promise<string> }> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(HttpClientRequest.get(url))
      return { status: response.status, text: () => runtime.runPromise(response.text) }
    })
  )
