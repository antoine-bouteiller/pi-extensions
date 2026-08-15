import { Effect, FileSystem, Option, Path } from 'effect'

import { type PlainEnglishConfig, proseLength } from '@/features/plain_english/config.js'
import { rewriteDocument } from '@/features/plain_english/rewrite.js'
import { type PiCtx, Ui } from '@/shared/effect/pi_services.js'

const REWRITTEN_MARKER = '<!-- plain-english:rewritten -->'

interface MarkdownCommandOptions {
  readonly config: PlainEnglishConfig
}

interface ParsedArgs {
  readonly overwrite: boolean
  readonly path: string
}

const parseArgs = (args: string): ParsedArgs | undefined => {
  const trimmed = args.trim()
  if (trimmed === '') {
    return undefined
  }
  const overwrite = /\s+--overwrite$/.test(trimmed)
  const path = (overwrite ? trimmed.replace(/\s+--overwrite$/, '') : trimmed).trim()
  return path === '' ? undefined : { overwrite, path }
}

const splitFrontmatter = (document: string): { readonly frontmatter: string; readonly body: string } => {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(document)
  if (match === null) {
    return { body: document, frontmatter: '' }
  }
  return { body: document.slice(match[0].length), frontmatter: match[0] }
}

const outputPath = (path: string): string => `${path.slice(0, -'.md'.length)}.plain.md`

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const notify = (message: string, level: 'info' | 'warning') =>
  Effect.gen(function* () {
    const ui = yield* Ui
    yield* ui.notify(message, level)
  })

export const makeMarkdownCommand =
  ({ config }: MarkdownCommandOptions) =>
  (args: string, ctx: { readonly cwd: string }): Effect.Effect<void, never, PiCtx | Ui | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const parsed = parseArgs(args)
      if (parsed === undefined) {
        return yield* notify('Provide a Markdown file path.', 'warning')
      }
      if (Option.isNone(config.model)) {
        return yield* notify('A plain-English rewrite model is not configured.', 'warning')
      }

      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const source = path.resolve(ctx.cwd, parsed.path)
      if (!source.endsWith('.md')) {
        return yield* notify('Plain-English rewriting only supports .md files.', 'warning')
      }
      if (source.endsWith('.plain.md')) {
        return yield* notify('Plain-English sibling files ending in .plain.md cannot be rewritten.', 'warning')
      }
      if (!(yield* fs.exists(source))) {
        return yield* notify(`Markdown file not found: ${source}`, 'warning')
      }

      const documentBytes = yield* fs.readFile(source)
      const document = new TextDecoder().decode(documentBytes)
      const sourceMode = (yield* fs.stat(source)).mode & 0o777
      const { body, frontmatter } = splitFrontmatter(document)
      if (parsed.overwrite && body.includes(REWRITTEN_MARKER)) {
        return yield* notify('Markdown file was already rewritten.', 'warning')
      }
      if (proseLength(body) < config.minChars) {
        return yield* notify('Markdown body is too short to rewrite.', 'warning')
      }

      const rewritten = yield* rewriteDocument({ body, model: config.model.value, timeoutMs: config.mdTimeoutMs }).pipe(
        Effect.matchEffect({
          onFailure: (error) => notify(`Plain-English rewrite failed: ${error.message}`, 'warning').pipe(Effect.as(undefined)),
          onSuccess: Effect.succeed,
        })
      )
      if (rewritten === undefined) {
        return undefined
      }

      const destination = parsed.overwrite ? source : outputPath(source)
      const content = parsed.overwrite ? `${frontmatter}${REWRITTEN_MARKER}\n${rewritten}` : `${frontmatter}${rewritten}`
      const written = yield* Effect.scoped(
        Effect.gen(function* () {
          const temporaryDirectory = yield* fs.makeTempDirectoryScoped({ directory: path.dirname(destination), prefix: '.plain-english-' })
          const temporary = path.join(temporaryDirectory, 'rewrite.tmp')
          yield* fs.writeFileString(temporary, content, { mode: sourceMode })
          yield* fs.chmod(temporary, sourceMode)
          if (parsed.overwrite && !sameBytes(documentBytes, yield* fs.readFile(source))) {
            return false
          }
          yield* fs.rename(temporary, destination)
          return true
        })
      )
      if (!written) {
        return yield* notify('Markdown file changed while the rewrite was pending; no changes were written.', 'warning')
      }
      return yield* notify(`Plain-English Markdown written: ${destination}`, 'info')
    }).pipe(
      Effect.matchEffect({
        onFailure: () => notify('Plain-English Markdown operation failed.', 'warning'),
        onSuccess: Effect.succeed,
      })
    )
