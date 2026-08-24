import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { readProductVersion } from '../src/product/compatibility.js'
import { runProductCli } from '../src/product/cli.js'
import { ensureProductHome } from '../src/product/home.js'
import {
  acquireRuntimeLease,
  HOME_AMBIGUOUS_RECOVERY,
  inspectRuntimeLease,
  isLoopbackControlEndpoint,
  publicRuntimeIdentity,
  readRuntimeIdentity,
  removeLeaseIfRunId,
  RUNTIME_LEASE_SCHEMA_VERSION,
  writeNewRuntimeIdentity,
} from '../src/product/runtime-lease.js'
import { runSelfExtensionCli } from '../src/runtime/self-extension-cli.js'

function isolatedHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'tars-ng-lease-'))
}

async function withKeyHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = isolatedHome()
  const userHome = isolatedHome()
  const layout = ensureProductHome(home)
  writeFileSync(layout.envFile, 'DEEPSEEK_API_KEY=sk-offline-not-a-live-key\n', { mode: 0o600 })
  chmodSync(layout.envFile, 0o600)
  const previous = {
    deepseek: process.env.DEEPSEEK_API_KEY,
    home: process.env.HOME,
    xdg: process.env.XDG_CONFIG_HOME,
    tars: process.env.TARS_NG_HOME,
  }
  delete process.env.DEEPSEEK_API_KEY
  process.env.HOME = userHome
  process.env.XDG_CONFIG_HOME = path.join(userHome, '.config')
  try {
    await run(home)
  } finally {
    if (previous.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previous.deepseek
    if (previous.home === undefined) delete process.env.HOME
    else process.env.HOME = previous.home
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous.xdg
    if (previous.tars === undefined) delete process.env.TARS_NG_HOME
    else process.env.TARS_NG_HOME = previous.tars
  }
}

describe('TARS-NG Home runtime lease', () => {
  it('gives exactly one writer and reclaim a dead lease', async () => {
    const layout = ensureProductHome(isolatedHome())
    const first = await acquireRuntimeLease(layout)
    assert.equal(first.ok, true)
    if (!first.ok) throw new Error('expected first lease')
    const busy = await acquireRuntimeLease(layout)
    assert.equal(busy.ok, false)
    if (busy.ok) throw new Error('expected busy')
    assert.equal(busy.error, 'home-busy')
    const runId = first.hold.identity.runId
    assert.equal(removeLeaseIfRunId(layout, 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'), false)
    assert.equal(existsSync(layout.runtimeIdentityFile), true)
    assert.equal(first.hold.release(), true)
    const dead = ensureProductHome(layout.root)
    mkdirSync(dead.runtimeLockDir, { recursive: true })
    writeFileSync(path.join(dead.runtimeLockDir, 'identity.json'), `${JSON.stringify({
      schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
      pid: 2_147_483_647,
      runId: 'a'.repeat(64),
      startedAt: '2026-08-24T00:00:00.000Z',
      productVersion: '0.3.0',
      normalizedHome: dead.root,
    })}\n`)
    const reclaimed = await acquireRuntimeLease(dead)
    assert.equal(reclaimed.ok, true)
    if (!reclaimed.ok) throw new Error('expected reclaim')
    assert.notEqual(reclaimed.hold.identity.runId, 'a'.repeat(64))
    assert.notEqual(reclaimed.hold.identity.runId, runId)
    const published = publicRuntimeIdentity(reclaimed.hold.identity)
    assert.equal('runId' in published, false)
    reclaimed.hold.release()
  })

  it('refuses to remove a newer lease from an old finalizer and treats a live unverified PID as ambiguous', async () => {
    const layout = ensureProductHome(isolatedHome())
    const first = await acquireRuntimeLease(layout)
    assert.equal(first.ok, true)
    if (!first.ok) throw new Error('expected first lease')
    const oldRunId = first.hold.identity.runId
    first.hold.release()
    const next = await acquireRuntimeLease(layout)
    assert.equal(next.ok, true)
    if (!next.ok) throw new Error('expected next lease')
    assert.equal(removeLeaseIfRunId(layout, oldRunId), false)
    assert.equal(readRuntimeIdentity(layout)?.runId, next.hold.identity.runId)
    next.hold.release()

    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
    const foreignPid = sleeper.pid
    assert.ok(foreignPid)
    try {
      mkdirSync(layout.runtimeLockDir, { recursive: false })
      writeFileSync(layout.runtimeIdentityFile, `${JSON.stringify({
        schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
        pid: foreignPid,
        runId: 'b'.repeat(64),
        startedAt: '2026-08-24T00:00:00.000Z',
        productVersion: readProductVersion(),
        normalizedHome: layout.root,
      })}\n`)
      const inspected = await inspectRuntimeLease(layout)
      assert.equal(inspected.state, 'ambiguous')
      const refused = await acquireRuntimeLease(layout)
      assert.equal(refused.ok, false)
      if (refused.ok) throw new Error('expected ambiguous')
      assert.equal(refused.error, 'home-ambiguous')
      const lines: string[] = []
      const stopped = await runProductCli(['stop', '--home', layout.root], {
        log: (text) => lines.push(text),
        error: (text) => lines.push(text),
      })
      const text = lines.join('\n')
      assert.equal(stopped, 1)
      assert.match(text, /identity-mismatch|home-ambiguous/)
      assert.doesNotMatch(text, /b{16}/)
      assert.equal(sleeper.killed, false)
    } finally {
      sleeper.kill('SIGTERM')
    }
  })

  it('collapses symlink aliases to one Home and keeps tokens out of status', async () => {
    await withKeyHome(async (home) => {
      const alias = path.join(isolatedHome(), 'alias')
      symlinkSync(home, alias)
      const real = ensureProductHome(home)
      const linked = ensureProductHome(alias)
      assert.equal(real.root, linked.root)
      const [first, second] = await Promise.all([acquireRuntimeLease(real), acquireRuntimeLease(linked)])
      const won = [first, second].filter((item) => item.ok)
      const lost = [first, second].filter((item) => !item.ok)
      assert.equal(won.length, 1)
      assert.equal(lost.length, 1)
      if (!lost[0] || lost[0].ok) throw new Error('expected loser')
      assert.equal(lost[0].error, 'home-busy')
      if (!won[0] || !won[0].ok) throw new Error('expected winner')
      const statusWhileHeld: string[] = []
      await runProductCli(['status', '--home', alias], {
        log: (text) => statusWhileHeld.push(text),
        error: (text) => statusWhileHeld.push(text),
      })
      const heldText = statusWhileHeld.join('\n')
      assert.match(heldText, /running: yes/)
      assert.doesNotMatch(heldText, new RegExp(won[0].hold.identity.runId))
      assert.doesNotMatch(heldText, /runId/)
      won[0].hold.release()
      const onceLines: string[] = []
      const once = await runProductCli(['start', '--once', '--home', alias], {
        log: (text) => onceLines.push(text),
        error: (text) => onceLines.push(text),
      })
      assert.equal(once, 0)
      assert.equal(existsSync(real.runtimeIdentityFile), false)
      assert.doesNotMatch(onceLines.join('\n'), /runId/)
    })
  })

  it('releases the matching lease when start fails after acquisition', async () => {
    const home = isolatedHome()
    const userHome = isolatedHome()
    const previous = {
      deepseek: process.env.DEEPSEEK_API_KEY,
      home: process.env.HOME,
      xdg: process.env.XDG_CONFIG_HOME,
      tars: process.env.TARS_NG_HOME,
    }
    delete process.env.DEEPSEEK_API_KEY
    process.env.HOME = userHome
    process.env.XDG_CONFIG_HOME = path.join(userHome, '.config')
    const layout = ensureProductHome(home)
    const lines: string[] = []
    try {
      const code = await runProductCli(['start', '--once', '--home', home], {
        log: (text) => lines.push(text),
        error: (text) => lines.push(text),
      })
      assert.equal(code, 1)
      assert.equal(existsSync(layout.pidFile), false)
      assert.equal(existsSync(layout.runtimeIdentityFile), false)
      assert.doesNotMatch(lines.join('\n'), /[a-f0-9]{64}/)
    } finally {
      if (previous.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous.deepseek
      if (previous.home === undefined) delete process.env.HOME
      else process.env.HOME = previous.home
      if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous.xdg
      if (previous.tars === undefined) delete process.env.TARS_NG_HOME
      else process.env.TARS_NG_HOME = previous.tars
    }
  })

  it('fails mutating self-extension while a verified runtime owns the Home', async () => {
    const layout = ensureProductHome(isolatedHome())
    const previous = process.env.TARS_NG_HOME
    process.env.TARS_NG_HOME = layout.root
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
    const foreignPid = sleeper.pid
    assert.ok(foreignPid)
    const identity = {
      schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
      pid: foreignPid,
      runId: 'c'.repeat(64),
      startedAt: '2026-08-24T00:00:00.000Z',
      productVersion: readProductVersion(),
      normalizedHome: layout.root,
    }
    const server = createVerifiedControl(identity)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    try {
      mkdirSync(layout.runtimeLockDir)
      writeFileSync(layout.runtimeIdentityFile, `${JSON.stringify({
        ...identity,
        controlEndpoint: `http://127.0.0.1:${address.port}`,
      })}\n`)
      const errors: string[] = []
      const original = console.error
      console.error = (text) => {
        errors.push(String(text))
      }
      try {
        const code = await runSelfExtensionCli(['rollback'])
        assert.equal(code, 1)
      } finally {
        console.error = original
        sleeper.kill('SIGTERM')
      }
      const text = errors.join('\n')
      assert.match(text, /home-busy/)
      assert.doesNotMatch(text, /c{16}/)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      if (previous === undefined) delete process.env.TARS_NG_HOME
      else process.env.TARS_NG_HOME = previous
    }
  })

  it('releases the lease when injected boot throws and cleans an incomplete lock', async () => {
    const layout = ensureProductHome(isolatedHome())
    mkdirSync(layout.runtimeLockDir, { recursive: true })
    mkdirSync(layout.runtimeIdentityFile)
    assert.throws(() => writeNewRuntimeIdentity(layout))
    assert.equal(existsSync(layout.runtimeLockDir), false)

    const lines: string[] = []
    const code = await runProductCli(['start', '--once', '--home', layout.root], {
      log: (text) => lines.push(text),
      error: (text) => lines.push(text),
    }, {
      bootProduct: async () => {
        throw new Error('injected boot failure')
      },
    })
    assert.equal(code, 1)
    assert.match(lines.join('\n'), /injected boot failure/)
    assert.equal(existsSync(layout.runtimeIdentityFile), false)
    assert.equal(existsSync(layout.runtimeLockDir), false)
  })

  it('requires a loopback run-token challenge and never signals after authenticated stop', async () => {
    assert.equal(isLoopbackControlEndpoint('http://127.0.0.1:8787'), true)
    assert.equal(isLoopbackControlEndpoint('http://example.com:8787'), false)
    assert.equal(isLoopbackControlEndpoint('http://8.8.8.8:80'), false)

    const layout = ensureProductHome(isolatedHome())
    mkdirSync(layout.runtimeLockDir)
    writeFileSync(layout.runtimeIdentityFile, `${JSON.stringify({
      schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
      pid: 0,
      runId: 'd'.repeat(64),
      startedAt: '2026-08-24T00:00:00.000Z',
      productVersion: readProductVersion(),
      normalizedHome: layout.root,
    })}\n`)
    assert.equal(readRuntimeIdentity(layout), undefined)
    assert.equal((await inspectRuntimeLease(layout)).state, 'ambiguous')

    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
    const foreignPid = sleeper.pid
    assert.ok(foreignPid)
    writeFileSync(layout.runtimeIdentityFile, `${JSON.stringify({
      schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
      pid: foreignPid,
      runId: 'e'.repeat(64),
      startedAt: '2026-08-24T00:00:00.000Z',
      productVersion: readProductVersion(),
      normalizedHome: layout.root,
      controlEndpoint: 'http://example.com:9',
    })}\n`)
    assert.equal((await inspectRuntimeLease(layout)).state, 'ambiguous')

    const identity = {
      schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
      pid: foreignPid,
      runId: 'f'.repeat(64),
      startedAt: '2026-08-24T00:00:00.000Z',
      productVersion: readProductVersion(),
      normalizedHome: layout.root,
    }
    const getOnly = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/runtime-health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ pid: foreignPid, startedAt: identity.startedAt, productVersion: identity.productVersion }))
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => getOnly.listen(0, '127.0.0.1', resolve))
    const getAddress = getOnly.address()
    assert.ok(getAddress && typeof getAddress === 'object')
    writeFileSync(layout.runtimeIdentityFile, `${JSON.stringify({
      ...identity,
      controlEndpoint: `http://127.0.0.1:${getAddress.port}`,
    })}\n`)
    assert.equal((await inspectRuntimeLease(layout)).state, 'ambiguous')
    await new Promise<void>((resolve, reject) => getOnly.close((error) => error ? reject(error) : resolve()))

    const server = createVerifiedControl(identity)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    writeFileSync(layout.runtimeIdentityFile, `${JSON.stringify({
      ...identity,
      controlEndpoint: `http://127.0.0.1:${address.port}`,
    })}\n`)
    const signaled: Array<[number, unknown]> = []
    const originalKill = process.kill
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== undefined && signal !== 0) signaled.push([pid, signal])
      return originalKill.call(process, pid, signal)
    }) as typeof process.kill
    const lines: string[] = []
    try {
      const code = await runProductCli(['stop', '--home', layout.root], {
        log: (text) => lines.push(text),
        error: (text) => lines.push(text),
      }, { stopConfirmTimeoutMs: 250 })
      assert.equal(code, 1)
      assert.match(lines.join('\n'), /stop requested but not confirmed/)
      assert.equal(signaled.length, 0)
      assert.equal(sleeper.killed, false)
    } finally {
      process.kill = originalKill
      sleeper.kill('SIGTERM')
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('does not boot a read-only self-extension command against a live Home owner', async () => {
    const layout = ensureProductHome(isolatedHome())
    const previous = process.env.TARS_NG_HOME
    process.env.TARS_NG_HOME = layout.root
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
    const foreignPid = sleeper.pid
    assert.ok(foreignPid)
    const identity = {
      schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
      pid: foreignPid,
      runId: 'a1'.repeat(32),
      startedAt: '2026-08-24T00:00:00.000Z',
      productVersion: readProductVersion(),
      normalizedHome: layout.root,
    }
    const server = createVerifiedControl(identity)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    mkdirSync(layout.runtimeLockDir)
    writeFileSync(layout.runtimeIdentityFile, `${JSON.stringify({
      ...identity,
      controlEndpoint: `http://127.0.0.1:${address.port}`,
    })}\n`)
    let booted = false
    const errors: string[] = []
    const original = console.error
    console.error = (text) => {
      errors.push(String(text))
    }
    try {
      const code = await runSelfExtensionCli(['status'], {
        boot: async () => {
          booted = true
          throw new Error('should not boot')
        },
      })
      assert.equal(code, 1)
      assert.equal(booted, false)
      assert.match(errors.join('\n'), /home-busy/)
    } finally {
      console.error = original
      sleeper.kill('SIGTERM')
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      if (previous === undefined) delete process.env.TARS_NG_HOME
      else process.env.TARS_NG_HOME = previous
    }
  })

  it('binds identity to the exact Home and does not trust a reused PID', async () => {
    const homeA = ensureProductHome(isolatedHome())
    const homeB = ensureProductHome(isolatedHome())
    mkdirSync(homeB.runtimeLockDir)
    writeFileSync(homeB.runtimeIdentityFile, `${JSON.stringify({
      schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
      pid: process.pid,
      runId: 'ab'.repeat(32),
      startedAt: '2026-08-24T00:00:00.000Z',
      productVersion: readProductVersion(),
      normalizedHome: homeA.root,
      controlEndpoint: 'http://127.0.0.1:9',
    })}\n`)
    const copied = await inspectRuntimeLease(homeB)
    assert.equal(copied.state, 'ambiguous')
    assert.match(copied.detail ?? '', /normalizedHome|Do not copy/)
    assert.equal(readRuntimeIdentity(homeB), undefined)

    mkdirSync(homeA.runtimeLockDir)
    writeFileSync(homeA.runtimeIdentityFile, `${JSON.stringify({
      schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
      pid: process.pid,
      runId: 'cd'.repeat(32),
      startedAt: '2026-08-24T00:00:00.000Z',
      productVersion: readProductVersion(),
      normalizedHome: homeA.root,
      controlEndpoint: 'http://127.0.0.1:9',
    })}\n`)
    const reused = await inspectRuntimeLease(homeA)
    assert.equal(reused.state, 'ambiguous')
    const previous = process.env.TARS_NG_HOME
    process.env.TARS_NG_HOME = homeA.root
    let booted = false
    const errors: string[] = []
    const original = console.error
    console.error = (text) => {
      errors.push(String(text))
    }
    try {
      const code = await runSelfExtensionCli(['status'], {
        boot: async () => {
          booted = true
          throw new Error('should not boot')
        },
      })
      assert.equal(code, 1)
      assert.equal(booted, false)
      assert.match(errors.join('\n'), /home-ambiguous/)
    } finally {
      console.error = original
      if (previous === undefined) delete process.env.TARS_NG_HOME
      else process.env.TARS_NG_HOME = previous
    }
  })

  it('treats a malformed lock as ambiguous and keeps new-owner pid metadata', async () => {
    const layout = ensureProductHome(isolatedHome())
    mkdirSync(layout.runtimeLockDir)
    writeFileSync(layout.runtimeIdentityFile, '{not-json')
    const lines: string[] = []
    const code = await runProductCli(['stop', '--home', layout.root], {
      log: (text) => lines.push(text),
      error: (text) => lines.push(text),
    })
    assert.equal(code, 1)
    const text = lines.join('\n')
    assert.match(text, /home-ambiguous/)
    assert.match(text, new RegExp(HOME_AMBIGUOUS_RECOVERY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(text, /not running/)
    assert.equal(existsSync(layout.runtimeLockDir), true)

    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
    const foreignPid = sleeper.pid
    assert.ok(foreignPid)
    const identity = {
      schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
      pid: foreignPid,
      runId: 'ef'.repeat(32),
      startedAt: '2026-08-24T00:00:00.000Z',
      productVersion: readProductVersion(),
      normalizedHome: layout.root,
    }
    const server = createVerifiedControl(identity, () => {
      writeFileSync(layout.runtimeIdentityFile, `${JSON.stringify({
        ...identity,
        pid: 2_147_483_646,
        runId: '11'.repeat(32),
        controlEndpoint: 'http://127.0.0.1:9',
      })}\n`)
      writeFileSync(layout.pidFile, '2147483646\n', { mode: 0o600 })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    writeFileSync(layout.runtimeIdentityFile, `${JSON.stringify({
      ...identity,
      controlEndpoint: `http://127.0.0.1:${address.port}`,
    })}\n`)
    writeFileSync(layout.pidFile, `${foreignPid}\n`, { mode: 0o600 })
    const stopLines: string[] = []
    try {
      const stopped = await runProductCli(['stop', '--home', layout.root], {
        log: (text) => stopLines.push(text),
        error: (text) => stopLines.push(text),
      }, { stopConfirmTimeoutMs: 1_000 })
      assert.equal(stopped, 0)
      assert.match(stopLines.join('\n'), /stopped the verified runtime/)
      assert.equal(existsSync(layout.pidFile), true)
      assert.equal(readFileSync(layout.pidFile, 'utf8').trim(), '2147483646')
    } finally {
      sleeper.kill('SIGTERM')
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('cleans up and releases the lease when publish fails after WUI bind', async () => {
    await withKeyHome(async (home) => {
      const layout = ensureProductHome(home)
      const previousPort = process.env.TARS_NG_UI_PORT
      process.env.TARS_NG_UI_PORT = '0'
      const lines: string[] = []
      try {
        const code = await runProductCli(['start', '--home', home], {
          log: (text) => lines.push(text),
          error: (text) => lines.push(text),
        }, {
          afterWebUiBound: () => {
            throw new Error('injected publish failure')
          },
        })
        assert.equal(code, 1)
        assert.match(lines.join('\n'), /injected publish failure/)
        assert.equal(existsSync(layout.runtimeIdentityFile), false)
        assert.equal(existsSync(layout.pidFile), false)
      } finally {
        if (previousPort === undefined) delete process.env.TARS_NG_UI_PORT
        else process.env.TARS_NG_UI_PORT = previousPort
      }
    })
  })

  it('lets exactly one of two OS start processes own the Home', async () => {
    await withKeyHome(async (home) => {
      const bin = fileURLToPath(new URL('../src/product/bin.ts', import.meta.url))
      const env = {
        ...process.env,
        TARS_NG_HOME: home,
        TARS_NG_UI_PORT: '0',
        HOME: isolatedHome(),
      }
      delete env.DEEPSEEK_API_KEY
      const first = spawn(process.execPath, ['--import', 'tsx', bin, 'start', '--home', home], { env, encoding: 'utf8' })
      const ui = await new Promise<string>((resolve, reject) => {
        let buf = ''
        const timer = setTimeout(() => {
          first.kill('SIGTERM')
          reject(new Error(`first start did not report Web UI\n${buf}`))
        }, 25_000)
        const onData = (chunk: string) => {
          buf += chunk
          const match = buf.match(/Web UI: (http:\/\/127\.0\.0\.1:\d+)/)
          if (match?.[1]) {
            clearTimeout(timer)
            resolve(match[1])
          }
        }
        first.stdout?.on('data', onData)
        first.stderr?.on('data', onData)
        first.on('error', reject)
      })
      const second = spawn(process.execPath, ['--import', 'tsx', bin, 'start', '--home', home], {
        env: { ...env, TARS_NG_UI_PORT: '8799' },
        encoding: 'utf8',
      })
      try {
        const secondText = await new Promise<string>((resolve, reject) => {
          let buf = ''
          const timer = setTimeout(() => {
            second.kill('SIGTERM')
            reject(new Error(`second start did not exit\n${buf}`))
          }, 25_000)
          const onData = (chunk: string) => {
            buf += chunk
          }
          second.stdout?.on('data', onData)
          second.stderr?.on('data', onData)
          second.on('error', reject)
          second.on('exit', (code) => {
            clearTimeout(timer)
            resolve(`code=${code}\n${buf}`)
          })
        })
        assert.match(secondText, /home-busy/)
        assert.match(secondText, /code=1/)
        const page = await fetch(ui)
        assert.equal(page.status, 200)
      } finally {
        first.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          first.once('exit', () => resolve())
          if (first.exitCode !== null) resolve()
        })
        if (second.exitCode === null) second.kill('SIGTERM')
      }
    })
  })
})

function createVerifiedControl(identity: {
  readonly pid: number
  readonly runId: string
  readonly startedAt: string
  readonly productVersion: string
  readonly normalizedHome: string
}, onStop?: () => void) {
  return createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw === '' ? {} : JSON.parse(raw) as { runId?: unknown }
      if (req.url === '/api/runtime-health') {
        if (req.method !== 'POST' || typeof body.runId !== 'string' || body.runId !== identity.runId) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'identity-mismatch' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          pid: identity.pid,
          startedAt: identity.startedAt,
          productVersion: identity.productVersion,
          normalizedHome: identity.normalizedHome,
        }))
        return
      }
      if (req.url === '/api/runtime-stop' && req.method === 'POST') {
        if (typeof body.runId !== 'string' || body.runId !== identity.runId) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'identity-mismatch' }))
          return
        }
        onStop?.()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, pid: identity.pid }))
        return
      }
      res.writeHead(404).end()
    })
  })
}
