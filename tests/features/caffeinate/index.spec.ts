import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'

import { register as caffeinate } from '@/features/caffeinate/index.js'

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

  const settle = (isIdle = true) => fixture.emit('agent_settled', {}, { isIdle: () => isIdle })
  return { children, fixture, settle, spawns }
}

describe('caffeinate', () => {
  it.effect('runs caffeinate only while the agent is active', async () => {
    const harness = createHarness()

    await harness.fixture.emit('session_start')
    expect(harness.spawns).toHaveLength(0)

    await harness.fixture.emit('agent_start')
    await harness.settle()

    expect(harness.spawns).toEqual([{ args: ['-w', '1234'], command: '/usr/bin/caffeinate' }])
    expect(harness.children[0]?.unrefCalls).toBe(1)
    expect(harness.children[0]?.killCalls).toBe(1)
  })

  it.effect('does nothing outside macOS', async () => {
    const harness = createHarness('linux')

    await harness.fixture.emit('agent_start')
    await harness.settle()

    expect(harness.spawns).toHaveLength(0)
  })

  it.effect('does not register in subagents', () => {
    const harness = createHarness('darwin', true, true)

    expect(harness.fixture.state.handlers.size).toBe(0)
    expect(harness.spawns).toHaveLength(0)
  })

  it.effect('keeps one process until the agent settles and tolerates repeated settled events', async () => {
    const harness = createHarness()

    await harness.fixture.emit('agent_start')
    await harness.fixture.emit('agent_start')
    await harness.fixture.emit('agent_end')
    expect(harness.children[0]?.killCalls).toBe(0)

    await harness.settle()
    await harness.settle()

    expect(harness.children).toHaveLength(1)
    expect(harness.children[0]?.killCalls).toBe(1)
  })

  it.effect('starts caffeinate again for the next agent run', async () => {
    const harness = createHarness()

    await harness.fixture.emit('agent_start')
    await harness.settle()
    await harness.fixture.emit('agent_start')
    await harness.settle()

    expect(harness.children).toHaveLength(2)
    expect(harness.children.map((child) => child.killCalls)).toEqual([1, 1])
  })

  it.effect('waits for caffeinate to exit when the agent settles', async () => {
    const harness = createHarness('darwin', false)
    await harness.fixture.emit('agent_start')
    let stopped = false

    const settled = harness.settle().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBeFalse()

    harness.children[0]?.events.get('exit')?.()
    await settled

    expect(stopped).toBeTrue()
  })

  it.effect('keeps caffeinate running when settlement already triggered follow-up work', async () => {
    const harness = createHarness()

    await harness.fixture.emit('agent_start')
    await harness.settle(false)
    expect(harness.children[0]?.killCalls).toBe(0)

    await harness.settle()
    expect(harness.children[0]?.killCalls).toBe(1)
  })

  it.effect('stops caffeinate on session shutdown as a fallback', async () => {
    const harness = createHarness()

    await harness.fixture.emit('agent_start')
    await harness.fixture.emit('session_shutdown')

    expect(harness.children[0]?.killCalls).toBe(1)
  })
})
