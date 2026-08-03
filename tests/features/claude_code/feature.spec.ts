import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { asResult } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'

import { parseCommandFrontmatter, register as registerClaudeCode } from '@/features/claude_code/feature.js'

interface DiscoveryResult {
  skillPaths: string[]
}

const fixtureRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { force: true, recursive: true })))
  fixtureRoots.clear()
})

const writeFixture = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-claude-code-test-'))
  fixtureRoots.add(root)
  const homeDirectory = join(root, 'home')
  const projectDirectory = join(root, 'project')
  const temporaryDirectory = join(root, 'temp')
  await Promise.all([
    mkdir(homeDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
    mkdir(temporaryDirectory, { recursive: true }),
  ])

  const fakePi = createFakePi()
  registerClaudeCode(fakePi.pi, runtime, { homeDirectory, temporaryDirectory })

  const context = (trusted: boolean) => ({
    cwd: projectDirectory,
    isProjectTrusted: () => trusted,
  })
  const invoke = async <Result>(name: string, event: unknown, eventContext: unknown) => {
    const results = await fakePi.emit(name, event, eventContext)
    return asResult<Result>(results[0])
  }

  return { context, homeDirectory, invoke, projectDirectory, temporaryDirectory }
}

const generatedSkills = async (skillDirectory: string): Promise<Map<string, string>> => {
  const entries = await readdir(skillDirectory)
  const names = entries.toSorted()
  return new Map(await Promise.all(names.map(async (name) => [name, await readFile(join(skillDirectory, name, 'SKILL.md'), 'utf8')] as const)))
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('Claude Code compatibility', () => {
  test('converts command metadata and derives a fallback description', () => {
    expect(parseCommandFrontmatter("---\ndescription: 'Review this diff'\n---\nDo it")).toEqual({
      body: 'Do it',
      description: 'Review this diff',
    })
    expect(parseCommandFrontmatter('# Deploy safely\n\nRun checks.').description).toBe('Deploy safely')
  })

  test('discovers project commands only for trusted projects', async () => {
    const fixture = await createFixture()
    await Promise.all([
      writeFixture(join(fixture.homeDirectory, '.claude/commands/deploy.md'), 'User deploy'),
      writeFixture(join(fixture.projectDirectory, '.claude/commands/deploy.md'), 'Project deploy'),
      writeFixture(join(fixture.projectDirectory, '.claude/commands/project-only.md'), 'Project only'),
    ])

    const untrustedResult = await fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, fixture.context(false))
    const untrustedSkills = await generatedSkills(untrustedResult.skillPaths[0])
    expect([...untrustedSkills.keys()]).toEqual(['deploy'])
    expect(untrustedSkills.get('deploy')).toContain('User deploy')

    const trustedResult = await fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, fixture.context(true))
    const trustedSkills = await generatedSkills(trustedResult.skillPaths[0])
    expect([...trustedSkills.keys()]).toEqual(['deploy', 'project-only'])
    expect(trustedSkills.get('deploy')).toContain('Project deploy')
    expect(trustedSkills.get('deploy')).not.toContain('User deploy')
  })

  test('retains normalized name collisions deterministically, including long names', async () => {
    const fixture = await createFixture()
    const commandsDirectory = join(fixture.homeDirectory, '.claude/commands')
    const longPrefix = 'a'.repeat(70)
    await Promise.all([
      writeFixture(join(commandsDirectory, 'foo-bar.md'), 'User hyphen'),
      writeFixture(join(commandsDirectory, 'foo-bar-2.md'), 'Reserved suffix'),
      writeFixture(join(commandsDirectory, 'foo_bar.md'), 'Underscore'),
      writeFixture(join(commandsDirectory, `${longPrefix}-one.md`), 'Long one'),
      writeFixture(join(commandsDirectory, `${longPrefix}-two.md`), 'Long two'),
      writeFixture(join(fixture.projectDirectory, '.claude/commands/foo-bar.md'), 'Project hyphen'),
    ])

    const result = await fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, fixture.context(true))
    const skills = await generatedSkills(result.skillPaths[0])
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

    const repeatedResult = await fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, fixture.context(true))
    const repeatedSkills = await generatedSkills(repeatedResult.skillPaths[0])
    expect([...repeatedSkills.keys()]).toEqual(names)
  })

  test('follows command symlinks and stops directory cycles safely', async () => {
    const fixture = await createFixture()
    const commandsDirectory = join(fixture.homeDirectory, '.claude/commands')
    const outsideDirectory = join(fixture.homeDirectory, 'outside')
    await Promise.all([
      writeFixture(join(commandsDirectory, 'safe.md'), 'Safe command'),
      writeFixture(join(outsideDirectory, 'escaped.md'), 'Escaped command'),
    ])
    await Promise.all([
      symlink(join(commandsDirectory, 'safe.md'), join(commandsDirectory, 'alias.md'), 'file'),
      symlink(commandsDirectory, join(commandsDirectory, 'cycle'), 'dir'),
      symlink(outsideDirectory, join(commandsDirectory, 'escape'), 'dir'),
      symlink(join(outsideDirectory, 'missing.md'), join(commandsDirectory, 'missing.md'), 'file'),
    ])

    const result = await fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, fixture.context(false))
    const skills = await generatedSkills(result.skillPaths[0])
    expect([...skills.keys()]).toEqual(['alias', 'escape-escaped', 'safe'])
    expect(skills.get('alias')).toContain('Safe command')
    expect(skills.get('escape-escaped')).toContain('Escaped command')
    expect(skills.get('safe')).toContain('Safe command')
  })

  test('cleans replaced generated skills and removes the active directory on shutdown', async () => {
    const fixture = await createFixture()
    await writeFixture(join(fixture.homeDirectory, '.claude/commands/clean.md'), 'Clean me')
    const context = fixture.context(false)

    const firstResult = await fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, context)
    const [firstDirectory] = firstResult.skillPaths
    expect(await pathExists(firstDirectory)).toBeTrue()

    const secondResult = await fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, context)
    const [secondDirectory] = secondResult.skillPaths
    expect(secondDirectory).not.toBe(firstDirectory)
    expect(await pathExists(firstDirectory)).toBeFalse()
    expect(await pathExists(secondDirectory)).toBeTrue()

    await fixture.invoke('session_shutdown', {}, context)
    expect(await pathExists(secondDirectory)).toBeFalse()
  })

  test('serializes concurrent discovery and cleans every superseded directory', async () => {
    const fixture = await createFixture()
    await writeFixture(join(fixture.homeDirectory, '.claude/commands/concurrent.md'), 'Run once')
    const context = fixture.context(false)

    const [firstResult, secondResult] = await Promise.all([
      fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, context),
      fixture.invoke<DiscoveryResult>('resources_discover', { cwd: fixture.projectDirectory }, context),
    ])
    const [firstDirectory] = firstResult.skillPaths
    const [secondDirectory] = secondResult.skillPaths

    expect(firstDirectory).not.toBe(secondDirectory)
    expect(await pathExists(firstDirectory)).toBeFalse()
    expect(await pathExists(secondDirectory)).toBeTrue()

    await fixture.invoke('session_shutdown', {}, context)
    expect(await pathExists(secondDirectory)).toBeFalse()
  })

  test.skipIf(process.getuid?.() === 0)('cleans up the generated skill directory and rethrows when a command cannot be read', async () => {
    const fixture = await createFixture()
    const commandPath = join(fixture.homeDirectory, '.claude/commands/broken.md')
    await writeFixture(commandPath, 'Broken command')
    await chmod(commandPath, 0o000)

    let rejection: unknown
    try {
      await fixture.invoke('resources_discover', { cwd: fixture.projectDirectory }, fixture.context(false))
    } catch (error) {
      rejection = error
    }

    await chmod(commandPath, 0o600)
    expect(rejection).toBeInstanceOf(Error)
    expect(await readdir(fixture.temporaryDirectory)).toEqual([])
  })
})
