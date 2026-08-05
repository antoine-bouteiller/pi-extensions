import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Data, Effect } from 'effect'

import { emptyGitInfoState, type GitInfoState } from './state.js'

class ExecGitError extends Data.TaggedError('ExecGitError')<{ readonly cause: unknown }> {}

const execGit = (pi: ExtensionAPI, args: string[]) =>
  Effect.tryPromise({ catch: (cause) => new ExecGitError({ cause }), try: () => pi.exec('git', args) })

/** Non-fatal by design: no commits, detached HEAD, or no git at all should degrade to the empty state, not fail the caller. */
export const fetchGitInfo = (pi: ExtensionAPI): Effect.Effect<GitInfoState> =>
  Effect.gen(function* () {
    const [repository, branch, status] = yield* Effect.all(
      [execGit(pi, ['rev-parse', '--is-inside-work-tree']), execGit(pi, ['branch', '--show-current']), execGit(pi, ['status', '--short'])],
      { concurrency: 'unbounded' }
    )
    if (repository.code !== 0 || repository.stdout.trim() !== 'true') {
      return emptyGitInfoState()
    }
    return {
      ...emptyGitInfoState(),
      branch: branch.code === 0 && branch.stdout.trim() !== '' ? branch.stdout.trim() : undefined,
      changedFiles: status.code === 0 && status.stdout.trim() !== '' ? status.stdout.trim().split('\n').length : 0,
    }
  }).pipe(Effect.catchCause(() => Effect.succeed(emptyGitInfoState())))
