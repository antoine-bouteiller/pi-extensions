import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect, Option } from 'effect'

export type SystemTheme = 'dark' | 'light'

type Exec = ExtensionAPI['exec']

const run = (exec: Exec, command: string, args: string[]): Effect.Effect<string | undefined> =>
  Effect.tryPromise((signal) => exec(command, args, { signal, timeout: 2000 })).pipe(
    Effect.map((result) => (result.code === 0 && !result.killed ? result.stdout.trim() : undefined)),
    Effect.orElseSucceed(() => undefined)
  )

const macTheme = (output: string | undefined): SystemTheme | undefined => {
  if (output === 'true') {
    return 'dark'
  }
  if (output === 'false') {
    return 'light'
  }
  return undefined
}

const detectMacTheme = (exec: Exec): Effect.Effect<Option.Option<SystemTheme>> =>
  run(exec, 'osascript', ['-e', 'tell application "System Events" to tell appearance preferences to return dark mode']).pipe(
    Effect.map((output) => Option.fromNullishOr(macTheme(output)))
  )

const windowsTheme = (output: string | undefined): SystemTheme | undefined => {
  if (output === '0') {
    return 'dark'
  }
  if (output === '1') {
    return 'light'
  }
  return undefined
}

const detectWindowsTheme = (exec: Exec): Effect.Effect<Option.Option<SystemTheme>> =>
  run(exec, 'powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    String.raw`(Get-ItemProperty -Path HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize -Name AppsUseLightTheme).AppsUseLightTheme`,
  ]).pipe(Effect.map((output) => Option.fromNullishOr(windowsTheme(output))))

const portalTheme = (output: string | undefined): SystemTheme | undefined => {
  const colorScheme = output?.match(/uint32\s+(?<colorScheme>[12])/)?.groups?.colorScheme
  if (colorScheme === '1') {
    return 'dark'
  }
  if (colorScheme === '2') {
    return 'light'
  }
  return undefined
}

const gnomeTheme = (output: string | undefined): SystemTheme | undefined => {
  const setting = output?.toLowerCase()
  if (setting !== undefined && setting.includes('prefer-dark')) {
    return 'dark'
  }
  if (setting !== undefined && setting.includes('prefer-light')) {
    return 'light'
  }
  return undefined
}

const detectUnixTheme = (exec: Exec): Effect.Effect<Option.Option<SystemTheme>> =>
  run(exec, 'gdbus', [
    'call',
    '--session',
    '--dest',
    'org.freedesktop.portal.Desktop',
    '--object-path',
    '/org/freedesktop/portal/desktop',
    '--method',
    'org.freedesktop.portal.Settings.Read',
    'org.freedesktop.appearance',
    'color-scheme',
  ]).pipe(
    Effect.flatMap((portal) => {
      const theme = portalTheme(portal)
      return theme === undefined
        ? run(exec, 'gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']).pipe(
            Effect.map((output) => Option.fromNullishOr(gnomeTheme(output)))
          )
        : Effect.succeed(Option.some(theme))
    })
  )

export const detectSystemTheme = (exec: Exec, platform: NodeJS.Platform): Effect.Effect<Option.Option<SystemTheme>> => {
  if (platform === 'darwin') {
    return detectMacTheme(exec)
  }
  if (platform === 'win32') {
    return detectWindowsTheme(exec)
  }
  return detectUnixTheme(exec)
}
