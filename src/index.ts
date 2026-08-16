import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { registerFeatures } from '#config/features'
import { getOrCreateProcessRuntime } from '#config/runtime'

export default function piExtensions(pi: ExtensionAPI): void {
  const runtime = getOrCreateProcessRuntime()
  registerFeatures(pi, runtime)
}
