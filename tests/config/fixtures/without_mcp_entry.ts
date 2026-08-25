import { getOrCreateProcessRuntime } from '@/config/runtime.js'
import { feature as askUser } from '@/features/ask_user/index.js'
import { feature as statusPanel } from '@/features/status_panel/index.js'

const enabledNonMcpFeatures = [askUser, statusPanel]

void getOrCreateProcessRuntime
void enabledNonMcpFeatures
