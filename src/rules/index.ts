import { createHash } from 'node:crypto'
import { type Dirent } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { type ExtensionAPI, type ToolResultEvent } from '@earendil-works/pi-coding-agent'

const RULE_DIRECTORIES = ['.claude/rules', '.agents/rules'] as const
const RULE_EXTENSIONS = new Set(['.md', '.mdc'])
const EXCLUDED_DIRECTORIES = new Set(['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules'])
const MAX_SCAN_DEPTH = 10
const MAX_RULE_CHARS = 12_000
const MAX_BLOCK_CHARS = 40_000

interface RuleFile {
  path: string
  realPath: string
  relativePath: string
}

interface Rule {
  realPath: string
  displayPath: string
  body: string
  paths: string[]
  alwaysApply: boolean
  contentHash: string
}

interface FormattedRules {
  block: string
  emitted: Rule[]
}

export interface RuleFrontmatter {
  body: string
  paths: string[]
  alwaysApply: boolean
  diagnostic?: string
}

export interface RulesEnvironment {
  homeDirectory: string
}

const normalizePath = (path: string): string => path.replaceAll('\\', '/').replace(/^\.\//, '')

const isWithin = (child: string, parent: string): boolean => {
  const pathFromParent = relative(parent, child)
  return pathFromParent === '' || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent))
}

interface ResolvedEntry {
  path: string
  canonicalPath: string
  isDirectory: boolean
  isFile: boolean
}

const resolveEntry = async (directory: string, entry: Dirent, canonicalBoundary: string | undefined): Promise<ResolvedEntry | undefined> => {
  const path = join(directory, entry.name)
  let isDirectory = entry.isDirectory()
  let isFile = entry.isFile()
  let canonicalPath = path

  if (entry.isSymbolicLink()) {
    try {
      canonicalPath = await realpath(path)
      if (canonicalBoundary && !isWithin(canonicalPath, canonicalBoundary)) {
        return undefined
      }
      const target = await stat(path)
      isDirectory = target.isDirectory()
      isFile = target.isFile()
    } catch {
      return undefined
    }
  }

  return { canonicalPath, isDirectory, isFile, path }
}

const registerRuleFile = async (options: { root: string; path: string; canonicalBoundary: string | undefined; files: RuleFile[] }): Promise<void> => {
  const { root, path, canonicalBoundary, files } = options
  let canonicalPath: string
  try {
    canonicalPath = await realpath(path)
  } catch {
    return
  }
  if (canonicalBoundary && !isWithin(canonicalPath, canonicalBoundary)) {
    return
  }
  files.push({
    path,
    realPath: canonicalPath,
    relativePath: normalizePath(relative(root, path)),
  })
}

const discoverRuleFiles = async (root: string, containmentRoot?: string): Promise<RuleFile[]> => {
  let canonicalRoot: string
  let canonicalBoundary: string | undefined
  try {
    canonicalRoot = await realpath(root)
    canonicalBoundary = containmentRoot ? await realpath(containmentRoot) : undefined
    const rootStat = await stat(canonicalRoot)
    if (!rootStat.isDirectory()) {
      return []
    }
    if (canonicalBoundary && !isWithin(canonicalRoot, canonicalBoundary)) {
      return []
    }
  } catch {
    return []
  }

  const files: RuleFile[] = []
  const visitedDirectories = new Set<string>()

  const walk = async (directory: string, depth: number): Promise<void> => {
    let canonicalDirectory: string
    try {
      canonicalDirectory = await realpath(directory)
    } catch {
      return
    }

    if ((canonicalBoundary && !isWithin(canonicalDirectory, canonicalBoundary)) || visitedDirectories.has(canonicalDirectory)) {
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
      const resolved = await resolveEntry(directory, entry, canonicalBoundary)
      if (!resolved) {
        continue
      }
      const { path, isDirectory, isFile } = resolved

      if (isDirectory) {
        if (depth < MAX_SCAN_DEPTH && !EXCLUDED_DIRECTORIES.has(entry.name)) {
          await walk(path, depth + 1)
        }
      } else if (isFile && RULE_EXTENSIONS.has(extname(entry.name))) {
        await registerRuleFile({ canonicalBoundary, files, path, root })
      }
    }
  }

  await walk(root, 0)
  return files
}

const stripComment = (value: string): string => {
  let quote: '"' | "'" | undefined
  let escaped = false

  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === '"' && character === '\\') {
      escaped = true
      continue
    }
    if (character === '"' || character === "'") {
      if (quote === character) {
        quote = undefined
      } else if (quote === undefined) {
        quote = character
      }
      continue
    }
    if (character === '#' && quote === undefined) {
      return value.slice(0, index)
    }
  }

  return value
}

const parseString = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }
  if (trimmed.startsWith('"')) {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'string') {
      throw new Error('expected a string')
    }
    return parsed
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length === 1) {
      throw new Error('unclosed quote')
    }
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  return trimmed
}

const splitInlineList = (value: string): string[] => {
  if (!value.endsWith(']')) {
    throw new Error('unclosed inline list')
  }
  const content = value.slice(1, -1)
  const entries: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false

  for (const character of content) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (quote === '"' && character === '\\') {
      current += character
      escaped = true
      continue
    }
    if (character === '"' || character === "'") {
      if (quote === character) {
        quote = undefined
      } else if (quote === undefined) {
        quote = character
      }
      current += character
      continue
    }
    if (character === ',' && quote === undefined) {
      entries.push(parseString(current))
      current = ''
      continue
    }
    current += character
  }

  if (quote !== undefined) {
    throw new Error('unclosed quote')
  }
  entries.push(parseString(current))
  return entries.filter(Boolean)
}

const parsePathValue = (rawValue: string, lines: string[], lineIndex: number): { paths: string[]; consumed: number } => {
  if (rawValue.startsWith('[')) {
    return { consumed: 1, paths: splitInlineList(rawValue) }
  }
  if (rawValue) {
    const value = parseString(rawValue)
    return {
      consumed: 1,
      paths: value
        .split(',')
        .map((path) => path.trim())
        .filter(Boolean),
    }
  }

  const paths: string[] = []
  let consumed = 1
  for (let index = lineIndex + 1; index < lines.length; index++) {
    const line = stripComment(lines[index] ?? '')
    if (!line.trim()) {
      consumed++
      continue
    }
    const match = /^\s+-\s*(?<item>.*)$/.exec(line)
    if (!match) {
      break
    }
    paths.push(parseString(match.groups?.item ?? ''))
    consumed++
  }
  return { consumed, paths: paths.filter(Boolean) }
}

interface FrontmatterLineResult {
  consumed: number
  paths?: string[]
  alwaysApply?: boolean
}

const parseFrontmatterLine = (lines: string[], index: number): FrontmatterLineResult => {
  const line = stripComment(lines[index] ?? '').trim()
  if (!line) {
    return { consumed: 1 }
  }

  const separator = line.indexOf(':')
  if (separator === -1) {
    throw new Error(`expected key-value pair on line ${index + 1}`)
  }
  const key = line.slice(0, separator).trim()
  const value = line.slice(separator + 1).trim()

  if (key === 'paths' || key === 'globs') {
    const parsed = parsePathValue(value, lines, index)
    return { consumed: parsed.consumed, paths: parsed.paths }
  }
  if (key === 'alwaysApply') {
    if (value !== 'true' && value !== 'false') {
      throw new Error('alwaysApply must be boolean')
    }
    return { alwaysApply: value === 'true', consumed: 1 }
  }
  return { consumed: 1 }
}

/** Parse the supported Claude-style rule frontmatter without requiring a YAML dependency. */
export const parseRuleFrontmatter = (content: string): RuleFrontmatter => {
  const normalized = content.startsWith('\uFEFF') ? content.slice(1) : content
  if (!/^---\r?\n/.test(normalized)) {
    return { alwaysApply: false, body: normalized, paths: [] }
  }

  const match = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized)
  if (!match) {
    return {
      alwaysApply: false,
      body: normalized,
      diagnostic: 'Missing closing frontmatter delimiter',
      paths: [],
    }
  }

  try {
    const lines = (match.groups?.frontmatter ?? '').replaceAll('\r\n', '\n').split('\n')
    const paths: string[] = []
    let alwaysApply = false

    for (let index = 0; index < lines.length;) {
      const result = parseFrontmatterLine(lines, index)
      if (result.paths) {
        for (const path of result.paths) {
          if (!paths.includes(path)) {
            paths.push(path)
          }
        }
      }
      const { alwaysApply: parsedAlwaysApply } = result
      if (parsedAlwaysApply !== undefined) {
        alwaysApply = parsedAlwaysApply
      }
      index += result.consumed
    }

    const [fullMatch] = match
    return {
      alwaysApply,
      body: normalized.slice(fullMatch.length),
      paths,
    }
  } catch (error) {
    return {
      alwaysApply: false,
      body: normalized,
      diagnostic: error instanceof Error ? `Malformed frontmatter: ${error.message}` : 'Malformed frontmatter',
      paths: [],
    }
  }
}

const contentHash = (content: string): string => createHash('sha256').update(content).digest('hex')

const readRules = async (root: string, displayRoot: string, containmentRoot?: string): Promise<Rule[]> => {
  const rules: Rule[] = []
  for (const file of await discoverRuleFiles(root, containmentRoot)) {
    try {
      const content = await readFile(file.path, 'utf8')
      const parsed = parseRuleFrontmatter(content)
      if (parsed.diagnostic || !parsed.body.trim()) {
        continue
      }
      rules.push({
        alwaysApply: parsed.alwaysApply,
        body: parsed.body.trim(),
        contentHash: contentHash(content),
        displayPath: `${displayRoot}/${file.relativePath}`,
        paths: parsed.paths,
        realPath: file.realPath,
      })
    } catch {
      // An unreadable or malformed rule must not prevent other rules from loading.
    }
  }
  return rules
}

const discoverRules = async (cwd: string, trusted: boolean, homeDirectory: string): Promise<Rule[]> => {
  const groups: Rule[][] = []
  // Global guidance comes first so the shared prompt budget cannot starve it;
  // Project guidance remains later in the prompt and can refine it.
  for (const directory of RULE_DIRECTORIES) {
    groups.push(await readRules(join(homeDirectory, directory), `~/${directory}`))
  }
  if (trusted) {
    for (const directory of RULE_DIRECTORIES) {
      groups.push(await readRules(join(cwd, directory), directory, cwd))
    }
  }

  const rules: Rule[] = []
  const seen = new Set<string>()
  for (const rule of groups.flat()) {
    if (seen.has(rule.realPath)) {
      continue
    }
    seen.add(rule.realPath)
    rules.push(rule)
  }
  return rules
}

const truncateBody = (rule: Rule, maxChars: number): string => {
  if (rule.body.length <= maxChars) {
    return rule.body
  }
  const notice = `\n\n[Rule truncated. Read full rule: ${rule.displayPath}]`
  const end = Math.max(0, maxChars - notice.length)
  const safeEnd = /[\uD800-\uDBFF]/.test(rule.body.at(end - 1) ?? '') ? end - 1 : end
  return `${rule.body.slice(0, safeEnd)}${notice}`
}

const formatRules = (rules: Rule[], header: string): FormattedRules => {
  let block = header
  const emitted: Rule[] = []

  for (const rule of rules) {
    const body = truncateBody(rule, MAX_RULE_CHARS)
    const formatted = `${emitted.length === 0 ? '' : '\n\n'}Instructions from: ${rule.displayPath}\n${body}`
    const remaining = MAX_BLOCK_CHARS - block.length
    if (remaining <= 0) {
      break
    }
    if (formatted.length <= remaining) {
      block += formatted
      emitted.push(rule)
      continue
    }

    const notice = `\n\n[Rule truncated. Read full rule: ${rule.displayPath}]`
    if (remaining <= notice.length) {
      break
    }
    block += `${formatted.slice(0, remaining - notice.length)}${notice}`
    emitted.push(rule)
    break
  }

  return { block: emitted.length === 0 ? '' : block, emitted }
}

const formatRulePointers = (rules: Rule[], maxChars: number): string => {
  if (rules.length === 0 || maxChars <= 0) {
    return ''
  }
  const header =
    '\n\n## Path-scoped rules\n\nThese rules are injected automatically after a matching file tool result. Read one proactively when its scope covers work you are about to do:\n\n'
  if (header.length >= maxChars) {
    return ''
  }
  let block = header
  let count = 0

  for (const rule of rules) {
    const line = `${count === 0 ? '' : '\n'}- ${rule.displayPath} — applies to: ${rule.paths.join(', ')}`
    if (block.length + line.length > maxChars) {
      break
    }
    block += line
    count++
  }

  return count === 0 ? '' : block
}

const matchesRule = (rule: Rule, targetPath: string, cwd: string): boolean => {
  if (rule.alwaysApply || rule.paths.length === 0) {
    return true
  }
  const absoluteTarget = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath)
  const projectRelative = normalizePath(relative(cwd, absoluteTarget))
  const basename = projectRelative.split('/').at(-1) ?? projectRelative
  const pathBases = [projectRelative, basename]
  const positives = rule.paths.filter((pattern) => !pattern.startsWith('!'))
  const negatives = rule.paths.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1))

  try {
    const excluded = negatives.some((pattern) => {
      const glob = new Bun.Glob(normalizePath(pattern))
      return pathBases.some((path) => glob.match(path))
    })
    if (excluded) {
      return false
    }
    if (positives.length === 0) {
      return true
    }
    return positives.some((pattern) => {
      const glob = new Bun.Glob(normalizePath(pattern).replace(/^\//, ''))
      return pathBases.some((path) => glob.match(path))
    })
  } catch {
    return false
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

const stringProperty = (value: unknown, property: string): string | undefined => {
  const candidate = record(value)?.[property]
  return typeof candidate === 'string' && candidate ? candidate : undefined
}

/** Extract paths from Pi's file tools, including the local hashline compatibility tools. */
export const extractToolPaths = (event: ToolResultEvent, cwd: string): string[] => {
  if (event.isError || !['read', 'edit', 'write', 'hashline_read', 'hashline_write'].includes(event.toolName)) {
    return []
  }

  const paths = new Set<string>()
  const add = (path: string | undefined) => {
    if (path) {
      paths.add(isAbsolute(path) ? path : resolve(cwd, path))
    }
  }
  add(stringProperty(event.input, 'path'))
  add(stringProperty(event.input, 'filePath'))
  add(stringProperty(event.details, 'filePath'))

  if (event.toolName === 'hashline_write') {
    const patch = stringProperty(event.input, 'patch')
    if (patch) {
      for (const match of patch.matchAll(/^\[(?<path>[^\]#]+)#[^\]]+\]/gm)) {
        add(match.groups?.path)
      }
    }

    const sections = record(event.details)?.sections
    if (Array.isArray(sections)) {
      for (const section of sections) {
        add(stringProperty(section, 'path'))
        add(stringProperty(section, 'canonicalPath'))
        add(stringProperty(section, 'moveDest'))
      }
    }
  }

  return [...paths]
}

export default function rulesExtension(pi: ExtensionAPI, environment: RulesEnvironment = { homeDirectory: homedir() }) {
  const dynamicInjections = new Set<string>()
  let activeDiscovery: { key: string; promise: Promise<Rule[]> } | undefined

  const refresh = async (cwd: string, trusted: boolean): Promise<Rule[]> => {
    const key = `${cwd}\0${trusted}`
    if (activeDiscovery?.key === key) {
      return activeDiscovery.promise
    }

    const promise = discoverRules(cwd, trusted, environment.homeDirectory)
    activeDiscovery = { key, promise }
    try {
      return await promise
    } finally {
      if (activeDiscovery?.promise === promise) {
        activeDiscovery = undefined
      }
    }
  }

  pi.on('session_start', () => {
    dynamicInjections.clear()
  })

  pi.on('session_compact', () => {
    dynamicInjections.clear()
  })

  pi.on('session_tree', () => {
    dynamicInjections.clear()
  })

  pi.on('before_agent_start', async (event, ctx) => {
    const rules = await refresh(ctx.cwd, ctx.isProjectTrusted())
    const staticRules = rules.filter((rule) => rule.alwaysApply || rule.paths.length === 0)
    const formatted = formatRules(staticRules, '\n\n## Rules\n\n')
    let addition = formatted.block
    const scopedRules = rules.filter((rule) => !rule.alwaysApply && rule.paths.length > 0)
    addition += formatRulePointers(scopedRules, MAX_BLOCK_CHARS - addition.length)
    return addition ? { systemPrompt: event.systemPrompt + addition } : undefined
  })

  pi.on('tool_result', async (event, ctx) => {
    const targetPaths = extractToolPaths(event, ctx.cwd)
    if (targetPaths.length === 0) {
      return
    }

    const rules = await refresh(ctx.cwd, ctx.isProjectTrusted())
    const pendingTargetsByRule = new Map<Rule, string[]>()
    for (const rule of rules) {
      if (rule.alwaysApply || rule.paths.length === 0) {
        continue
      }
      const pendingTargets = targetPaths.filter(
        (target) => matchesRule(rule, target, ctx.cwd) && !dynamicInjections.has(`${target}\0${rule.realPath}\0${rule.contentHash}`)
      )
      if (pendingTargets.length > 0) {
        pendingTargetsByRule.set(rule, pendingTargets)
      }
    }

    const displayTarget = normalizePath(relative(ctx.cwd, targetPaths[0] ?? ctx.cwd))
    const formatted = formatRules([...pendingTargetsByRule.keys()], `\n\nAdditional rules matched for ${displayTarget}:\n\n`)
    for (const rule of formatted.emitted) {
      for (const target of pendingTargetsByRule.get(rule) ?? []) {
        dynamicInjections.add(`${target}\0${rule.realPath}\0${rule.contentHash}`)
      }
    }
    return formatted.block ? { content: [...event.content, { text: formatted.block, type: 'text' }] } : undefined
  })
}
