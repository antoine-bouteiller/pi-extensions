import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { type ProcessRuntime } from '#config/runtime'
import { register as askUser } from '#features/ask_user/index'
import { register as backgroundPoll } from '#features/background_poll/index'
import { register as caffeinate } from '#features/caffeinate/index'
import { register as claudeCode } from '#features/claude_code/index'
import { register as commentChecker } from '#features/comment_checker/index'
import { register as hashline } from '#features/hashline/index'
import { register as mcp } from '#features/mcp/index'
import { register as meridianSessionAffinity } from '#features/meridian_session_affinity/index'
import { register as plainEnglish } from '#features/plain_english/index'
import { register as promptRewind } from '#features/prompt_rewind/index'
import { register as rules } from '#features/rules/index'
import { register as safeRm } from '#features/safe_rm/index'
import { register as safetyGuard } from '#features/safety_guard/index'
import { register as statusPanel } from '#features/status_panel/index'
import { register as webfetch } from '#features/webfetch/index'

interface FeatureRegistration {
  readonly name: string
  readonly register: (pi: ExtensionAPI, runtime: ProcessRuntime) => void
}

const features: readonly FeatureRegistration[] = [
  { name: 'ask-user', register: askUser },
  { name: 'background-poll', register: backgroundPoll },
  { name: 'caffeinate', register: caffeinate },
  { name: 'claude-code', register: claudeCode },
  { name: 'comment-checker', register: commentChecker },
  { name: 'hashline', register: hashline },
  { name: 'mcp', register: mcp },
  { name: 'meridian-session-affinity', register: meridianSessionAffinity },
  { name: 'plain-english', register: plainEnglish },
  { name: 'prompt-rewind', register: promptRewind },
  { name: 'rules', register: rules },
  { name: 'safe-rm', register: safeRm },
  { name: 'safety-guard', register: safetyGuard },
  { name: 'status-panel', register: statusPanel },
  { name: 'webfetch', register: webfetch },
]

export const registerFeatures = (pi: ExtensionAPI, runtime: ProcessRuntime): void => {
  for (const feature of features) {
    feature.register(pi, runtime)
  }
}
