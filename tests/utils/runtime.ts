import { getOrCreateProcessRuntime } from '@/config/runtime.js'
import { type AppRuntime } from '@/shared/effect/app_services.js'

export const runtime: AppRuntime = getOrCreateProcessRuntime()
