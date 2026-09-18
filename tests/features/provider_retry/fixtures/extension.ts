import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { getOrCreateProcessRuntime } from '../../../../src/config/runtime.js'
import { feature } from '../../../../src/features/provider_retry/index.js'

export default function registerProviderRetry(pi: ExtensionAPI): void {
  feature().implementation.register(pi, getOrCreateProcessRuntime())
}
