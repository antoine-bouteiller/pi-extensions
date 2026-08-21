import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect, Fiber, Option } from 'effect'

import { detectSystemTheme } from '@/features/auto_theme/theme.js'

interface Response {
  code?: number
  stdout: string
}

const execWith = (responses: Response[]) => {
  const calls: { args: string[]; command: string }[] = []
  const exec: ExtensionAPI['exec'] = (command, args) => {
    calls.push({ args, command })
    const response = responses.shift() ?? { stdout: '' }
    return Promise.resolve({ code: response.code ?? 0, killed: false, stderr: '', stdout: response.stdout })
  }
  return { calls, exec }
}

describe('system theme detection', () => {
  it.effect('detects macOS appearance', () =>
    Effect.gen(function* () {
      const fake = execWith([{ stdout: 'true\n' }])
      expect(yield* detectSystemTheme(fake.exec, 'darwin')).toEqual(Option.some('dark'))
      expect(fake.calls[0]?.command).toBe('osascript')
    })
  )

  it.effect('detects Windows appearance', () =>
    Effect.gen(function* () {
      const fake = execWith([{ stdout: '1\r\n' }])
      expect(yield* detectSystemTheme(fake.exec, 'win32')).toEqual(Option.some('light'))
      expect(fake.calls[0]?.command).toBe('powershell.exe')
    })
  )

  it.effect('aborts an in-flight system query when interrupted', () =>
    Effect.gen(function* () {
      let signal: AbortSignal | undefined
      let timeout: number | undefined
      const exec: ExtensionAPI['exec'] = (_command, _args, options) => {
        signal = options?.signal
        timeout = options?.timeout
        const pending = Promise.withResolvers<Awaited<ReturnType<ExtensionAPI['exec']>>>()
        signal?.addEventListener('abort', () => pending.reject(new Error('aborted')), { once: true })
        return pending.promise
      }
      const fiber = yield* Effect.forkChild(detectSystemTheme(exec, 'darwin'))
      yield* Effect.yieldNow

      expect(signal?.aborted).toBeFalse()
      expect(timeout).toBe(2000)
      yield* Fiber.interrupt(fiber)
      expect(signal?.aborted).toBeTrue()
    })
  )

  it.effect('uses the Freedesktop portal and falls back to GNOME settings', () =>
    Effect.gen(function* () {
      const portal = execWith([{ stdout: '(<uint32 1>,)\n' }])
      expect(yield* detectSystemTheme(portal.exec, 'linux')).toEqual(Option.some('dark'))
      expect(portal.calls).toHaveLength(1)

      const fallback = execWith([{ code: 1, stdout: '' }, { stdout: "'prefer-light'\n" }])
      expect(yield* detectSystemTheme(fallback.exec, 'freebsd')).toEqual(Option.some('light'))
      expect(fallback.calls.map(({ command }) => command)).toEqual(['gdbus', 'gsettings'])

      const neutral = execWith([{ stdout: '(<uint32 0>,)\n' }, { stdout: "'default'\n" }])
      expect(yield* detectSystemTheme(neutral.exec, 'linux')).toEqual(Option.none())
    })
  )
})
