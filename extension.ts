import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { register as askUser } from './src/ask-user/index.js'
import { register as backgroundPoll } from './src/background-poll/index.js'
import { register as claudeCode } from './src/claude-code/index.js'
import { register as commentChecker } from './src/comment-checker/index.js'
import { getOrCreateProcessRuntime } from './src/effect/app_runtime.js'
import { register as hashline } from './src/hashline/index.js'
import { register as mcp } from './src/mcp/index.js'
import { register as meridianSessionAffinity } from './src/meridian-session-affinity/index.js'
import { register as rules } from './src/rules/index.js'
import { register as safeRm } from './src/safe-rm/index.js'
import { register as safetyGuard } from './src/safety-guard/index.js'
import { register as statusPanel } from './src/status-panel/index.js'
import { register as subAgents } from './src/sub-agents/index.js'
import { register as webfetch } from './src/webfetch/index.js'

export default function piExtensions(pi: ExtensionAPI): void {
  const runtime = getOrCreateProcessRuntime()
  askUser(pi, runtime)
  backgroundPoll(pi, runtime)
  claudeCode(pi, runtime)
  commentChecker(pi, runtime)
  hashline(pi, runtime)
  mcp(pi, runtime)
  meridianSessionAffinity(pi, runtime)
  rules(pi, runtime)
  safeRm(pi, runtime)
  safetyGuard(pi, runtime)
  statusPanel(pi, runtime)
  subAgents(pi, runtime)
  webfetch(pi, runtime)
}
