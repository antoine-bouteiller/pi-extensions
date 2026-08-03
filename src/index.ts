import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { registerFeatures } from '@/config/features.js'
import { getOrCreateProcessRuntime } from '@/config/runtime.js'

export default function piExtensions(pi: ExtensionAPI): void {
  const runtime = getOrCreateProcessRuntime()
  registerFeatures(pi, runtime)
}
