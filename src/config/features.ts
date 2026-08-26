import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { registerFeatures as registerWithCoordinator } from '#config/feature_coordinator'
import { type ProcessRuntime } from '#config/runtime'
import { feature as askUser } from '#features/ask_user/index'
import { feature as autoTheme } from '#features/auto_theme/index'
import { feature as backgroundPoll } from '#features/background_poll/index'
import { feature as caffeinate } from '#features/caffeinate/index'
import { feature as claudeCode } from '#features/claude_code/index'
import { feature as commentChecker } from '#features/comment_checker/index'
import { feature as hashline } from '#features/hashline/index'
import { feature as mcp } from '#features/mcp/index'
import { feature as meridianSessionAffinity } from '#features/meridian_session_affinity/index'
import { feature as promptRewind } from '#features/prompt_rewind/index'
import { feature as rules } from '#features/rules/index'
import { feature as safetyGuard } from '#features/safety_guard/index'
import { feature as statusPanel } from '#features/status_panel/index'
import { feature as subAgents } from '#features/sub_agents/index'
import { feature as webfetch } from '#features/webfetch/index'
import { type FeaturePlugin } from '#shared/effect/feature'

export const features = [
  { ...askUser, suppressInChild: true },
  autoTheme,
  { ...backgroundPoll, suppressInChild: true },
  { ...caffeinate, suppressInChild: true },
  { ...claudeCode, suppressInChild: true },
  commentChecker,
  hashline,
  mcp,
  meridianSessionAffinity,
  { ...promptRewind, suppressInChild: true },
  { ...rules, suppressInChild: true },
  safetyGuard,
  statusPanel,
  { ...subAgents, suppressInChild: true },
  webfetch,
] satisfies readonly FeaturePlugin[]

export const registerFeatures = (pi: ExtensionAPI, runtime: ProcessRuntime): void => registerWithCoordinator(pi, runtime, features)
