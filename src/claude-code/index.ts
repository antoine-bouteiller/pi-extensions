import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { extname, join, relative, sep } from 'node:path'

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

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

const discoverMarkdownFiles = async (root: string): Promise<MarkdownFile[]> => {
  const files: MarkdownFile[] = []
  const visitedDirectories = new Set<string>()

  const walk = async (directory: string): Promise<void> => {
    let canonicalDirectory: string
    try {
      canonicalDirectory = await realpath(directory)
    } catch {
      return
    }

    if (visitedDirectories.has(canonicalDirectory)) {
      return
    }
    visitedDirectories.add(canonicalDirectory)

    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      const path = join(directory, entry.name)
      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()

      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(path)
          isDirectory = target.isDirectory()
          isFile = target.isFile()
        } catch {
          continue
        }
      }

      if (isDirectory) {
        await walk(path)
      } else if (isFile && extname(entry.name) === '.md') {
        files.push({ path, relativePath: relative(root, path).split(sep).join('/') })
      }
    }
  }

  await walk(root)
  return files
}

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

export interface ClaudeCodeEnvironment {
  homeDirectory: string
  temporaryDirectory: string
}

export default function claudeCodeExtension(
  pi: ExtensionAPI,
  environment: ClaudeCodeEnvironment = {
    homeDirectory: homedir(),
    temporaryDirectory: tmpdir(),
  }
) {
  let generatedSkillDirectory: string | undefined
  let discoveryQueue: Promise<void> = Promise.resolve()

  const serializeDiscovery = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = discoveryQueue.then(operation)
    discoveryQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  const cleanup = async (): Promise<void> => {
    if (!generatedSkillDirectory) {
      return
    }
    const directory = generatedSkillDirectory
    generatedSkillDirectory = undefined
    await rm(directory, { force: true, recursive: true })
  }

  pi.on('resources_discover', (event, ctx) =>
    serializeDiscovery(async () => {
      await cleanup()

      // An identical relative command path denotes the same Claude command, so the
      // Project definition intentionally replaces the user definition. Distinct paths
      // That happen to normalize to the same skill name are retained and disambiguated.
      const commandsByLogicalName = new Map<string, MarkdownFile>()
      for (const command of await discoverMarkdownFiles(join(environment.homeDirectory, '.claude', 'commands'))) {
        commandsByLogicalName.set(commandLogicalName(command.relativePath), command)
      }

      if (ctx.isProjectTrusted()) {
        for (const command of await discoverMarkdownFiles(join(event.cwd, '.claude', 'commands'))) {
          commandsByLogicalName.set(commandLogicalName(command.relativePath), command)
        }
      }

      if (commandsByLogicalName.size === 0) {
        return undefined
      }

      const skillDirectory = await mkdtemp(join(environment.temporaryDirectory, 'pi-claude-command-skills-'))

      try {
        await Promise.all(
          resolveCommandNames(commandsByLogicalName).map(async ({ name, command }) => {
            const destination = join(skillDirectory, name)
            await mkdir(destination, { recursive: true })
            const parsed = parseCommandFrontmatter(await readFile(command.path, 'utf8'))
            await writeFile(join(destination, 'SKILL.md'), formatCommandSkill(name, parsed), 'utf8')
          })
        )
      } catch (error) {
        await rm(skillDirectory, { force: true, recursive: true })
        throw error
      }

      generatedSkillDirectory = skillDirectory
      return { skillPaths: [skillDirectory] }
    })
  )

  pi.on('session_shutdown', () => serializeDiscovery(cleanup))
}
