import { afterEach } from 'bun:test'
import { tmpdir } from 'node:os'

import { promiseFromEffect, describe, expect, it } from '@tests/utils/bun_effect.js'
import { asResult } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect, FileSystem, Path } from 'effect'

import { parseCommandFrontmatter } from '@/features/claude_code/discovery.js'
import { register as registerClaudeCode } from '@/features/claude_code/index.js'

const pathService = runtime.runSync(Path.Path)
const { dirname, join } = pathService
const chmod = (path: string, mode: number) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.chmod(path, mode)))
const mkdir = (path: string, options?: { recursive?: boolean }) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeDirectory(path, options)))
const mkdtemp = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectory({ directory: pathService.dirname(prefix), prefix: pathService.basename(prefix) }))
  )
const readFile = (path: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(path)))
const readdir = (path: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readDirectory(path)))
const rm = (path: string, options?: { force?: boolean; recursive?: boolean }) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.remove(path, options)))
const stat = (path: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.stat(path)))
const symlink = (fromPath: string, toPath: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.symlink(fromPath, toPath)))
const writeFile = (path: string, data: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.writeFileString(path, data)))

interface DiscoveryResult {
  skillPaths: string[]
}

const fixtureRoots = new Set<string>()

afterEach(() =>
  runtime
    .runPromise(Effect.forEach(fixtureRoots, (root) => rm(root, { force: true, recursive: true }), { concurrency: 'unbounded' }))
    .finally(() => fixtureRoots.clear())
)

const writeFixture = (path: string, content: string) =>
  Effect.gen(function* () {
    yield* mkdir(dirname(path), { recursive: true })
    yield* writeFile(path, content)
  })

const createFixture = Effect.gen(function* () {
  const root = yield* mkdtemp(join(tmpdir(), 'pi-claude-code-test-'))
  fixtureRoots.add(root)
  const homeDirectory = join(root, 'home')
  const projectDirectory = join(root, 'project')
  const temporaryDirectory = join(root, 'temp')
  yield* Effect.all(
    [mkdir(homeDirectory, { recursive: true }), mkdir(projectDirectory, { recursive: true }), mkdir(temporaryDirectory, { recursive: true })],
    { concurrency: 'unbounded' }
  )

  const fakePi = createFakePi()
  registerClaudeCode(fakePi.pi, runtime, { homeDirectory, temporaryDirectory })

  const context = (trusted: boolean) => ({
    cwd: projectDirectory,
    isProjectTrusted: () => trusted,
  })
  const invoke = <Result>(name: string, event: unknown, eventContext: unknown): Promise<Result> =>
    promiseFromEffect(Effect.promise(() => fakePi.emit(name, event, eventContext)).pipe(Effect.map((results) => asResult<Result>(results[0]))))

  return { context, homeDirectory, invoke, projectDirectory, temporaryDirectory }
})

const generatedSkills = (skillDirectory: string) =>
  Effect.gen(function* () {
    const names = (yield* readdir(skillDirectory)).toSorted()
    const entries = yield* Effect.forEach(
      names,
      (name) => readFile(join(skillDirectory, name, 'SKILL.md')).pipe(Effect.map((content) => [name, content] as const)),
      { concurrency: 'unbounded' }
    )
    return new Map(entries)
  })

const pathExists = (path: string) => stat(path).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))

describe('Claude Code compatibility', () => {
  it.effect('converts command metadata and derives a fallback description', () =>
    Effect.sync(() => {
      expect(parseCommandFrontmatter("---\ndescription: 'Review this diff'\n---\nDo it")).toEqual({
        body: 'Do it',
        description: 'Review this diff',
      })
      expect(parseCommandFrontmatter('# Deploy safely\n\nRun checks.').description).toBe('Deploy safely')
    })
  )

  it.effect('discovers project commands only for trusted projects', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      yield* Effect.all(
        [
          writeFixture(join(fixture.homeDirectory, '.claude/commands/deploy.md'), 'User deploy'),
          writeFixture(join(fixture.projectDirectory, '.claude/commands/deploy.md'), 'Project deploy'),
          writeFixture(join(fixture.projectDirectory, '.claude/commands/project-only.md'), 'Project only'),
        ],
        { concurrency: 'unbounded' }
      )

      const untrustedResult = yield* Effect.promise(() =>
        fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, fixture.context(false))
      )
      const untrustedSkills = yield* generatedSkills(untrustedResult.skillPaths[0])
      expect([...untrustedSkills.keys()]).toEqual(['deploy'])
      expect(untrustedSkills.get('deploy')).toContain('User deploy')

      const trustedResult = yield* Effect.promise(() =>
        fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, fixture.context(true))
      )
      const trustedSkills = yield* generatedSkills(trustedResult.skillPaths[0])
      expect([...trustedSkills.keys()]).toEqual(['deploy', 'project-only'])
      expect(trustedSkills.get('deploy')).toContain('Project deploy')
      expect(trustedSkills.get('deploy')).not.toContain('User deploy')
    })
  )

  it.effect('retains normalized name collisions deterministically, including long names', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      const commandsDirectory = join(fixture.homeDirectory, '.claude/commands')
      const longPrefix = 'a'.repeat(70)
      yield* Effect.all(
        [
          writeFixture(join(commandsDirectory, 'foo-bar.md'), 'User hyphen'),
          writeFixture(join(commandsDirectory, 'foo-bar-2.md'), 'Reserved suffix'),
          writeFixture(join(commandsDirectory, 'foo_bar.md'), 'Underscore'),
          writeFixture(join(commandsDirectory, `${longPrefix}-one.md`), 'Long one'),
          writeFixture(join(commandsDirectory, `${longPrefix}-two.md`), 'Long two'),
          writeFixture(join(fixture.projectDirectory, '.claude/commands/foo-bar.md'), 'Project hyphen'),
        ],
        { concurrency: 'unbounded' }
      )

      const result = yield* Effect.promise(() =>
        fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, fixture.context(true))
      )
      const skills = yield* generatedSkills(result.skillPaths[0])
      const names = [...skills.keys()]

      expect(names).toHaveLength(5)
      expect(names).toContain('foo-bar')
      expect(names).toContain('foo-bar-2')
      expect(names).toContain('foo-bar-3')
      expect(skills.get('foo-bar')).toContain('Project hyphen')
      expect(skills.get('foo-bar')).not.toContain('User hyphen')
      expect(skills.get('foo-bar-2')).toContain('Reserved suffix')
      expect(skills.get('foo-bar-3')).toContain('Underscore')

      const longNames = names.filter((name) => name.startsWith('a'))
      expect(longNames).toHaveLength(2)
      expect(new Set(longNames).size).toBe(2)
      expect(longNames.every((name) => name.length <= 64)).toBeTrue()
      expect(longNames.map((name) => skills.get(name)).join('\n')).toContain('Long one')
      expect(longNames.map((name) => skills.get(name)).join('\n')).toContain('Long two')

      const repeatedResult = yield* Effect.promise(() =>
        fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, fixture.context(true))
      )
      const repeatedSkills = yield* generatedSkills(repeatedResult.skillPaths[0])
      expect([...repeatedSkills.keys()]).toEqual(names)
    })
  )

  it.effect('follows symlinks without looping on a cycle or a broken link', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      const commandsDirectory = join(fixture.homeDirectory, '.claude/commands')
      yield* writeFixture(join(commandsDirectory, 'safe.md'), 'Safe command')
      yield* Effect.all(
        [
          symlink(join(commandsDirectory, 'safe.md'), join(commandsDirectory, 'alias.md')),
          symlink(commandsDirectory, join(commandsDirectory, 'cycle')),
          symlink(join(commandsDirectory, 'missing.md'), join(commandsDirectory, 'broken.md')),
        ],
        { concurrency: 'unbounded' }
      )

      const result = yield* Effect.promise(() =>
        fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, fixture.context(false))
      )
      const skills = yield* generatedSkills(result.skillPaths[0])
      expect([...skills.keys()]).toEqual(['alias', 'safe'])
      expect(skills.get('alias')).toContain('Safe command')
      expect(skills.get('safe')).toContain('Safe command')
    })
  )

  it.effect('cleans replaced generated skills and removes the active directory on shutdown', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      yield* writeFixture(join(fixture.homeDirectory, '.claude/commands/clean.md'), 'Clean me')
      const context = fixture.context(false)

      const firstResult = yield* Effect.promise(() =>
        fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, context)
      )
      const [firstDirectory] = firstResult.skillPaths
      expect(yield* pathExists(firstDirectory)).toBeTrue()

      const secondResult = yield* Effect.promise(() =>
        fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, context)
      )
      const [secondDirectory] = secondResult.skillPaths
      expect(secondDirectory).not.toBe(firstDirectory)
      expect(yield* pathExists(firstDirectory)).toBeFalse()
      expect(yield* pathExists(secondDirectory)).toBeTrue()

      yield* Effect.promise(() => fixture.invoke('session_shutdown', {}, context))
      expect(yield* pathExists(secondDirectory)).toBeFalse()
    })
  )

  it.effect('serializes concurrent discovery and cleans every superseded directory', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      yield* writeFixture(join(fixture.homeDirectory, '.claude/commands/concurrent.md'), 'Run once')
      const context = fixture.context(false)

      const [firstResult, secondResult] = yield* Effect.promise(() =>
        Promise.all([
          fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, context),
          fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, context),
        ])
      )
      const [firstDirectory] = firstResult.skillPaths
      const [secondDirectory] = secondResult.skillPaths

      expect(firstDirectory).not.toBe(secondDirectory)
      expect(yield* pathExists(firstDirectory)).toBeFalse()
      expect(yield* pathExists(secondDirectory)).toBeTrue()

      yield* Effect.promise(() => fixture.invoke('session_shutdown', {}, context))
      expect(yield* pathExists(secondDirectory)).toBeFalse()
    })
  )

  it.effect.skipIf(process.getuid?.() === 0)('cleans up the generated skill directory and rethrows when a command cannot be read', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      const commandPath = join(fixture.homeDirectory, '.claude/commands/broken.md')
      yield* writeFixture(commandPath, 'Broken command')
      yield* chmod(commandPath, 0o000)

      const rejection = yield* Effect.promise(() =>
        fixture.invoke('resources_discover', { cwd: fixture.projectDirectory }, fixture.context(false)).then(
          () => undefined,
          (error: unknown) => error
        )
      )

      yield* chmod(commandPath, 0o600)
      expect(rejection).toBeInstanceOf(Error)
      expect(yield* readdir(fixture.temporaryDirectory)).toEqual([])
    })
  )
})
