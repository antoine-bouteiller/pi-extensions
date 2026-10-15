import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'

import { htmlFragmentToMarkdown } from '@/features/webfetch/html_to_markdown.js'

const convert = (html: string) => Effect.sync(() => htmlFragmentToMarkdown(html))

describe('htmlFragmentToMarkdown', () => {
  it.effect('keeps inline spacing and moves edge whitespace outside emphasis', () =>
    Effect.gen(function* () {
      expect(yield* convert('<p>Hello <span>big</span> <b> bold </b>and <em>it</em>!</p>')).toBe('Hello big **bold** and _it_!')
    })
  )

  it.effect('decodes entities in text and attributes', () =>
    Effect.gen(function* () {
      expect(yield* convert('<p>a &amp; b &lt;c&gt; &#8212; &#x2014; &hellip; &unknown;</p><a href="/x?a=1&amp;b=2">q</a>')).toBe(
        'a & b <c> — — … &unknown;\n\n[q](/x?a=1&b=2)'
      )
    })
  )

  it.effect('renders nested and ordered lists with implicit item closing', () =>
    Effect.gen(function* () {
      expect(yield* convert('<ul><li>one<li>two<ul><li>inner</li></ul></ul><ol start="3"><li><p>three</p><p>more</p></li></ol>')).toBe(
        '- one\n- two\n  - inner\n\n3. three\n   more'
      )
    })
  )

  it.effect('fences preformatted code verbatim with its language', () =>
    Effect.gen(function* () {
      expect(yield* convert('<pre><code class="language-ts">if (a &lt; b) {\n  run()\n}\n</code></pre><p>use <code>x`y</code></p>')).toBe(
        '```ts\nif (a < b) {\n  run()\n}\n```\n\nuse ``x`y``'
      )
    })
  )

  it.effect('renders tables, blockquotes, headings, rules, and images', () =>
    Effect.gen(function* () {
      expect(
        yield* convert(
          '<h3>T</h3><table><thead><tr><th>A</th><th>B|C</th></thead><tbody><tr><td>1<td>2</tbody></table><hr><blockquote><p>q1</p><p>q2</p></blockquote><img src="/i.png" alt="pic">'
        )
      ).toBe('### T\n\n| A | B\\|C |\n| --- | --- |\n| 1 | 2 |\n\n---\n\n> q1\n>\n> q2\n\n![pic](/i.png)')
    })
  )

  it.effect('drops removed elements and their raw text', () =>
    Effect.gen(function* () {
      expect(yield* convert('<p>keep</p><script>if (a < b) document.write("<p>x</p>")</script><form><input>gone</form><style>p{}</style>')).toBe(
        'keep'
      )
    })
  )
})
