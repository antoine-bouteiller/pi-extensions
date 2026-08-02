import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'

import { asTool } from '#test-utils/casts'
import { createFakePi } from '#test-utils/fake_pi'

import hashline from '../index'

interface ToolOutput {
  content: { text: string; type: string }[]
  details: Record<string, unknown>
}

interface Tool {
  description: string
  promptGuidelines?: string[]
  execute: (
    id: string,
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string }
  ) => Promise<ToolOutput>
}

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

const setup = (): { read: Tool; write: Tool } => {
  const { pi, state } = createFakePi()
  hashline(pi)
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

describe('hashline extension', () => {
  test('registers anchored read and write tools', async () => {
    const tools = setup()
    const directory = await workspace()
    await writeFile(join(directory, 'sample.txt'), 'first\nsecond\n')

    const output = await tools.read.execute('call-1', { path: 'sample.txt' }, undefined, undefined, { cwd: directory })
    expect(output.content[0].text).toMatch(/^\[sample\.txt#[A-F0-9]+\]/)
    expect(output.content[0].text).toContain('1:first')
    expect(output.details.path).toBe('sample.txt')
  })

  test('applies a current patch and rejects a stale patch without overwriting', async () => {
    const { read, write } = setup()
    const directory = await workspace()
    const path = join(directory, 'sample.txt')
    await writeFile(path, 'first\nsecond\n')
    const currentHeader = await header(read, directory, 'sample.txt')

    const result = await write.execute('write-1', { patch: put(currentHeader, 2, 'changed') }, undefined, undefined, { cwd: directory })
    expect(result.content[0].text).toContain('update sample.txt')
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
