import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type Theme, withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { type Component } from '@earendil-works/pi-tui'
import { asTheme, asTool } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'

import { register as hashline } from '@/features/hashline/feature.js'

interface ToolOutput {
  content: { text: string; type: string }[]
  details: Record<string, unknown>
}

interface Tool {
  description: string
  promptGuidelines?: string[]
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string }
  ) => Promise<ToolOutput>
  renderResult: (result: ToolOutput & { isError?: boolean }, options: { expanded: boolean; isPartial: boolean }, theme: Theme) => Component
}

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

const setup = (): { read: Tool; write: Tool } => {
  const { pi, state } = createFakePi()
  hashline(pi, runtime)
  return {
    read: asTool<Tool>(state.tools.get('hashline_read')),
    write: asTool<Tool>(state.tools.get('hashline_write')),
  }
}

const workspace = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'hashline-test-'))
  temporaryDirectories.push(directory)
  return directory
}

const header = async (tool: Tool, cwd: string, path: string): Promise<string> => {
  const output = await tool.execute('read', { path }, undefined, undefined, { cwd })
  return output.content[0].text.split('\n', 1)[0]
}

const put = (headerLine: string, line: number, replacement: string): string => `${headerLine}\nPUT ${line}.=${line}:\n+${replacement}`

const hashlineResult = (toolCallId: string, hash: string, startLine: number, endLine: number, text: string) => ({
  content: [{ text, type: 'text' }],
  details: { endLine, hash, path: 'sample.txt', startLine, version: `version-${hash.toLowerCase()}` },
  isError: false,
  role: 'toolResult',
  timestamp: 1,
  toolCallId,
  toolName: 'hashline_read',
})

const hashlineWriteResult = {
  content: [{ text: 'update sample.txt [CCCC]', type: 'text' }],
  details: { sections: [{ hash: 'CCCC', op: 'update', path: 'sample.txt', version: 'version-cccc' }] },
  isError: false,
  role: 'toolResult',
  timestamp: 1,
  toolCallId: 'write',
  toolName: 'hashline_write',
}
describe('hashline extension', () => {
  test('registers anchored read and write tools', async () => {
    const tools = setup()
    const directory = await workspace()
    await writeFile(join(directory, 'sample.txt'), 'first\nsecond\n')

    const output = await tools.read.execute('call-1', { path: 'sample.txt' }, undefined, undefined, { cwd: directory })
    expect(output.content[0].text).toMatch(/^\[sample\.txt#[A-F0-9]+\]/)
    expect(output.content[0].text).toContain('1:first')
    expect(output.details.path).toBe('sample.txt')
    const rendered = tools.read.renderResult(
      { ...output, isError: false },
      { expanded: false, isPartial: false },
      asTheme({ fg: (_color: string, text: string) => text })
    )
    expect(rendered.render(80).join('\n').trimEnd()).toBe('sample.txt')
  })

  test('returns requested line ranges with their original anchors', async () => {
    const { read, write } = setup()
    const directory = await workspace()
    const path = join(directory, 'range.txt')
    await writeFile(path, 'one\ntwo\nthree\nfour\nfive\n')

    const output = await read.execute('range', { limit: 2, offset: 3, path: 'range.txt' }, undefined, undefined, { cwd: directory })
    const [{ text }] = output.content
    expect(text).toMatch(/^\[range\.txt#[A-F0-9]+\]\n3:three\n4:four$/)
    const [currentHeader] = text.split('\n', 1)

    expect(write.execute('unseen', { patch: put(currentHeader, 1, 'ONE') }, undefined, undefined, { cwd: directory })).rejects.toThrow()
    await write.execute('visible', { patch: put(currentHeader, 4, 'FOUR') }, undefined, undefined, { cwd: directory })
    expect(await readFile(path, 'utf8')).toBe('one\ntwo\nthree\nFOUR\nfive\n')
  })

  test('bounds large reads while retaining the full snapshot for visible edits', async () => {
    const { read, write } = setup()
    const directory = await workspace()
    const path = join(directory, 'large.txt')
    const lines = Array.from({ length: 3000 }, (_value, index) => `line-${index + 1}-${'x'.repeat(40)}`)
    await writeFile(path, `${lines.join('\n')}\n`)

    const output = await read.execute('large', { path: 'large.txt' }, undefined, undefined, { cwd: directory })
    const [{ text }] = output.content
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
    expect(text.split('\n').length).toBeLessThanOrEqual(DEFAULT_MAX_LINES)
    expect(text).toContain('[Output truncated:')
    expect(output.details.truncated).toBe(true)
    const { endLine } = output.details
    if (typeof endLine !== 'number') {
      throw new Error('Expected at least one visible source line')
    }

    const [currentHeader] = text.split('\n', 1)
    await write.execute('large-visible', { patch: put(currentHeader, endLine, 'changed') }, undefined, undefined, { cwd: directory })
    const written = await readFile(path, 'utf8')
    const writtenLines = written.split('\n')
    expect(writtenLines.at(endLine - 1)).toBe('changed')
    expect(writtenLines.at(2999)).toBe(lines.at(2999))
  })

  test('rejects a read when no complete source line fits the output limit', async () => {
    const { read } = setup()
    const directory = await workspace()
    await writeFile(join(directory, 'wide.txt'), 'x'.repeat(DEFAULT_MAX_BYTES))

    expect(read.execute('wide', { path: 'wide.txt' }, undefined, undefined, { cwd: directory })).rejects.toThrow('exceeds the hashline output limit')
  })
  test('prunes superseded and duplicate reads without removing tool results', async () => {
    const { emit, pi } = createFakePi()
    hashline(pi, runtime)
    const collidingVersion = hashlineResult('old-version', 'BBBB', 1, 10, 'old colliding version')
    const oldVersion = { ...collidingVersion, details: { ...collidingVersion.details, version: 'version-old' } }
    const duplicate = hashlineResult('duplicate', 'BBBB', 1, 10, 'duplicate current range')
    const distinctRange = hashlineResult('distinct-range', 'BBBB', 11, 20, 'distinct current range')
    const latest = hashlineResult('latest', 'BBBB', 1, 10, 'latest current range')

    const results = await emit('context', { messages: [oldVersion, duplicate, distinctRange, latest] })
    const [contextResult] = results

    expect(contextResult).toEqual({
      messages: [
        {
          ...oldVersion,
          content: [{ text: '[Superseded hashline_read for sample.txt; reread the file if its current contents are needed.]', type: 'text' }],
        },
        {
          ...duplicate,
          content: [{ text: '[Superseded hashline_read for sample.txt; reread the file if its current contents are needed.]', type: 'text' }],
        },
        distinctRange,
        latest,
      ],
    })
  })

  test('prunes reads superseded by a successful write', async () => {
    const { emit, pi } = createFakePi()
    hashline(pi, runtime)
    const previousRead = hashlineResult('read', 'BBBB', 1, 10, 'previous contents')

    const results = await emit('context', { messages: [previousRead, hashlineWriteResult] })
    const [contextResult] = results

    expect(contextResult).toEqual({
      messages: [
        {
          ...previousRead,
          content: [{ text: '[Superseded hashline_read for sample.txt; reread the file if its current contents are needed.]', type: 'text' }],
        },
        hashlineWriteResult,
      ],
    })
  })

  test('prunes source reads after deletes and moves', async () => {
    const { emit, pi } = createFakePi()
    hashline(pi, runtime)
    const previousRead = hashlineResult('read', 'BBBB', 1, 10, 'previous contents')
    const transitions = [
      {
        ...hashlineWriteResult,
        details: { sections: [{ hash: 'BBBB', op: 'delete', path: 'sample.txt', version: 'version-bbbb' }] },
      },
      {
        ...hashlineWriteResult,
        details: {
          sections: [{ hash: 'BBBB', moveDest: 'moved.txt', op: 'update', path: 'moved.txt', sourcePath: 'sample.txt', version: 'version-bbbb' }],
        },
      },
    ]

    for (const transition of transitions) {
      const results = await emit('context', { messages: [previousRead, transition] })
      const [contextResult] = results
      expect(contextResult).toEqual({
        messages: [
          {
            ...previousRead,
            content: [{ text: '[Superseded hashline_read for sample.txt; reread the file if its current contents are needed.]', type: 'text' }],
          },
          transition,
        ],
      })
    }
  })

  test('applies a current patch and rejects a stale patch without overwriting', async () => {
    const { read, write } = setup()
    const directory = await workspace()
    const path = join(directory, 'sample.txt')
    await writeFile(path, 'first\nsecond\n')
    const currentHeader = await header(read, directory, 'sample.txt')

    const result = await write.execute('write-1', { patch: put(currentHeader, 2, 'changed') }, undefined, undefined, { cwd: directory })
    expect(result.content[0].text).toContain('update sample.txt')
    expect(result.details.sections).toEqual([
      { hash: expect.stringMatching(/^[A-F0-9]+$/), op: 'update', path: 'sample.txt', version: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ])
    expect(JSON.stringify(result.details)).not.toContain('before')
    expect(await readFile(path, 'utf8')).toBe('first\nchanged\n')

    expect(
      write.execute('stale', { patch: put(currentHeader, 1, 'stale') }, undefined, undefined, {
        cwd: directory,
      })
    ).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('first\nchanged\n')
  })

  test('applies multi-file patches and preflights all files before writing', async () => {
    const { read, write } = setup()
    const directory = await workspace()
    const firstPath = join(directory, 'first.txt')
    const secondPath = join(directory, 'second.txt')
    await writeFile(firstPath, 'one\n')
    await writeFile(secondPath, 'two\n')
    const firstHeader = await header(read, directory, 'first.txt')
    const secondHeader = await header(read, directory, 'second.txt')

    await write.execute('multi', { patch: `${put(firstHeader, 1, 'ONE')}\n${put(secondHeader, 1, 'TWO')}` }, undefined, undefined, {
      cwd: directory,
    })
    expect(await readFile(firstPath, 'utf8')).toBe('ONE\n')
    expect(await readFile(secondPath, 'utf8')).toBe('TWO\n')

    const freshFirst = await header(read, directory, 'first.txt')
    const staleSecond = await header(read, directory, 'second.txt')
    await writeFile(secondPath, 'external\n')
    expect(
      write.execute('multi-stale', { patch: `${put(freshFirst, 1, 'again')}\n${put(staleSecond, 1, 'bad')}` }, undefined, undefined, {
        cwd: directory,
      })
    ).rejects.toThrow()
    expect(await readFile(firstPath, 'utf8')).toBe('ONE\n')
    expect(await readFile(secondPath, 'utf8')).toBe('external\n')
  })

  test('serializes concurrent same-file writes so only one current snapshot lands', async () => {
    const { read, write } = setup()
    const directory = await workspace()
    const path = join(directory, 'shared.txt')
    await writeFile(path, 'original\n')
    const currentHeader = await header(read, directory, 'shared.txt')

    const outcomes = await Promise.allSettled([
      write.execute('concurrent-a', { patch: put(currentHeader, 1, 'alpha') }, undefined, undefined, { cwd: directory }),
      write.execute('concurrent-b', { patch: put(currentHeader, 1, 'beta') }, undefined, undefined, { cwd: directory }),
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    expect(['alpha\n', 'beta\n']).toContain(await readFile(path, 'utf8'))
  })

  test('takes multi-file locks in deterministic order for opposite section orders', async () => {
    const { read, write } = setup()
    const directory = await workspace()
    await writeFile(join(directory, 'a.txt'), 'a\n')
    await writeFile(join(directory, 'b.txt'), 'b\n')
    const headerA = await header(read, directory, 'a.txt')
    const headerB = await header(read, directory, 'b.txt')

    const outcomes = await Promise.allSettled([
      write.execute('ab', { patch: `${put(headerA, 1, 'A1')}\n${put(headerB, 1, 'B1')}` }, undefined, undefined, { cwd: directory }),
      write.execute('reverse-order', { patch: `${put(headerB, 1, 'B2')}\n${put(headerA, 1, 'A2')}` }, undefined, undefined, { cwd: directory }),
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
  })

  test('honors cancellation while waiting for a mutation lock', async () => {
    const { read, write } = setup()
    const directory = await workspace()
    const path = join(directory, 'queued.txt')
    await writeFile(path, 'before\n')
    const currentHeader = await header(read, directory, 'queued.txt')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const holding = withFileMutationQueue(path, () => gate)
    await Bun.sleep(0)

    const controller = new AbortController()
    const pending = write.execute('cancelled', { patch: put(currentHeader, 1, 'after') }, controller.signal, undefined, { cwd: directory })
    controller.abort()
    release()
    await holding

    expect(pending).rejects.toThrow('aborted')
    expect(await readFile(path, 'utf8')).toBe('before\n')
  })

  test('self-enforces protected paths, including leading @ and symlink aliases', async () => {
    const { read, write } = setup()
    const directory = await workspace()
    const secret = join(directory, '.env')
    await writeFile(secret, 'TOKEN=secret\n')
    await symlink(secret, join(directory, 'ordinary.txt'))

    for (const path of ['.env', '@.env', 'ordinary.txt']) {
      expect(read.execute('protected-read', { path }, undefined, undefined, { cwd: directory })).rejects.toThrow('protected path')
    }
    expect(
      write.execute('protected-write', { patch: '[.env#0000]\nPUT 1.=1:\n+TOKEN=changed' }, undefined, undefined, { cwd: directory })
    ).rejects.toThrow('protected path')
    expect(await readFile(secret, 'utf8')).toBe('TOKEN=secret\n')
  })

  test('documents native hashline operations instead of unified diffs', () => {
    const tools = setup()
    expect(tools.write.description).toContain('PUT')
    expect(tools.write.promptGuidelines?.join(' ')).toContain('never use unified-diff')
  })
})
