import { describe, expect, test } from 'bun:test'

import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'

import { register as caffeinate } from '@/features/caffeinate/feature.js'

interface FakeChild {
  readonly events: Map<string, () => void>
  killCalls: number
  unrefCalls: number
}

const createHarness = (platform: NodeJS.Platform = 'darwin', exitOnKill = true, isSubagent = false) => {
  const fixture = createFakePi()
  const children: FakeChild[] = []
  const spawns: { args: readonly string[]; command: string }[] = []

  caffeinate(fixture.pi, runtime, {
    isSubagent,
    pid: 1234,
    platform,
    spawn: (command, args) => {
      const child: FakeChild = { events: new Map(), killCalls: 0, unrefCalls: 0 }
      children.push(child)
      spawns.push({ args, command })
      return {
        kill: () => {
          child.killCalls += 1
          if (exitOnKill) {
            child.events.get('exit')?.()
          }
          return true
        },
        once: (event, listener) => child.events.set(event, listener),
        unref: () => {
          child.unrefCalls += 1
        },
      }
    },
  })

  return { children, fixture, spawns }
}

describe('caffeinate', () => {
  test('runs caffeinate for the Pi process and stops it on shutdown', async () => {
    const harness = createHarness()

    await harness.fixture.emit('session_start')
    await harness.fixture.emit('session_shutdown')

    expect(harness.spawns).toEqual([{ args: ['-w', '1234'], command: '/usr/bin/caffeinate' }])
    expect(harness.children[0]?.unrefCalls).toBe(1)
    expect(harness.children[0]?.killCalls).toBe(1)
  })

  test('does nothing outside macOS', async () => {
    const harness = createHarness('linux')

    await harness.fixture.emit('session_start')
    await harness.fixture.emit('session_shutdown')

    expect(harness.spawns).toHaveLength(0)
  })

  test('does not register in subagents', () => {
    const harness = createHarness('darwin', true, true)

    expect(harness.fixture.state.handlers.size).toBe(0)
    expect(harness.spawns).toHaveLength(0)
  })

  test('keeps one process per session and tolerates repeated shutdown', async () => {
    const harness = createHarness()

    await harness.fixture.emit('session_start')
    await harness.fixture.emit('session_start')
    await harness.fixture.emit('session_shutdown')
    await harness.fixture.emit('session_shutdown')

    expect(harness.children).toHaveLength(1)
    expect(harness.children[0]?.killCalls).toBe(1)
  })

  test('waits for caffeinate to exit during shutdown', async () => {
    const harness = createHarness('darwin', false)
    await harness.fixture.emit('session_start')
    let stopped = false

    const shutdown = harness.fixture.emit('session_shutdown').then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBeFalse()

    harness.children[0]?.events.get('exit')?.()
    await shutdown

    expect(stopped).toBeTrue()
  })
})
