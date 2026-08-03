import { homedir, tmpdir } from 'node:os'
import { extname, join, relative, sep } from 'node:path'

import { type ExtensionAPI, type ExtensionContext, type SessionShutdownEvent } from '@earendil-works/pi-coding-agent'
import { Context, Effect, Exit, Option, Ref, Scope, Semaphore } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { makeEventHandler } from '@/shared/effect/runtime.js'

/*
 * Not re-exported from the package root (only from its internal `core/extensions` entry point),
 * so this mirrors the declared shape structurally rather than deep-importing an internal path.
 */
interface ResourcesDiscoverEvent {
  type: 'resources_discover'
  cwd: string
  reason: 'startup' | 'reload'
}

interface ResourcesDiscoverResult {
  skillPaths?: string[]
  promptPaths?: string[]
  themePaths?: string[]
}

interface MarkdownFile {
  path: string
  relativePath: string
}

interface CommandFrontmatter {
  body: string
  description: string
}

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

/**
 * Discovery walks a symlink-tolerant tree, so every risky step (`realPath`, `readDirectory`,
 * `stat`) is swallowed to an `Option` rather than failing the whole scan: a missing directory, a
 * broken symlink, or a permission error just prunes that branch, matching the original try/catch
 * skip-and-continue behaviour. Cycle detection dedupes on the canonical directory path.
 */
const walkCommandDirectory = (root: string, directory: string, visited: Set<string>): Effect.Effect<MarkdownFile[], never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const canonicalDirectory = yield* Effect.option(fs.realPath(directory))
    if (Option.isNone(canonicalDirectory) || visited.has(canonicalDirectory.value)) {
      return []
    }
    visited.add(canonicalDirectory.value)

    const entryNames = yield* Effect.option(fs.readDirectory(directory))
    if (Option.isNone(entryNames)) {
      return []
    }

    const files: MarkdownFile[] = []
    for (const name of entryNames.value.toSorted((left, right) => left.localeCompare(right))) {
      const entryPath = join(directory, name)
      /*
       * `stat` (not `lstat`) already follows symlinks to their real type, so a symlinked file or
       * directory needs no separate branch; a broken symlink simply fails here and is skipped.
       */
      const info = yield* Effect.option(fs.stat(entryPath))
      if (Option.isNone(info)) {
        continue
      }
      if (info.value.type === 'Directory') {
        files.push(...(yield* walkCommandDirectory(root, entryPath, visited)))
      } else if (info.value.type === 'File' && extname(name) === '.md') {
        files.push({ path: entryPath, relativePath: relative(root, entryPath).split(sep).join('/') })
      }
    }
    return files
  })

const discoverMarkdownFiles = (root: string): Effect.Effect<MarkdownFile[], never, FileSystem> => walkCommandDirectory(root, root, new Set())

const unquote = (value: string): string => value.replaceAll(/^["']|["']$/g, '')

/** Convert a Claude command into Agent Skills-compatible metadata and content. */
export const parseCommandFrontmatter = (content: string): CommandFrontmatter => {
  const match = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---\r?\n?/.exec(content)
  const body = match ? content.slice(match[0].length) : content
  const descriptionMatch = match?.groups?.frontmatter.match(/^\s*description\s*:\s*(?<description>.*?)\s*$/m)
  const firstContentLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#+\s*/, '')
  const description = unquote(descriptionMatch?.groups?.description ?? '') || firstContentLine || 'Claude Code command'
  return { body, description: description.slice(0, 1024) }
}

const commandLogicalName = (relativePath: string): string => relativePath.slice(0, -extname(relativePath).length)

const commandSkillName = (relativePath: string): string => {
  const normalized = commandLogicalName(relativePath)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 64)
    .replaceAll(/-+$/g, '')
  return normalized || 'claude-command'
}

interface NamedCommand {
  command: MarkdownFile
  name: string
}

const addNumericSuffix = (name: string, suffix: number): string => {
  const ending = `-${suffix}`
  return `${name.slice(0, 64 - ending.length).replaceAll(/-+$/g, '')}${ending}`
}

const resolveCommandNames = (commandsByLogicalName: Map<string, MarkdownFile>): NamedCommand[] => {
  const commands = [...commandsByLogicalName]
    .map(([logicalName, command]) => ({
      baseName: commandSkillName(command.relativePath),
      command,
      logicalName,
    }))
    .toSorted((left, right) => compareText(left.logicalName, right.logicalName))
  const reservedBaseNames = new Set(commands.map(({ baseName }) => baseName))
  const claimedBaseNames = new Set<string>()
  const usedNames = new Set<string>()

  return commands.map(({ baseName, command }) => {
    let name = baseName
    if (claimedBaseNames.has(baseName)) {
      let suffix = 2
      do {
        name = addNumericSuffix(baseName, suffix++)
      } while (reservedBaseNames.has(name) || usedNames.has(name))
    } else {
      claimedBaseNames.add(baseName)
    }
    usedNames.add(name)
    return { command, name }
  })
}

const formatCommandSkill = (name: string, command: CommandFrontmatter): string => {
  const argumentCompatibility = /\$(?:ARGUMENTS|[1-9]\d*)\b/.exec(command.body)
    ? 'Pi appends invocation arguments as a final `User: <arguments>` line. Treat those arguments as `$ARGUMENTS`, and their shell-style positional words as `$1`, `$2`, and so on. If no `User:` line is present, the arguments are empty.\n\n'
    : ''
  return `---\nname: ${name}\ndescription: ${JSON.stringify(command.description)}\n---\n\n${argumentCompatibility}${command.body}`
}

const buildCommandMap = (
  event: ResourcesDiscoverEvent,
  ctx: ExtensionContext,
  environment: ClaudeCodeEnvironment
): Effect.Effect<Map<string, MarkdownFile>, never, FileSystem> =>
  Effect.gen(function* () {
    /*
     * An identical relative command path denotes the same Claude command, so the project
     * definition intentionally replaces the user definition. Distinct paths that happen to
     * normalize to the same skill name are retained and disambiguated in resolveCommandNames.
     */
    const commandsByLogicalName = new Map<string, MarkdownFile>()
    for (const command of yield* discoverMarkdownFiles(join(environment.homeDirectory, '.claude', 'commands'))) {
      commandsByLogicalName.set(commandLogicalName(command.relativePath), command)
    }
    if (ctx.isProjectTrusted()) {
      for (const command of yield* discoverMarkdownFiles(join(event.cwd, '.claude', 'commands'))) {
        commandsByLogicalName.set(commandLogicalName(command.relativePath), command)
      }
    }
    return commandsByLogicalName
  })

const writeCommandSkills = (
  skillDirectory: string,
  commandsByLogicalName: Map<string, MarkdownFile>
): Effect.Effect<void, PlatformError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    yield* Effect.forEach(
      resolveCommandNames(commandsByLogicalName),
      ({ command, name }) =>
        Effect.gen(function* () {
          const destination = join(skillDirectory, name)
          yield* fs.makeDirectory(destination, { recursive: true })
          const parsed = parseCommandFrontmatter(yield* fs.readFileString(command.path))
          yield* fs.writeFileString(join(destination, 'SKILL.md'), formatCommandSkill(name, parsed))
        }),
      { concurrency: 'unbounded' }
    )
  })

interface DiscoveryStateShape {
  readonly mutex: Semaphore.Semaphore
  readonly activeSkillScope: Ref.Ref<Option.Option<Scope.Closeable>>
}

class DiscoveryState extends Context.Service<DiscoveryState, DiscoveryStateShape>()('@claude-code/DiscoveryState') {}

const releaseActiveSkillDirectory = (state: DiscoveryStateShape): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* Ref.getAndSet(state.activeSkillScope, Option.none())
    if (Option.isSome(current)) {
      yield* Scope.close(current.value, Exit.void)
    }
  })

export interface ClaudeCodeEnvironment {
  homeDirectory: string
  temporaryDirectory: string
}

/**
 * Two different error policies, kept explicit rather than accidental: discovery below is fully
 * swallowed (`buildCommandMap`/`walkCommandDirectory` never fail), while a write failure here
 * must clean up the just-created directory and then rethrow -- `Effect.onError` runs the cleanup
 * only on failure and preserves the original failure afterwards, matching the try/catch/rm/throw
 * this replaces.
 */
const discoverResources = (
  event: ResourcesDiscoverEvent,
  ctx: ExtensionContext,
  environment: ClaudeCodeEnvironment
): Effect.Effect<ResourcesDiscoverResult | undefined, PlatformError, FileSystem | DiscoveryState> =>
  Effect.gen(function* () {
    const state = yield* DiscoveryState
    return yield* state.mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* releaseActiveSkillDirectory(state)

        const commandsByLogicalName = yield* buildCommandMap(event, ctx, environment)
        if (commandsByLogicalName.size === 0) {
          return undefined
        }

        const fs = yield* FileSystem
        const resourceScope = yield* Scope.make()
        const skillDirectory = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ directory: environment.temporaryDirectory, prefix: 'pi-claude-command-skills-' }),
          (directory) => fs.remove(directory, { force: true, recursive: true }).pipe(Effect.orDie)
        ).pipe(Effect.provideService(Scope.Scope, resourceScope))

        yield* Effect.gen(function* () {
          yield* writeCommandSkills(skillDirectory, commandsByLogicalName)
          yield* Ref.set(state.activeSkillScope, Option.some(resourceScope))
        }).pipe(Effect.onError(() => Scope.close(resourceScope, Exit.void)))
        return { skillPaths: [skillDirectory] }
      })
    )
  })

const shutdownDiscoveryResources = (_event: SessionShutdownEvent, _ctx: ExtensionContext): Effect.Effect<void, never, DiscoveryState> =>
  Effect.gen(function* () {
    const state = yield* DiscoveryState
    yield* state.mutex.withPermits(1)(releaseActiveSkillDirectory(state))
  })

export const register = (
  pi: ExtensionAPI,
  runtime: AppRuntime,
  environment: ClaudeCodeEnvironment = { homeDirectory: homedir(), temporaryDirectory: tmpdir() }
): void => {
  const discoveryState: DiscoveryStateShape = Effect.runSync(
    Effect.gen(function* () {
      return {
        activeSkillScope: yield* Ref.make<Option.Option<Scope.Closeable>>(Option.none()),
        mutex: yield* Semaphore.make(1),
      }
    })
  )

  pi.on(
    'resources_discover',
    makeEventHandler(runtime)((event, ctx) => discoverResources(event, ctx, environment).pipe(Effect.provideService(DiscoveryState, discoveryState)))
  )
  pi.on(
    'session_shutdown',
    makeEventHandler(runtime)((event, ctx) => shutdownDiscoveryResources(event, ctx).pipe(Effect.provideService(DiscoveryState, discoveryState)))
  )
}
