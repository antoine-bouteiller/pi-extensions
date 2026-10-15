import { isNotEmptyString, isNullOrUndefined } from '#shared/utils/predicates'

interface ElementNode {
  readonly attrs: ReadonlyMap<string, string>
  readonly children: HtmlNode[]
  readonly tag: string
}

type HtmlNode = ElementNode | string

interface Rendered {
  readonly block: boolean
  readonly text: string
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp'])
const REMOVED_TAGS = new Set(['form', 'head', 'noscript', 'script', 'style', 'template', 'textarea'])
const PHRASING_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'cite',
  'code',
  'del',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'label',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
])
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'body',
  'caption',
  'center',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'header',
  'hgroup',
  'html',
  'li',
  'main',
  'nav',
  'p',
  'section',
  'summary',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
])

/** Opening one of these closes an open sibling that HTML lets authors leave unclosed. */
const IMPLICIT_CLOSES: ReadonlyMap<string, { readonly closes: ReadonlySet<string>; readonly stopAt: ReadonlySet<string> }> = new Map([
  ['dd', { closes: new Set(['dd', 'dt']), stopAt: new Set(['dl']) }],
  ['dt', { closes: new Set(['dd', 'dt']), stopAt: new Set(['dl']) }],
  ['li', { closes: new Set(['li']), stopAt: new Set(['menu', 'ol', 'ul']) }],
  ['tbody', { closes: new Set(['tbody', 'tfoot', 'thead']), stopAt: new Set(['table']) }],
  ['td', { closes: new Set(['td', 'th']), stopAt: new Set(['table', 'tr']) }],
  ['tfoot', { closes: new Set(['tbody', 'tfoot', 'thead']), stopAt: new Set(['table']) }],
  ['th', { closes: new Set(['td', 'th']), stopAt: new Set(['table', 'tr']) }],
  ['thead', { closes: new Set(['tbody', 'tfoot', 'thead']), stopAt: new Set(['table']) }],
  ['tr', { closes: new Set(['tr']), stopAt: new Set(['table', 'tbody', 'tfoot', 'thead']) }],
])

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['bull', '•'],
  ['cent', '¢'],
  ['copy', '©'],
  ['deg', '°'],
  ['euro', '€'],
  ['gt', '>'],
  ['hellip', '…'],
  ['laquo', '«'],
  ['ldquo', '“'],
  ['lsquo', '‘'],
  ['lt', '<'],
  ['mdash', '—'],
  ['middot', '·'],
  ['nbsp', '\u00A0'],
  ['ndash', '–'],
  ['para', '¶'],
  ['pound', '£'],
  ['quot', '"'],
  ['raquo', '»'],
  ['rdquo', '”'],
  ['reg', '®'],
  ['rsquo', '’'],
  ['sect', '§'],
  ['shy', '\u00AD'],
  ['times', '×'],
  ['trade', '™'],
  ['yen', '¥'],
])

const codePoint = (value: number): string => (value > 0 && value <= 1_114_111 ? String.fromCodePoint(value) : '\uFFFD')

export const decodeEntities = (text: string): string =>
  text.replaceAll(
    /&(?:#(?<dec>\d+)|#[xX](?<hex>[\da-fA-F]+)|(?<name>[a-zA-Z][a-zA-Z\d]*));?/g,
    (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (!isNullOrUndefined(dec)) {
        return codePoint(Number.parseInt(dec, 10))
      }
      if (!isNullOrUndefined(hex)) {
        return codePoint(Number.parseInt(hex, 16))
      }
      return NAMED_ENTITIES.get(name?.toLowerCase() ?? '') ?? match
    }
  )

const parseAttributes = (source: string): Map<string, string> => {
  const attrs = new Map<string, string>()
  for (const match of source.matchAll(/(?<name>[^\s"'/=>]+)(?:\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)'|(?<bare>[^\s>]+)))?/g)) {
    const { bare, double, name, single } = match.groups ?? {}
    if (!isNullOrUndefined(name) && !attrs.has(name.toLowerCase())) {
      attrs.set(name.toLowerCase(), decodeEntities(double ?? single ?? bare ?? ''))
    }
  }
  return attrs
}

const openElement = (stack: ElementNode[], tag: string): void => {
  const rule = IMPLICIT_CLOSES.get(tag)
  for (let index = stack.length - 1; index > 0; index--) {
    const open = stack[index]?.tag ?? ''
    if (isNullOrUndefined(rule) ? open === 'p' : rule.closes.has(open)) {
      stack.length = index
      return
    }
    if (isNullOrUndefined(rule) ? !PHRASING_TAGS.has(open) : rule.stopAt.has(open)) {
      return
    }
  }
}

const closeElement = (stack: ElementNode[], tag: string): void => {
  const index = stack.findLastIndex((element) => element.tag === tag)
  if (index > 0) {
    stack.length = index
  }
}

/** Returns the raw text up to the element's closing tag and the cursor just past that tag. */
const readRawText = (html: string, tag: string, cursor: number): { readonly end: number; readonly text: string } => {
  const closing = new RegExp(`</${tag}\\s*>`, 'ig')
  closing.lastIndex = cursor
  const found = closing.exec(html)
  return isNullOrUndefined(found)
    ? { end: html.length, text: html.slice(cursor) }
    : { end: found.index + found[0].length, text: html.slice(cursor, found.index) }
}

const TOKEN = /<!--[\s\S]*?(?:-->|$)|<[!?][^>]*>|<\/(?<close>[a-zA-Z][\w:-]*)[^>]*>|<(?<open>[a-zA-Z][\w:-]*)(?<attrs>(?:"[^"]*"|'[^']*'|[^"'>])*)>/g

/** A forgiving tag-soup parser: unmatched closing tags are dropped and unclosed elements end with their parent. */
const parseHtml = (html: string): ElementNode => {
  const root: ElementNode = { attrs: new Map(), children: [], tag: '#root' }
  const stack = [root]
  const append = (node: HtmlNode) => stack.at(-1)?.children.push(node)
  let cursor = 0
  for (const match of html.matchAll(TOKEN)) {
    if (match.index < cursor) {
      continue
    }
    if (match.index > cursor) {
      append(html.slice(cursor, match.index))
    }
    cursor = match.index + match[0].length
    const { attrs = '', close, open } = match.groups ?? {}
    if (!isNullOrUndefined(close)) {
      closeElement(stack, close.toLowerCase())
      continue
    }
    if (isNullOrUndefined(open)) {
      continue
    }
    const tag = open.toLowerCase()
    if (!PHRASING_TAGS.has(tag)) {
      openElement(stack, tag)
    }
    const element: ElementNode = { attrs: parseAttributes(attrs), children: [], tag }
    append(element)
    if (RAW_TEXT_TAGS.has(tag)) {
      const raw = readRawText(html, tag, cursor)
      element.children.push(raw.text)
      cursor = raw.end
    } else if (!VOID_TAGS.has(tag) && !attrs.trimEnd().endsWith('/')) {
      stack.push(element)
    }
  }
  if (cursor < html.length) {
    append(html.slice(cursor))
  }
  return root
}

const textContent = (node: HtmlNode): string => (typeof node === 'string' ? decodeEntities(node) : node.children.map(textContent).join(''))

const inline = (text: string): Rendered => ({ block: false, text })
const block = (text: string): Rendered => ({ block: true, text })

const cleanInlineRun = (run: string): string =>
  run
    .replaceAll(/ {2,}/g, ' ')
    .replaceAll(/ *\n */g, '\n')
    .trim()

/** Inline runs between blocks lose their edge whitespace; blocks are joined with `separator`. */
const joinRendered = (children: readonly Rendered[], separator = '\n\n'): string => {
  const parts: string[] = []
  let run = ''
  const flush = () => {
    const text = cleanInlineRun(run)
    if (isNotEmptyString(text)) {
      parts.push(text)
    }
    run = ''
  }
  for (const rendered of children) {
    if (rendered.block) {
      flush()
      if (isNotEmptyString(rendered.text)) {
        parts.push(rendered.text)
      }
    } else {
      run += rendered.text
    }
  }
  flush()
  return parts.join(separator)
}

const renderChildren = (element: ElementNode, separator = '\n\n'): string => joinRendered(element.children.map(renderNode), separator)

/** Phrasing content keeps its edge whitespace for the enclosing run; a nested block makes the whole element a block. */
const renderContent = (element: ElementNode): Rendered => {
  const children = element.children.map(renderNode)
  return children.some((child) => child.block) ? block(joinRendered(children)) : inline(children.map((child) => child.text).join(''))
}

const singleLine = (text: string): string => text.replaceAll(/\s+/g, ' ').trim()

/** Keeps edge whitespace outside the delimiters so `a<b> x </b>b` stays `a **x** b`. */
const wrap = (element: ElementNode, delimiter: string): Rendered => {
  const content = renderContent(element)
  if (content.block || !/\S/.test(content.text)) {
    return content
  }
  const [, lead = '', body = '', trail = ''] = /^(?<lead>\s*)(?<body>[\s\S]*?)(?<trail>\s*)$/.exec(content.text) ?? []
  return inline(`${lead}${delimiter}${body}${delimiter}${trail}`)
}

const backtickFence = (text: string, minimum: number): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  return '`'.repeat(Math.max(minimum, longest + 1))
}

const renderCode = (element: ElementNode): Rendered => {
  const code = singleLine(textContent(element))
  if (code === '') {
    return inline('')
  }
  const fence = backtickFence(code, 1)
  const padding = code.startsWith('`') || code.endsWith('`') ? ' ' : ''
  return inline(`${fence}${padding}${code}${padding}${fence}`)
}

const renderPre = (element: ElementNode): Rendered => {
  const code = textContent(element).replace(/^\n/, '').trimEnd()
  const codeChild = element.children.find((child): child is ElementNode => typeof child !== 'string' && child.tag === 'code')
  const language = /(?:^|\s)(?:lang|language)-(?<lang>\S+)/.exec(codeChild?.attrs.get('class') ?? '')?.groups?.lang ?? ''
  const fence = backtickFence(code, 3)
  return block(`${fence}${language}\n${code}\n${fence}`)
}

const renderList = (element: ElementNode): Rendered => {
  const ordered = element.tag === 'ol'
  const start = Number.parseInt(element.attrs.get('start') ?? '1', 10)
  const items = element.children.filter((child): child is ElementNode => typeof child !== 'string' && child.tag === 'li')
  const lines = items.map((item, index) => {
    const marker = ordered ? `${(Number.isFinite(start) ? start : 1) + index}. ` : '- '
    const indent = ' '.repeat(marker.length)
    return renderChildren(item, '\n')
      .split('\n')
      .map((line, lineIndex) => {
        if (lineIndex === 0) {
          return marker + line
        }
        return isNotEmptyString(line) ? indent + line : line
      })
      .join('\n')
  })
  return block(lines.join('\n'))
}

const tableRows = (element: ElementNode): ElementNode[] =>
  element.children.flatMap((child) => {
    if (typeof child === 'string') {
      return []
    }
    if (child.tag === 'tr') {
      return [child]
    }
    return ['tbody', 'tfoot', 'thead'].includes(child.tag) ? tableRows(child) : []
  })

const renderTable = (element: ElementNode): Rendered => {
  const rows = tableRows(element).map((row) =>
    row.children
      .filter((cell): cell is ElementNode => typeof cell !== 'string' && (cell.tag === 'td' || cell.tag === 'th'))
      .map((cell) => singleLine(renderChildren(cell)).replaceAll('|', String.raw`\|`))
  )
  const width = Math.max(0, ...rows.map((row) => row.length))
  if (width === 0) {
    return block('')
  }
  const line = (cells: readonly string[]) => `| ${Array.from({ length: width }, (_cell, index) => cells[index] ?? '').join(' | ')} |`
  const [header = [], ...body] = rows
  return block([line(header), line(Array.from({ length: width }, () => '---')), ...body.map(line)].join('\n'))
}

const renderLink = (element: ElementNode): Rendered => {
  const label = singleLine(renderContent(element).text)
  const href = element.attrs.get('href')?.trim() ?? ''
  if (label === '' || href === '' || /^javascript:/i.test(href)) {
    return inline(label)
  }
  return inline(`[${label}](${href.replaceAll(' ', '%20')})`)
}

const renderImage = (element: ElementNode): Rendered => {
  const src = element.attrs.get('src')?.trim() ?? ''
  return inline(src === '' ? '' : `![${singleLine(element.attrs.get('alt') ?? '')}](${src.replaceAll(' ', '%20')})`)
}

const renderHeading = (element: ElementNode, level: number): Rendered => {
  const text = singleLine(renderChildren(element, ' '))
  return block(text === '' ? '' : `${'#'.repeat(level)} ${text}`)
}

const renderBlockquote = (element: ElementNode): Rendered =>
  block(
    renderChildren(element)
      .split('\n')
      .map((line) => (line === '' ? '>' : `> ${line}`))
      .join('\n')
  )

const ELEMENT_RENDERERS: ReadonlyMap<string, (element: ElementNode) => Rendered> = new Map([
  ['a', renderLink],
  ['b', (element: ElementNode) => wrap(element, '**')],
  ['blockquote', renderBlockquote],
  ['br', () => inline('\n')],
  ['code', renderCode],
  ['em', (element: ElementNode) => wrap(element, '_')],
  ['hr', () => block('---')],
  ['i', (element: ElementNode) => wrap(element, '_')],
  ['img', renderImage],
  ['kbd', renderCode],
  ['ol', renderList],
  ['pre', renderPre],
  ['samp', renderCode],
  ['strong', (element: ElementNode) => wrap(element, '**')],
  ['table', renderTable],
  ['tt', renderCode],
  ['ul', renderList],
])

const renderElement = (element: ElementNode): Rendered => {
  const heading = /^h(?<level>[1-6])$/.exec(element.tag)?.groups?.level
  if (!isNullOrUndefined(heading)) {
    return renderHeading(element, Number(heading))
  }
  const renderer = ELEMENT_RENDERERS.get(element.tag)
  if (!isNullOrUndefined(renderer)) {
    return renderer(element)
  }
  return BLOCK_TAGS.has(element.tag) ? block(renderChildren(element)) : renderContent(element)
}

const renderNode = (node: HtmlNode): Rendered => {
  if (typeof node === 'string') {
    return inline(decodeEntities(node.replaceAll(/\s+/g, ' ')))
  }
  return REMOVED_TAGS.has(node.tag) ? inline('') : renderElement(node)
}

/** Converts an HTML fragment or document to CommonMark-style Markdown. */
export const htmlFragmentToMarkdown = (html: string): string => renderChildren(parseHtml(html))
