import { Effect, Layer } from 'effect'

import { describe, expect, it } from '#test-utils/bun_effect'

import {
  inspectProcess,
  nodeProcessProbe,
  ownershipMatches,
  ProcessInspector,
  ProcessInspectorLive,
  processInspectorFromProbe,
  processOwnerIsActive,
  type ProcessOwnership,
  type ProcessProbeShape,
} from '../process_ownership.js'

const alwaysAlive = () => true

const fakeProbe = (overrides: Partial<ProcessProbeShape>): ProcessProbeShape => ({
  platform: 'linux',
  processAlive: alwaysAlive,
  readFileBuffer: () => {
    throw new Error('readFileBuffer not stubbed')
  },
  readFileUtf8: () => {
    throw new Error('readFileUtf8 not stubbed')
  },
  runPowerShell: () => ({ status: 1, stdout: '' }),
  runPs: () => ({ status: 1, stdout: '' }),
  ...overrides,
})

describe('ProcessInspector: linux', () => {
  const linuxProbe = (token?: { environ: string }) =>
    fakeProbe({
      platform: 'linux',
      readFileBuffer: (path) => {
        if (path === '/proc/123/cmdline') {
          return Buffer.from('node\0script.js\0')
        }
        if (path === '/proc/123/environ' && token) {
          return Buffer.from(token.environ)
        }
        throw new Error(`unexpected read: ${path}`)
      },
      readFileUtf8: (path) => {
        if (path === '/proc/123/stat') {
          return `123 (script.js) S ${Array.from({ length: 18 }, () => '0').join(' ')} 55555 0 0`
        }
        throw new Error(`unexpected read: ${path}`)
      },
    })

  it.effect('derives identity from start ticks and hashed cmdline', () =>
    Effect.gen(function* () {
      const inspector = processInspectorFromProbe(linuxProbe())
      const snapshot = yield* inspector.inspect(123)
      expect(snapshot?.identity).toStartWith('linux:55555:')
      expect(snapshot?.tokenMatches).toBeUndefined()
    })
  )

  it.effect('reports a matching owner token from /proc/pid/environ', () =>
    Effect.gen(function* () {
      const inspector = processInspectorFromProbe(linuxProbe({ environ: 'PATH=/bin\0PI_SUBAGENT_OWNER_TOKEN=secret\0' }))
      const snapshot = yield* inspector.inspect(123, 'secret')
      expect(snapshot?.tokenMatches).toBe(true)
    })
  )

  it.effect('reports a non-matching owner token', () =>
    Effect.gen(function* () {
      const inspector = processInspectorFromProbe(linuxProbe({ environ: 'PATH=/bin\0' }))
      const snapshot = yield* inspector.inspect(123, 'secret')
      expect(snapshot?.tokenMatches).toBe(false)
    })
  )

  it.effect('treats a missing start-time or empty cmdline as unreadable', () =>
    Effect.gen(function* () {
      const inspector = processInspectorFromProbe(
        fakeProbe({
          platform: 'linux',
          readFileBuffer: () => Buffer.from(''),
          readFileUtf8: () => '123 (x) S 0',
        })
      )
      expect(yield* inspector.inspect(123)).toBeUndefined()
    })
  )
})

describe('ProcessInspector: windows', () => {
  it.effect('derives identity from CIM creation date and command line', () =>
    Effect.gen(function* () {
      const inspector = processInspectorFromProbe(
        fakeProbe({
          platform: 'win32',
          runPowerShell: () => ({ status: 0, stdout: `123456789\u0000C:\\pi.exe --mode rpc` }),
        })
      )
      const snapshot = yield* inspector.inspect(999)
      expect(snapshot?.identity).toStartWith('windows:')
      expect(snapshot?.tokenMatches).toBeUndefined()
    })
  )

  it.effect('treats a non-zero PowerShell exit or empty output as no process', () =>
    Effect.gen(function* () {
      const inspector = processInspectorFromProbe(fakeProbe({ platform: 'win32', runPowerShell: () => ({ status: 1, stdout: 'ignored' }) }))
      expect(yield* inspector.inspect(999)).toBeUndefined()
    })
  )
})

describe('ProcessInspector: darwin (token check skipped)', () => {
  it.effect('never reports tokenMatches even when the token string is present in ps output', () =>
    Effect.gen(function* () {
      const inspector = processInspectorFromProbe(
        fakeProbe({
          platform: 'darwin',
          runPs: (args) => {
            expect(args[0]).toBe('ww')
            return { status: 0, stdout: 'Mon Jan 1 00:00:00 2026 node script.js PI_SUBAGENT_OWNER_TOKEN=secret' }
          },
        })
      )
      const snapshot = yield* inspector.inspect(42, 'secret')
      expect(snapshot?.identity).toStartWith('unix:')
      expect(snapshot?.tokenMatches).toBeUndefined()
    })
  )
})

describe('ProcessInspector: other unix (token check enabled)', () => {
  it.effect('verifies the owner token from ps eww output', () =>
    Effect.gen(function* () {
      const inspector = processInspectorFromProbe(
        fakeProbe({
          platform: 'freebsd',
          runPs: (args) => {
            expect(args[0]).toBe('eww')
            return { status: 0, stdout: 'Mon Jan 1 00:00:00 2026 node script.js PI_SUBAGENT_OWNER_TOKEN=secret' }
          },
        })
      )
      const snapshot = yield* inspector.inspect(42, 'secret')
      expect(snapshot?.identity).toStartWith('unix:')
      expect(snapshot?.tokenMatches).toBe(true)
    })
  )

  it.effect('reports a mismatching token as tokenMatches: false on a non-Darwin unix host', () =>
    Effect.gen(function* () {
      const inspector = processInspectorFromProbe(
        fakeProbe({
          platform: 'freebsd',
          runPs: () => ({ status: 0, stdout: 'Mon Jan 1 00:00:00 2026 node script.js' }),
        })
      )
      const snapshot = yield* inspector.inspect(42, 'secret')
      expect(snapshot?.tokenMatches).toBe(false)
    })
  )

  it.effect('treats a non-zero ps exit or blank output as no process', () =>
    Effect.gen(function* () {
      const inspector = processInspectorFromProbe(fakeProbe({ platform: 'freebsd', runPs: () => ({ status: 1, stdout: '' }) }))
      expect(yield* inspector.inspect(42)).toBeUndefined()
    })
  )
})

describe('ProcessInspector: liveness and ownership comparison', () => {
  it.effect('alive() and inspect() both short-circuit to undefined/false when the process is not alive', () =>
    Effect.gen(function* () {
      const inspector = processInspectorFromProbe(fakeProbe({ processAlive: () => false }))
      expect(yield* inspector.alive(1)).toBe(false)
      expect(yield* inspector.inspect(1)).toBeUndefined()
    })
  )

  it.effect('ownershipMatches fails closed when the token check fails', () =>
    Effect.gen(function* () {
      const probe = fakeProbe({
        platform: 'linux',
        readFileBuffer: (path) => (path.endsWith('/cmdline') ? Buffer.from('node\0') : Buffer.from('PATH=/bin\0')),
        readFileUtf8: () => `1 (x) S ${Array.from({ length: 18 }, () => '0').join(' ')} 99 0 0`,
      })
      const inspector = processInspectorFromProbe(probe)
      const ownership: ProcessOwnership = { pid: 1, processIdentity: 'linux:99:whatever', token: 'expected' }
      expect(yield* inspector.ownershipMatches(ownership)).toBe(false)
    })
  )

  it.effect('ownershipMatches requires both identity and token to match', () =>
    Effect.gen(function* () {
      const probe = fakeProbe({
        platform: 'linux',
        readFileBuffer: (path) => (path.endsWith('/cmdline') ? Buffer.from('node\0') : Buffer.from(`PI_SUBAGENT_OWNER_TOKEN=expected\0`)),
        readFileUtf8: () => `1 (x) S ${Array.from({ length: 18 }, () => '0').join(' ')} 99 0 0`,
      })
      const inspector = processInspectorFromProbe(probe)
      const identity = yield* inspector.inspect(1, 'expected')
      const ownership: ProcessOwnership = { pid: 1, processIdentity: identity?.identity ?? '', token: 'expected' }
      expect(yield* inspector.ownershipMatches(ownership)).toBe(true)
    })
  )

  it.effect('ownerIsActive accepts a legacy pid-only owner while the process is alive', () =>
    Effect.gen(function* () {
      const inspector = processInspectorFromProbe(
        fakeProbe({
          platform: 'linux',
          readFileBuffer: () => Buffer.from('node\0'),
          readFileUtf8: () => `1 (x) S ${Array.from({ length: 18 }, () => '0').join(' ')} 99 0 0`,
        })
      )
      expect(yield* inspector.ownerIsActive({ pid: 1 })).toBe(true)
      expect(yield* inspector.ownerIsActive({})).toBe(false)
    })
  )
})

describe('plain exported functions delegate to the live probe', () => {
  it('inspectProcess/ownershipMatches/processOwnerIsActive stay usable without Effect', () => {
    expect(inspectProcess(-1)).toBeUndefined()
    expect(ownershipMatches({ pid: -1, processIdentity: 'x', token: 'y' })).toBe(false)
    expect(processOwnerIsActive({ pid: -1 })).toBe(false)
  })
})

describe('ProcessInspectorLive', () => {
  it('matches the running Node process to the live probe platform', () => {
    expect(nodeProcessProbe.platform).toBe(process.platform)
    expect(nodeProcessProbe.processAlive(process.pid)).toBe(true)
  })

  it.effect('resolves the live ProcessInspector service and reports the current process alive', () =>
    Effect.gen(function* () {
      const inspector = yield* ProcessInspector
      expect(yield* inspector.alive(process.pid)).toBe(true)
      expect(yield* inspector.inspect(-1)).toBeUndefined()
    }).pipe(Effect.provide(ProcessInspectorLive))
  )

  const fakeLayer = Layer.succeed(ProcessInspector)(
    processInspectorFromProbe({
      platform: 'win32',
      processAlive: () => true,
      readFileBuffer: () => {
        throw new Error('unused')
      },
      readFileUtf8: () => {
        throw new Error('unused')
      },
      runPowerShell: () => ({ status: 0, stdout: 'ticks fake.exe' }),
      runPs: () => ({ status: 1, stdout: '' }),
    })
  )

  it.effect('a fake layer overrides the live probe for a chosen platform', () =>
    Effect.gen(function* () {
      const inspector = yield* ProcessInspector
      expect((yield* inspector.inspect(1))?.identity).toStartWith('windows:')
    }).pipe(Effect.provide(fakeLayer))
  )
})
