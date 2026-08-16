import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { type ProcessRuntime } from '@/config/runtime.js'
import { register as askUser } from '@/features/ask_user/index.js'
import { register as backgroundPoll } from '@/features/background_poll/index.js'
import { register as caffeinate } from '@/features/caffeinate/index.js'
import { register as claudeCode } from '@/features/claude_code/index.js'
import { register as commentChecker } from '@/features/comment_checker/index.js'
import { register as mcp } from '@/features/mcp/index.js'
import { register as meridianSessionAffinity } from '@/features/meridian_session_affinity/index.js'
import { register as plainEnglish } from '@/features/plain_english/index.js'
import { register as promptRewind } from '@/features/prompt_rewind/index.js'
import { register as rules } from '@/features/rules/index.js'
import { register as safeRm } from '@/features/safe_rm/index.js'
import { register as safetyGuard } from '@/features/safety_guard/index.js'
import { register as statusPanel } from '@/features/status_panel/index.js'
import { register as subAgents } from '@/features/sub_agents/index.js'
import { register as webfetch } from '@/features/webfetch/index.js'

export interface FeatureRegistration {
  readonly name: string
  readonly register: (pi: ExtensionAPI, runtime: ProcessRuntime) => void
}

export const features: readonly FeatureRegistration[] = [
  { name: 'ask-user', register: askUser },
  { name: 'background-poll', register: backgroundPoll },
  { name: 'caffeinate', register: caffeinate },
  { name: 'claude-code', register: claudeCode },
  { name: 'comment-checker', register: commentChecker },
  { name: 'mcp', register: mcp },
  { name: 'meridian-session-affinity', register: meridianSessionAffinity },
  { name: 'plain-english', register: plainEnglish },
  { name: 'prompt-rewind', register: promptRewind },
  { name: 'rules', register: rules },
  { name: 'safe-rm', register: safeRm },
  { name: 'safety-guard', register: safetyGuard },
  { name: 'status-panel', register: statusPanel },
  { name: 'sub-agents', register: subAgents },
  { name: 'webfetch', register: webfetch },
]

export const registerFeatures = (pi: ExtensionAPI, runtime: ProcessRuntime): void => {
  for (const feature of features) {
    feature.register(pi, runtime)
  }
}
