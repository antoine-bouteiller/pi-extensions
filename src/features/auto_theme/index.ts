import { type ExtensionAPI, type ExtensionContext, SettingsManager } from '@earendil-works/pi-coding-agent'
import { Effect, Exit, Option, Scope } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'

import { detectSystemTheme, type SystemTheme } from './theme.js'

export interface AutoThemeDependencies {
  readonly detect: Effect.Effect<Option.Option<SystemTheme>>
  readonly isSubagent: boolean
  readonly sleep: Effect.Effect<void>
  readonly themeSetting: string | undefined
}

const productionDependencies = (pi: ExtensionAPI): AutoThemeDependencies => ({
  detect: detectSystemTheme(pi.exec.bind(pi), process.platform),
  isSubagent: process.env.PI_SUBAGENT_OWNER_TOKEN !== undefined,
  sleep: Effect.sleep('5 seconds'),
  themeSetting: SettingsManager.create(process.cwd()).getThemeSetting(),
})

const themeLoop = (ctx: ExtensionContext, dependencies: AutoThemeDependencies): Effect.Effect<never> => {
  const themes = dependencies.themeSetting?.split('/').map((theme) => theme.trim())
  if (themes?.length !== 2 || themes.some((theme) => theme.length === 0)) {
    return Effect.never
  }
  const [lightTheme, darkTheme] = themes
  let current: SystemTheme | undefined
  const check = dependencies.detect.pipe(
    Effect.flatMap((detected) =>
      Effect.sync(() => {
        if (Option.isNone(detected) || detected.value === current) {
          return
        }
        const theme = detected.value
        const loadedTheme = ctx.ui.getTheme(theme === 'dark' ? darkTheme : lightTheme)
        if (loadedTheme !== undefined && ctx.ui.setTheme(loadedTheme).success) {
          current = theme
        }
      })
    )
  )
  return check.pipe(Effect.andThen(dependencies.sleep), Effect.forever)
}

export const register = (pi: ExtensionAPI, runtime: AppRuntime, dependencies: AutoThemeDependencies = productionDependencies(pi)): void => {
  if (dependencies.isSubagent) {
    return
  }

  let sessionScope: Scope.Closeable | undefined

  pi.on('session_start', (_event, ctx) =>
    runtime.runPromise(
      ctx.mode === 'tui'
        ? Effect.gen(function* () {
            const next = yield* Scope.make()
            const previous = sessionScope
            sessionScope = next
            if (previous !== undefined) {
              yield* Scope.close(previous, Exit.void)
            }
            yield* Effect.forkIn(themeLoop(ctx, dependencies), next)
          })
        : Effect.void
    )
  )

  pi.on('session_shutdown', () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const current = sessionScope
        sessionScope = undefined
        if (current !== undefined) {
          yield* Scope.close(current, Exit.void)
        }
      })
    )
  )
}
