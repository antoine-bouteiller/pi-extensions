import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionCompactEvent,
  type SessionStartEvent,
  type SessionTreeEvent,
  type ToolResultEvent,
} from '@earendil-works/pi-coding-agent'
import { NodeFileSystem } from '@effect/platform-node'
import { Context, Deferred, Effect, HashSet, Layer, ManagedRuntime, Ref } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'

import { makeEventHandler } from '../effect/runtime.js'
import { isRecord } from '../shared/records.js'

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

/**
 * Every fs call below is caught narrowly at its own call site, mirroring the pre-Effect code's
 * per-operation try/catch. Only `PlatformError` is swallowed here; a defect (an unexpected throw
 * that is not a filesystem error) still propagates through the fiber instead of being silently
 * treated as "file missing".
 */
const orSkip = <Value>(effect: Effect.Effect<Value, PlatformError, FileSystem>): Effect.Effect<Value | undefined, never, FileSystem> =>
  effect.pipe(Effect.catch(() => Effect.succeed(undefined)))

const discoverRuleFilesEffect = (root: string, containmentRoot?: string): Effect.Effect<RuleFile[], never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const files: RuleFile[] = []
    const visitedDirectories = new Set<string>()

    const registerRuleFile = (path: string, containmentBoundary: string | undefined): Effect.Effect<void, never, FileSystem> =>
      Effect.gen(function* () {
        const canonicalPath = yield* orSkip(fs.realPath(path))
        if (canonicalPath === undefined || (containmentBoundary && !isWithin(canonicalPath, containmentBoundary))) {
          return
        }
        files.push({ path, realPath: canonicalPath, relativePath: normalizePath(relative(root, path)) })
      })

    const walk = (directory: string, depth: number, containmentBoundary: string | undefined): Effect.Effect<void, never, FileSystem> =>
      Effect.gen(function* () {
        const canonicalDirectory = yield* orSkip(fs.realPath(directory))
        if (
          canonicalDirectory === undefined ||
          (containmentBoundary && !isWithin(canonicalDirectory, containmentBoundary)) ||
          visitedDirectories.has(canonicalDirectory)
        ) {
          return
        }
        visitedDirectories.add(canonicalDirectory)

        const names = yield* orSkip(fs.readDirectory(directory))
        if (names === undefined) {
          return
        }
        const sorted = names.toSorted((left, right) => left.localeCompare(right))

        for (const name of sorted) {
          const path = join(directory, name)
          const info = yield* orSkip(fs.stat(path))
          if (info === undefined) {
            continue
          }
          if (info.type === 'Directory') {
            if (depth < MAX_SCAN_DEPTH && !EXCLUDED_DIRECTORIES.has(name)) {
              yield* walk(path, depth + 1, containmentBoundary)
            }
          } else if (info.type === 'File' && RULE_EXTENSIONS.has(extname(name))) {
            yield* registerRuleFile(path, containmentBoundary)
          }
        }
      })

    const rootResolution = yield* orSkip(
      Effect.gen(function* () {
        const canonicalRoot = yield* fs.realPath(root)
        const canonicalBoundary = containmentRoot ? yield* fs.realPath(containmentRoot) : undefined
        const rootInfo = yield* fs.stat(canonicalRoot)
        if (rootInfo.type !== 'Directory' || (canonicalBoundary && !isWithin(canonicalRoot, canonicalBoundary))) {
          return undefined
        }
        return { canonicalBoundary }
      })
    )
    if (!rootResolution) {
      return []
    }

    yield* walk(root, 0, rootResolution.canonicalBoundary)
    return files
  })

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

const contentHashEffect = (content: string): Effect.Effect<string> => Effect.sync(() => createHash('sha256').update(content).digest('hex'))

const readRulesEffect = (root: string, displayRoot: string, containmentRoot?: string): Effect.Effect<Rule[], never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const files = yield* discoverRuleFilesEffect(root, containmentRoot)
    const rules: Rule[] = []
    for (const file of files) {
      const content = yield* orSkip(fs.readFileString(file.path, 'utf8'))
      if (content === undefined) {
        continue
      }
      const parsed = parseRuleFrontmatter(content)
      if (parsed.diagnostic || !parsed.body.trim()) {
        continue
      }
      rules.push({
        alwaysApply: parsed.alwaysApply,
        body: parsed.body.trim(),
        contentHash: yield* contentHashEffect(content),
        displayPath: `${displayRoot}/${file.relativePath}`,
        paths: parsed.paths,
        realPath: file.realPath,
      })
    }
    return rules
  })

const discoverRulesEffect = (cwd: string, trusted: boolean, homeDirectory: string): Effect.Effect<Rule[], never, FileSystem> =>
  Effect.gen(function* () {
    const groups: Rule[][] = []
    // Global guidance comes first so the shared prompt budget cannot starve it;
    // Project guidance remains later in the prompt and can refine it.
    for (const directory of RULE_DIRECTORIES) {
      groups.push(yield* readRulesEffect(join(homeDirectory, directory), `~/${directory}`))
    }
    if (trusted) {
      for (const directory of RULE_DIRECTORIES) {
        groups.push(yield* readRulesEffect(join(cwd, directory), directory, cwd))
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
  })

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

const record = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined)

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

interface DiscoverySlot {
  key: string
  deferred: Deferred.Deferred<Rule[]>
}

interface RulesStateShape {
  readonly dynamicInjections: Ref.Ref<HashSet.HashSet<string>>
  readonly activeDiscovery: Ref.Ref<DiscoverySlot | undefined>
}

class RulesState extends Context.Service<RulesState, RulesStateShape>()('@rules/State') {}

const RulesStateLive: Layer.Layer<RulesState> = Layer.effect(RulesState)(
  Effect.gen(function* () {
    return {
      activeDiscovery: yield* Ref.make<DiscoverySlot | undefined>(undefined),
      dynamicInjections: yield* Ref.make(HashSet.empty<string>()),
    }
  })
)

/**
 * `activeDiscovery` only coalesces concurrent scans that share a (cwd, trusted) key; it is cleared
 * the moment that scan settles. There is no persistent discovery cache, so every later call rescans
 * and rehashes — editing a rule file makes it immediately eligible for reinjection under its new
 * hash, with no session lifecycle event required.
 */
const refresh = (cwd: string, trusted: boolean, homeDirectory: string): Effect.Effect<Rule[], never, RulesState | FileSystem> =>
  Effect.gen(function* () {
    const state = yield* RulesState
    const key = `${cwd}\0${trusted}`

    const { created, slot } = yield* Ref.modify(
      state.activeDiscovery,
      (existing): readonly [{ created: boolean; slot: DiscoverySlot }, DiscoverySlot] => {
        if (existing?.key === key) {
          return [{ created: false, slot: existing }, existing]
        }
        const newSlot: DiscoverySlot = { deferred: Deferred.makeUnsafe<Rule[]>(), key }
        return [{ created: true, slot: newSlot }, newSlot]
      }
    )

    if (created) {
      yield* Effect.forkDetach(
        Effect.gen(function* () {
          const exit = yield* Effect.exit(discoverRulesEffect(cwd, trusted, homeDirectory))
          yield* Deferred.done(slot.deferred, exit)
          yield* Ref.update(state.activeDiscovery, (existing) => (existing === slot ? undefined : existing))
        })
      )
    }

    return yield* Deferred.await(slot.deferred)
  })

const clearDynamicInjections = (
  _event: SessionStartEvent | SessionCompactEvent | SessionTreeEvent,
  _ctx: ExtensionContext
): Effect.Effect<void, never, RulesState> =>
  Effect.gen(function* () {
    const state = yield* RulesState
    yield* Ref.set(state.dynamicInjections, HashSet.empty<string>())
  })

export default function rulesExtension(pi: ExtensionAPI, environment: RulesEnvironment = { homeDirectory: homedir() }) {
  const runtime = ManagedRuntime.make(Layer.mergeAll(RulesStateLive, NodeFileSystem.layer))

  const beforeAgentStart = (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext
  ): Effect.Effect<BeforeAgentStartEventResult | undefined, never, RulesState | FileSystem> =>
    Effect.gen(function* () {
      const rules = yield* refresh(ctx.cwd, ctx.isProjectTrusted(), environment.homeDirectory)
      const staticRules = rules.filter((rule) => rule.alwaysApply || rule.paths.length === 0)
      const formatted = formatRules(staticRules, '\n\n## Rules\n\n')
      let addition = formatted.block
      const scopedRules = rules.filter((rule) => !rule.alwaysApply && rule.paths.length > 0)
      addition += formatRulePointers(scopedRules, MAX_BLOCK_CHARS - addition.length)
      return addition ? { systemPrompt: event.systemPrompt + addition } : undefined
    })

  const toolResult = (
    event: ToolResultEvent,
    ctx: ExtensionContext
  ): Effect.Effect<{ content: ToolResultEvent['content'] } | undefined, never, RulesState | FileSystem> =>
    Effect.gen(function* () {
      const targetPaths = extractToolPaths(event, ctx.cwd)
      if (targetPaths.length === 0) {
        return undefined
      }

      const state = yield* RulesState
      const rules = yield* refresh(ctx.cwd, ctx.isProjectTrusted(), environment.homeDirectory)
      const dynamicInjections = yield* Ref.get(state.dynamicInjections)

      const pendingTargetsByRule = new Map<Rule, string[]>()
      for (const rule of rules) {
        if (rule.alwaysApply || rule.paths.length === 0) {
          continue
        }
        const pendingTargets = targetPaths.filter(
          (target) => matchesRule(rule, target, ctx.cwd) && !HashSet.has(dynamicInjections, `${target}\0${rule.realPath}\0${rule.contentHash}`)
        )
        if (pendingTargets.length > 0) {
          pendingTargetsByRule.set(rule, pendingTargets)
        }
      }

      const displayTarget = normalizePath(relative(ctx.cwd, targetPaths[0] ?? ctx.cwd))
      const formatted = formatRules([...pendingTargetsByRule.keys()], `\n\nAdditional rules matched for ${displayTarget}:\n\n`)
      if (formatted.emitted.length > 0) {
        yield* Ref.update(state.dynamicInjections, (current) => {
          let next = current
          for (const rule of formatted.emitted) {
            for (const target of pendingTargetsByRule.get(rule) ?? []) {
              next = HashSet.add(next, `${target}\0${rule.realPath}\0${rule.contentHash}`)
            }
          }
          return next
        })
      }
      return formatted.block ? { content: [...event.content, { text: formatted.block, type: 'text' as const }] } : undefined
    })

  pi.on('session_start', makeEventHandler(runtime)(clearDynamicInjections))
  pi.on('session_compact', makeEventHandler(runtime)(clearDynamicInjections))
  pi.on('session_tree', makeEventHandler(runtime)(clearDynamicInjections))
  pi.on('before_agent_start', makeEventHandler(runtime)(beforeAgentStart))
  pi.on('tool_result', makeEventHandler(runtime)(toolResult))
}
