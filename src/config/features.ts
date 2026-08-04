import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { register as askUser } from '@/features/ask_user/feature.js'
import { register as backgroundPoll } from '@/features/background_poll/feature.js'
import { register as claudeCode } from '@/features/claude_code/feature.js'
import { register as commentChecker } from '@/features/comment_checker/feature.js'
import { register as hashline } from '@/features/hashline/feature.js'
import { register as mcp } from '@/features/mcp/feature.js'
import { register as meridianSessionAffinity } from '@/features/meridian_session_affinity/feature.js'
import { register as promptRewind } from '@/features/prompt_rewind/feature.js'
import { register as rules } from '@/features/rules/feature.js'
import { register as safeRm } from '@/features/safe_rm/feature.js'
import { register as safetyGuard } from '@/features/safety_guard/feature.js'
import { register as statusPanel } from '@/features/status_panel/feature.js'
import { register as subAgents } from '@/features/sub_agents/feature.js'
import { register as webfetch } from '@/features/webfetch/feature.js'
import { type AppRuntime } from '@/shared/effect/app_services.js'

export interface FeatureRegistration {
  readonly name: string
  readonly register: (pi: ExtensionAPI, runtime: AppRuntime) => void
}

export const features: readonly FeatureRegistration[] = [
  { name: 'ask-user', register: askUser },
  { name: 'background-poll', register: backgroundPoll },
  { name: 'claude-code', register: claudeCode },
  { name: 'comment-checker', register: commentChecker },
  { name: 'hashline', register: hashline },
  { name: 'mcp', register: mcp },
  { name: 'meridian-session-affinity', register: meridianSessionAffinity },
  { name: 'prompt-rewind', register: promptRewind },
  { name: 'rules', register: rules },
  { name: 'safe-rm', register: safeRm },
  { name: 'safety-guard', register: safetyGuard },
  { name: 'status-panel', register: statusPanel },
  { name: 'sub-agents', register: subAgents },
  { name: 'webfetch', register: webfetch },
]

export const registerFeatures = (pi: ExtensionAPI, runtime: AppRuntime): void => {
  for (const feature of features) {
    feature.register(pi, runtime)
  }
}
