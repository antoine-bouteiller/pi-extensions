import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { Effect } from 'effect'

import { fetchGitInfo } from '@/features/status_panel/git.js'

const success = (stdout: string) => ({ code: 0, killed: false, stderr: '', stdout })

describe('status panel git state', () => {
  it.effect('reports the current branch and porcelain entry count', () =>
    Effect.gen(function* () {
      const calls: string[][] = []
      const outputs = [success('true\n'), success('feature/footer\n'), success(' M one\n?? two\n')]
      const { pi } = createFakePi({
        exec: async (command, args) => {
          calls.push([command, ...args])
          return outputs.shift() ?? success('')
        },
      })

      expect(yield* fetchGitInfo(pi)).toEqual({
        branch: 'feature/footer',
        changedFiles: 2,
        pullRequest: undefined,
      })
      expect(calls).toEqual([
        ['git', 'rev-parse', '--is-inside-work-tree'],
        ['git', 'branch', '--show-current'],
        ['git', 'status', '--short'],
      ])
    })
  )

  it.effect('returns empty state outside a repository or when git fails', () =>
    Effect.gen(function* () {
      const outside = createFakePi({
        exec: async (_command, args) => (args[0] === 'rev-parse' ? { ...success('false\n'), code: 128 } : success('ignored')),
      })
      const failing = createFakePi({
        exec: async () => {
          throw new Error('git unavailable')
        },
      })

      const empty = { branch: undefined, changedFiles: 0, pullRequest: undefined }
      expect(yield* fetchGitInfo(outside.pi)).toEqual(empty)
      expect(yield* fetchGitInfo(failing.pi)).toEqual(empty)
    })
  )

  it.effect('degrades malformed command results instead of leaking a defect', () =>
    Effect.gen(function* () {
      const malformed = {
        ...success(''),
        get stdout(): string {
          throw new TypeError('malformed git result')
        },
      }
      const { pi } = createFakePi({ exec: async () => malformed })

      expect(yield* fetchGitInfo(pi)).toEqual({
        branch: undefined,
        changedFiles: 0,
        pullRequest: undefined,
      })
    })
  )

  it.effect('does not use failed branch or status command output', () =>
    Effect.gen(function* () {
      const outputs = [success('true\n'), { ...success('stale-branch\n'), code: 1 }, { ...success(' M stale\n'), code: 1 }]
      const { pi } = createFakePi({
        exec: async () => outputs.shift() ?? success(''),
      })

      expect(yield* fetchGitInfo(pi)).toEqual({
        branch: undefined,
        changedFiles: 0,
        pullRequest: undefined,
      })
    })
  )
})
