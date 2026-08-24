import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { withDshAssistantProfile } from './helpers/dsh-profile-loader.js'
import { parseProductArgv, runProductCli } from '../src/product/cli.js'
import {
  ASSISTANT_OFFICIAL_COMPOSED_IDS,
  ASSISTANT_PROFILE_BUNDLES,
  assertAssistantAdapterContract,
  assertMountedAdapterContract,
  assertOfficialComposedIds,
  assertOfficialEquivalentToAdapter,
  assertProfilePatchSafe,
  expectedProductionAdapterIds,
  mountedAdapterPluginIds,
} from '../src/product/profile-composition.js'
import { activeComposedIds, loadGovernedAssistantComposition, productPackageRoot, profileIdentityOf } from '../src/product/profile-load.js'
import { ensureProductHome } from '../src/product/home.js'
import {
  claimSessionPartition,
  commitRuntimeContext,
  completeProfileIdentityMigration,
  DEFAULT_PROFILE_NAME,
  DEFAULT_SESSION_ID,
  inspectRuntimeContext,
  partitionKeyOf,
  profileIdentityMigrationFile,
  readRuntimeBinding,
  readSessionRootOwner,
  recoverySessionsDir,
  resolveRuntimeContext,
  runtimeContextBindingFile,
  RuntimeContextError,
  SESSION_OWNER_SCHEMA_VERSION,
  sessionPartitionLockDir,
  sessionPersistenceDirOf,
  sessionRootOwnerFile,
} from '../src/product/runtime-context.js'
import { bootAssistantControl, bootSafeModeRuntime, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'

function isolatedHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'tars-runtime-'))
}

describe('runtime context', () => {
  it('defaults to assistant, home workspace, home sessions, and main', () => {
    const layout = ensureProductHome(isolatedHome())
    const context = resolveRuntimeContext(layout, {}, undefined, { allowFixtures: false })
    assert.equal(context.profile.value, DEFAULT_PROFILE_NAME)
    assert.equal(context.profile.source, 'default')
    assert.equal(context.workspace.value, path.join(layout.root, 'workspace'))
    assert.equal(context.workspace.source, 'default')
    assert.equal(context.sessionRoot.value, path.join(layout.root, 'sessions'))
    assert.equal(context.sessionId.value, DEFAULT_SESSION_ID)
    assert.notEqual(context.workspace.value, process.cwd())
  })

  it('applies product.json, then environment, then CLI', () => {
    const layout = ensureProductHome(isolatedHome())
    const fileWorkspace = mkdtempSync(path.join(tmpdir(), 'tars-ws-file-'))
    const envWorkspace = mkdtempSync(path.join(tmpdir(), 'tars-ws-env-'))
    const cliWorkspace = mkdtempSync(path.join(tmpdir(), 'tars-ws-cli-'))
    const previous = {
      profile: process.env.TARS_NG_PROFILE,
      workspace: process.env.TARS_NG_WORKSPACE,
      sessionId: process.env.TARS_NG_SESSION_ID,
    }
    try {
      const fromFile = resolveRuntimeContext(layout, {}, {
        schemaVersion: 1,
        profile: 'assistant',
        workspace: fileWorkspace,
        sessionId: 'from-file',
      }, { allowFixtures: false })
      assert.equal(fromFile.workspace.source, 'product-config')
      assert.equal(fromFile.sessionId.value, 'from-file')
      process.env.TARS_NG_WORKSPACE = envWorkspace
      process.env.TARS_NG_SESSION_ID = 'from-env'
      const fromEnv = resolveRuntimeContext(ensureProductHome(isolatedHome()), {}, {
        schemaVersion: 1,
        workspace: fileWorkspace,
        sessionId: 'from-file',
      }, { allowFixtures: false })
      assert.equal(fromEnv.workspace.value, realpathSync(envWorkspace))
      assert.equal(fromEnv.workspace.source, 'environment')
      assert.equal(fromEnv.sessionId.value, 'from-env')
      const fromCli = resolveRuntimeContext(ensureProductHome(isolatedHome()), {
        workspace: cliWorkspace,
        sessionId: 'from-cli',
      }, {
        schemaVersion: 1,
        workspace: fileWorkspace,
        sessionId: 'from-file',
      }, { allowFixtures: false })
      assert.equal(fromCli.workspace.value, realpathSync(cliWorkspace))
      assert.equal(fromCli.workspace.source, 'cli')
      assert.equal(fromCli.sessionId.value, 'from-cli')
    } finally {
      if (previous.profile === undefined) delete process.env.TARS_NG_PROFILE
      else process.env.TARS_NG_PROFILE = previous.profile
      if (previous.workspace === undefined) delete process.env.TARS_NG_WORKSPACE
      else process.env.TARS_NG_WORKSPACE = previous.workspace
      if (previous.sessionId === undefined) delete process.env.TARS_NG_SESSION_ID
      else process.env.TARS_NG_SESSION_ID = previous.sessionId
    }
  })

  it('rejects unknown options, empty flags, invalid ids, and cwd defaults', () => {
    assert.throws(() => parseProductArgv(['start', '--unknown']), /unknown option/)
    assert.throws(() => parseProductArgv(['start', '--profile']), /missing --profile value/)
    const layout = ensureProductHome(isolatedHome())
    assert.throws(() => resolveRuntimeContext(layout, { sessionId: '../x' }, undefined, { allowFixtures: false }), RuntimeContextError)
    assert.throws(() => resolveRuntimeContext(layout, { profile: 'missing' }, undefined, { allowFixtures: false }), RuntimeContextError)
    assert.throws(() => resolveRuntimeContext(layout, { workspace: path.join(layout.root, 'no-such-dir') }, undefined, { allowFixtures: false }), RuntimeContextError)
  })

  it('fails closed when an existing Home is rebound to a different workspace', () => {
    const layout = ensureProductHome(isolatedHome())
    resolveRuntimeContext(layout, {}, undefined, { allowFixtures: false })
    const other = mkdtempSync(path.join(tmpdir(), 'tars-ws-other-'))
    assert.throws(
      () => resolveRuntimeContext(layout, { workspace: other }, undefined, { allowFixtures: false }),
      /runtime context mismatch/,
    )
  })

  it('reports runtime context from doctor without leaking host cwd as the workspace', async () => {
    const home = isolatedHome()
    const lines: string[] = []
    const previousHome = process.env.TARS_NG_HOME
    try {
      const code = await runProductCli(['doctor', '--home', home], {
        log: (text) => lines.push(text),
        error: (text) => lines.push(text),
      })
      const text = lines.join('\n')
      assert.equal(code, 0)
      assert.match(text, /profile: assistant \(default\)/)
      assert.match(text, /session-id: main \(default\)/)
      assert.match(text, /workspace: workspace \(default\)/)
      assert.match(text, /profile-composition: shipped assistant Profile/)
      assert.doesNotMatch(text, new RegExp(`workspace: ${process.cwd().replaceAll('\\', '\\\\')}`))
      assert.equal(existsSync(runtimeContextBindingFile(ensureProductHome(home))), false)
    } finally {
      if (previousHome === undefined) delete process.env.TARS_NG_HOME
      else process.env.TARS_NG_HOME = previousHome
    }
  })

  it('persists the current session across a second boot of the same Home', async () => {
    const home = isolatedHome()
    const layout = ensureProductHome(home)
    const context = resolveRuntimeContext(layout, {}, undefined, { allowFixtures: false })
    const first = await bootAssistantControl({
      home,
      sessionRoot: context.sessionPersistenceDir,
      sessionId: context.sessionId.value,
      workspace: context.workspace.value,
    })
    try {
      const handle = await createAssistantAgent(first.ctx, context.sessionId.value, undefined, context.workspace.value)
      handle.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'runtime-context soak line' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      await first.ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({
      home,
      sessionRoot: context.sessionPersistenceDir,
      sessionId: context.sessionId.value,
      workspace: context.workspace.value,
    })
    try {
      const resumed = await createAssistantAgent(second.ctx, context.sessionId.value, undefined, context.workspace.value)
      const texts = resumed.agent.session.events.map((event) => JSON.stringify(event.data))
      assert.ok(texts.some((item) => item.includes('runtime-context soak line')))
      await resumed.dispose()
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('keeps a different Session ID isolated from main', async () => {
    const layout = ensureProductHome(isolatedHome())
    const context = resolveRuntimeContext(layout, {}, undefined, { allowFixtures: false })
    const first = await bootAssistantControl({
      home: layout.root,
      sessionRoot: context.sessionPersistenceDir,
      sessionId: context.sessionId.value,
      workspace: context.workspace.value,
    })
    try {
      const handle = await createAssistantAgent(first.ctx, 'main', undefined, context.workspace.value)
      handle.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'only-in-main' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      await first.ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    } finally {
      await first.ctx.fiber.dispose()
    }
    const other = await bootAssistantControl({
      home: layout.root,
      sessionRoot: context.sessionPersistenceDir,
      sessionId: 'topic-b',
      workspace: context.workspace.value,
    })
    try {
      const otherHandle = await createAssistantAgent(other.ctx, 'topic-b', undefined, context.workspace.value)
      const texts = otherHandle.agent.session.events.map((event) => JSON.stringify(event.data))
      assert.ok(!texts.some((item) => item.includes('only-in-main')))
      await otherHandle.dispose()
    } finally {
      await other.ctx.fiber.dispose()
    }
  })

  it('fails closed on future runtime-context schema and profile rebinding', () => {
    const layout = ensureProductHome(isolatedHome())
    resolveRuntimeContext(layout, {}, undefined, { allowFixtures: false })
    writeFileSync(runtimeContextBindingFile(layout), `${JSON.stringify({
      schemaVersion: 99,
      home: layout.root,
      profile: 'assistant',
      profileIdentity: 'assistant',
      workspace: path.join(layout.root, 'workspace'),
      workspaceIdentity: 'x',
      sessionRoot: path.join(layout.root, 'sessions'),
      sessionRootIdentity: 'y',
    }, null, 2)}\n`)
    assert.throws(() => resolveRuntimeContext(layout, {}, undefined, { allowFixtures: false }), /unsupported runtime context schema/)
    const rebound = ensureProductHome(isolatedHome())
    resolveRuntimeContext(rebound, {}, undefined, { allowFixtures: false })
    writeFileSync(runtimeContextBindingFile(rebound), `${JSON.stringify({
      schemaVersion: 1,
      home: rebound.root,
      profile: 'other',
      profileIdentity: 'other',
      workspace: path.join(rebound.root, 'workspace'),
      workspaceIdentity: 'will-mismatch',
      sessionRoot: path.join(rebound.root, 'sessions'),
      sessionRootIdentity: 'will-mismatch',
    }, null, 2)}\n`)
    assert.throws(() => resolveRuntimeContext(rebound, {}, undefined, { allowFixtures: false }), /runtime context mismatch/)
  })

  it('does not let a second Home read or write another Home session root', async () => {
    const shared = mkdtempSync(path.join(tmpdir(), 'tars-session-shared-'))
    const homeA = ensureProductHome(isolatedHome())
    const homeB = ensureProductHome(isolatedHome())
    const workspaceA = mkdtempSync(path.join(tmpdir(), 'tars-ws-a-'))
    const workspaceB = mkdtempSync(path.join(tmpdir(), 'tars-ws-b-'))
    const contextA = resolveRuntimeContext(homeA, { workspace: workspaceA, sessionRoot: shared }, undefined, { allowFixtures: false })
    const holdA = claimSessionPartition(contextA)
    const first = await bootAssistantControl({
      home: homeA.root,
      sessionRoot: holdA.root,
      sessionId: 'main',
      workspace: contextA.workspace.value,
    })
    try {
      const handle = await createAssistantAgent(first.ctx, 'main', undefined, contextA.workspace.value)
      handle.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'SECRET-FROM-HOME-ONE' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      await first.ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    } finally {
      await first.ctx.fiber.dispose()
      holdA.release()
    }
    assert.throws(
      () => inspectRuntimeContext(homeB, { workspace: workspaceB, sessionRoot: shared }, undefined),
      /session-root is bound to another Home/,
    )
    assert.throws(
      () => resolveRuntimeContext(homeB, { workspace: workspaceB, sessionRoot: shared }, undefined, { allowFixtures: false }),
      /session-root is bound to another Home/,
    )
    const again = claimSessionPartition(contextA)
    assert.throws(() => claimSessionPartition(contextA), /already held by another writer/)
    again.release()
  })

  it('leaves an external Workspace mode unchanged and does not write context from doctor/status', async () => {
    const home = isolatedHome()
    const workspace = mkdtempSync(path.join(tmpdir(), 'tars-ws-mode-'))
    chmodSync(workspace, 0o755)
    const previousHome = process.env.TARS_NG_HOME
    try {
      const doctor = await runProductCli(['doctor', '--home', home, '--workspace', workspace], {
        log() {},
        error() {},
      })
      const status = await runProductCli(['status', '--home', home, '--workspace', workspace], {
        log() {},
        error() {},
      })
      assert.equal(doctor, 0)
      assert.equal(status, 0)
      assert.equal(statSync(workspace).mode & 0o777, 0o755)
      const layout = ensureProductHome(home)
      assert.equal(existsSync(runtimeContextBindingFile(layout)), false)
      assert.equal(existsSync(layout.productConfigFile), false)
    } finally {
      if (previousHome === undefined) delete process.env.TARS_NG_HOME
      else process.env.TARS_NG_HOME = previousHome
    }
  })

  it('treats an interrupted binding write as unbound until a complete commit', () => {
    const layout = ensureProductHome(isolatedHome())
    writeFileSync(`${runtimeContextBindingFile(layout)}.partial`, '{')
    const inspected = inspectRuntimeContext(layout, {}, undefined)
    assert.equal(inspected.migrated, false)
    assert.equal(existsSync(runtimeContextBindingFile(layout)), false)
    const committed = commitRuntimeContext(layout, inspected, { allowFixtures: false })
    assert.equal(existsSync(runtimeContextBindingFile(layout)), true)
    assert.equal(committed.profile.value, DEFAULT_PROFILE_NAME)
  })

  it('does not report a successful stop when session flush fails', async () => {
    const home = isolatedHome()
    const layout = ensureProductHome(home)
    writeFileSync(layout.envFile, 'DEEPSEEK_API_KEY=sk-offline-not-a-live-key\n', { mode: 0o600 })
    chmodSync(layout.envFile, 0o600)
    const previous = {
      key: process.env.DEEPSEEK_API_KEY,
      port: process.env.TARS_NG_UI_PORT,
      tars: process.env.TARS_NG_HOME,
    }
    delete process.env.DEEPSEEK_API_KEY
    process.env.TARS_NG_UI_PORT = '0'
    const lines: string[] = []
    try {
      const code = await runProductCli(['start', '--home', home], {
        log: (text) => lines.push(text),
        error: (text) => lines.push(text),
      }, {
        afterWebUiBound: () => {
          throw new Error('injected stop after bind')
        },
        flushSession: async () => {
          throw new Error('disk full')
        },
      })
      assert.equal(code, 1)
      assert.match(lines.join('\n'), /retaining Home lease/)
      assert.doesNotMatch(lines.join('\n'), /lifecycle stop$/)
      assert.equal(existsSync(layout.runtimeIdentityFile), true)
    } finally {
      if (previous.key === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous.key
      if (previous.port === undefined) delete process.env.TARS_NG_UI_PORT
      else process.env.TARS_NG_UI_PORT = previous.port
      if (previous.tars === undefined) delete process.env.TARS_NG_HOME
      else process.env.TARS_NG_HOME = previous.tars
    }
  })

  it('matches the official assistant Profile composition and rejects unsafe patches', async () => {
    assert.deepEqual([...ASSISTANT_PROFILE_BUNDLES], ['@deepseek-ai/dsh-base', 'dsh-assistant'])
    assertAssistantAdapterContract()
    const booted = await bootAssistantControl()
    try {
      const mounted = mountedAdapterPluginIds(booted.ctx)
      const composition = loadGovernedAssistantComposition()
      const active = activeComposedIds(composition.entries)
      const expected = expectedProductionAdapterIds(active, { safeMode: false, sessionPersistence: false })
      assert.deepEqual(mounted, [...expected])
      assertMountedAdapterContract(booted.ctx, { safeMode: false, sessionPersistence: false })
      assert.ok(active.includes('dsh-assistant'))
      assert.equal(active.includes('skill'), false)
      assert.throws(
        () => assertOfficialEquivalentToAdapter(ASSISTANT_OFFICIAL_COMPOSED_IDS, ['dsh-assistant']),
        /not equivalent to the production adapter/,
      )
      assert.throws(
        () => assertOfficialEquivalentToAdapter(ASSISTANT_OFFICIAL_COMPOSED_IDS, expected.filter((id) => id !== 'dsh-assistant')),
        /not equivalent to the production adapter/,
      )
      assert.throws(
        () => assertOfficialEquivalentToAdapter(ASSISTANT_OFFICIAL_COMPOSED_IDS, [...expected, 'unknown-extra-plugin']),
        /not equivalent to the production adapter/,
      )
      await withDshAssistantProfile(async ({ composedIds }) => {
        assertOfficialComposedIds(composedIds)
        assert.deepEqual(composedIds, [...ASSISTANT_OFFICIAL_COMPOSED_IDS])
        assertOfficialEquivalentToAdapter(composedIds, mounted, { safeMode: false, sessionPersistence: false })
        assert.equal(composedIds.filter((id) => id === 'dsh-assistant').length, 1)
        assert.throws(
          () => assertOfficialComposedIds(['dsh-assistant', 'agent', 'system-prompt', 'not-mounted-by-production']),
          /does not match the shipped assistant contract/,
        )
      })
    } finally {
      await booted.ctx.fiber.dispose()
    }
    assert.throws(() => assertOfficialComposedIds(['dsh-assistant', 'dsh-assistant', 'agent', 'system-prompt']), /exactly one dsh-assistant/)
    assert.throws(() => assertOfficialComposedIds(['agent', 'system-prompt']), /exactly one dsh-assistant/)
    assert.throws(() => assertProfilePatchSafe([{ id: 'dsh-assistant', disabled: true }]), /cannot disable protected plugin/)
    assert.throws(() => assertProfilePatchSafe([{ id: 'dsh-assistant', config: { governance: null } }]), /cannot remove protected/)
  })

  it('keeps Safe Mode recovery identity aligned in doctor and Mission-Control', async () => {
    const layout = ensureProductHome(isolatedHome())
    const context = resolveRuntimeContext(layout, {}, undefined, { allowFixtures: false, safeMode: true })
    const booted = await bootSafeModeRuntime({
      home: layout.root,
      sessionRoot: context.sessionPersistenceDir,
      sessionId: context.sessionId.value,
      workspace: context.workspace.value,
    })
    try {
      const handle = await createAssistantAgent(booted.ctx, context.sessionId.value, undefined, context.workspace.value)
      const surface = new AssistantControlSurface(booted.ctx, context.sessionId.value, context)
      const view = surface.workspace()
      assert.equal(view.systemState, 'SAFE_MODE')
      assert.equal(view.runtimeContext?.safeMode, true)
      assert.equal(view.runtimeContext?.sessionPersistence, 'recovery-required')
      assert.equal(view.runtimeContext?.sessionId, 'main')
      assert.equal(view.runtimeContext?.profile, 'assistant')
      await handle.dispose()
    } finally {
      await booted.ctx.fiber.dispose()
    }
  })

  it('recovers unpublished staging locks left by a crash before identity publish', () => {
    const context = resolveRuntimeContext(ensureProductHome(isolatedHome()), {}, undefined, { allowFixtures: false })
    const root = context.sessionPersistenceDir
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const incompleteStaging = path.join(root, `${'.writer.lock.'}${'ab'.repeat(32)}.staging`)
    mkdirSync(incompleteStaging, { recursive: true, mode: 0o700 })
    const deadStaging = path.join(root, `${'.writer.lock.'}${'cd'.repeat(32)}.staging`)
    mkdirSync(deadStaging, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(deadStaging, 'identity.json'), `${JSON.stringify({
      schemaVersion: SESSION_OWNER_SCHEMA_VERSION,
      pid: 999999,
      runId: 'cd'.repeat(32),
      startedAt: new Date().toISOString(),
      home: context.home,
      partitionKey: 'dead',
    }, null, 2)}\n`)
    const hold = claimSessionPartition(context)
    assert.equal(existsSync(path.join(sessionPartitionLockDir(root), 'identity.json')), true)
    assert.equal(existsSync(incompleteStaging), false)
    assert.equal(existsSync(deadStaging), false)
    hold.release()
  })

  it('fails closed when a published partition lock identity cannot be verified', () => {
    const cases: Array<{ name: string; write: (lockDir: string) => void }> = [
      { name: 'missing identity', write: () => {} },
      { name: 'malformed json', write: (lockDir) => writeFileSync(path.join(lockDir, 'identity.json'), '{') },
      {
        name: 'future schema',
        write: (lockDir) => writeFileSync(path.join(lockDir, 'identity.json'), `${JSON.stringify({
          schemaVersion: SESSION_OWNER_SCHEMA_VERSION + 1,
          pid: process.pid,
          runId: 'aa'.repeat(32),
          startedAt: new Date().toISOString(),
          home: '/tmp',
          partitionKey: 'x',
        })}\n`),
      },
      {
        name: 'invalid runId',
        write: (lockDir) => writeFileSync(path.join(lockDir, 'identity.json'), `${JSON.stringify({
          schemaVersion: SESSION_OWNER_SCHEMA_VERSION,
          pid: process.pid,
          runId: 'short',
          startedAt: new Date().toISOString(),
          home: '/tmp',
          partitionKey: 'x',
        })}\n`),
      },
      {
        name: 'missing home and partitionKey',
        write: (lockDir) => writeFileSync(path.join(lockDir, 'identity.json'), `${JSON.stringify({
          schemaVersion: SESSION_OWNER_SCHEMA_VERSION,
          pid: process.pid,
          runId: 'bb'.repeat(32),
          startedAt: new Date().toISOString(),
        })}\n`),
      },
    ]
    for (const item of cases) {
      const context = resolveRuntimeContext(ensureProductHome(isolatedHome()), {}, undefined, { allowFixtures: false })
      const root = context.sessionPersistenceDir
      const lockDir = sessionPartitionLockDir(root)
      mkdirSync(root, { recursive: true, mode: 0o700 })
      mkdirSync(lockDir, { recursive: true, mode: 0o700 })
      item.write(lockDir)
      assert.throws(() => claimSessionPartition(context), /session-partition-ambiguous/, item.name)
      assert.equal(existsSync(lockDir), true, item.name)
    }
  })

  it('reclaims a stale session partition after a child process exits without release', () => {
    const home = isolatedHome()
    const ready = path.join(home, 'child-ready')
    const helper = fileURLToPath(new URL('./helpers/claim-partition-and-exit.ts', import.meta.url))
    const child = spawnSync(process.execPath, ['--import', 'tsx', helper], {
      encoding: 'utf8',
      env: { ...process.env, TARS_CHILD_HOME: home, TARS_CHILD_READY: ready },
    })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(existsSync(ready), true)
    const layout = ensureProductHome(home)
    const context = inspectRuntimeContext(layout, {}, undefined)
    const recovered = claimSessionPartition(context)
    assert.notEqual(recovered.runId, readFileSync(ready, 'utf8').trim())
    recovered.release()
  })

  it('does not let a stale release drop the current partition holder', () => {
    const context = resolveRuntimeContext(ensureProductHome(isolatedHome()), {}, undefined, { allowFixtures: false })
    const oldHold = claimSessionPartition(context)
    assert.equal(oldHold.release(), true)
    const current = claimSessionPartition(context)
    assert.equal(oldHold.release(), false)
    assert.throws(() => claimSessionPartition(context), /already held|ambiguous/)
    assert.equal(current.release(), true)
    const third = claimSessionPartition(context)
    third.release()
  })

  it('does not permanently bind the losing Home when two Homes race one Session Root', () => {
    const shared = mkdtempSync(path.join(tmpdir(), 'tars-session-race-'))
    const workspaceA = mkdtempSync(path.join(tmpdir(), 'tars-ws-race-a-'))
    const workspaceB = mkdtempSync(path.join(tmpdir(), 'tars-ws-race-b-'))
    const homeA = ensureProductHome(isolatedHome())
    const homeB = ensureProductHome(isolatedHome())
    const inspectA = inspectRuntimeContext(homeA, { workspace: workspaceA, sessionRoot: shared }, undefined)
    const inspectB = inspectRuntimeContext(homeB, { workspace: workspaceB, sessionRoot: shared }, undefined)
    const holdA = claimSessionPartition(inspectA)
    assert.throws(() => claimSessionPartition(inspectB), /session-root is bound to another Home/)
    assert.equal(existsSync(runtimeContextBindingFile(homeB)), false)
    commitRuntimeContext(homeA, inspectA, { allowFixtures: false })
    holdA.release()
    const otherRoot = mkdtempSync(path.join(tmpdir(), 'tars-session-other-'))
    const retryB = inspectRuntimeContext(homeB, { workspace: workspaceB, sessionRoot: otherRoot }, undefined)
    const holdB = claimSessionPartition(retryB)
    commitRuntimeContext(homeB, retryB, { allowFixtures: false })
    holdB.release()
    assert.equal(existsSync(runtimeContextBindingFile(homeB)), true)
    const rebound = inspectRuntimeContext(homeB, {
      workspace: workspaceB,
      sessionRoot: otherRoot,
    }, undefined)
    assert.equal(rebound.sessionRoot.value, retryB.sessionRoot.value)
  })

  it('starts the independent recovery Profile when the normal assistant patch is broken', async () => {
    const profiles = mkdtempSync(path.join(tmpdir(), 'tars-profiles-'))
    cpSync(path.join(productPackageRoot(), 'profiles'), profiles, { recursive: true })
    const previous = process.env.TARS_NG_PROFILE_ROOT
    process.env.TARS_NG_PROFILE_ROOT = profiles
    try {
      const layout = ensureProductHome(isolatedHome())
      const context = resolveRuntimeContext(layout, {}, undefined, { allowFixtures: false })
      const first = await bootAssistantControl({
        home: layout.root,
        sessionRoot: context.sessionPersistenceDir,
        sessionId: context.sessionId.value,
        workspace: context.workspace.value,
      })
      try {
        const handle = await createAssistantAgent(first.ctx, context.sessionId.value, undefined, context.workspace.value)
        handle.agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'keep-me-in-recovery' }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        await first.ctx.sessions.flush(handle.agent.session)
        await handle.dispose()
      } finally {
        await first.ctx.fiber.dispose()
      }
      writeFileSync(path.join(profiles, 'assistant', 'cordis.patch.yml'), 'not: yaml: [')
      const recovered = inspectRuntimeContext(layout, {}, undefined)
      assert.equal(recovered.safeMode, true)
      assert.match(recovered.profileCompositionError ?? '', /failed to load|YAML|yaml|bad indentation|end of the stream|can not read/)
      assert.equal(recovered.profileIdentity, context.profileIdentity)
      assert.equal(recovered.sessionPersistenceDir, context.sessionPersistenceDir)
      const recovery = loadGovernedAssistantComposition({ recovery: true })
      assert.equal(activeComposedIds(recovery.entries).includes('skill'), false)
      const booted = await bootSafeModeRuntime({
        home: layout.root,
        sessionRoot: recovered.sessionPersistenceDir,
        sessionId: recovered.sessionId.value,
        workspace: recovered.workspace.value,
      })
      try {
        const resumed = await createAssistantAgent(booted.ctx, recovered.sessionId.value, undefined, recovered.workspace.value)
        const texts = resumed.agent.session.events.map((event) => JSON.stringify(event.data))
        assert.ok(texts.some((item) => item.includes('keep-me-in-recovery')))
        const surface = new AssistantControlSurface(booted.ctx, recovered.sessionId.value, recovered)
        assert.equal(surface.workspace().systemState, 'SAFE_MODE')
        assert.equal(surface.workspace().runtimeContext?.safeMode, true)
        await resumed.dispose()
      } finally {
        await booted.ctx.fiber.dispose()
      }
      const doctorLines: string[] = []
      await runProductCli(['doctor', '--home', layout.root], {
        log: (text) => doctorLines.push(text),
        error: (text) => doctorLines.push(text),
      })
      assert.match(doctorLines.join('\n'), /profile-composition: recovery-required/)
      const startLines: string[] = []
      const previousPort = process.env.TARS_NG_UI_PORT
      const previousKey = process.env.DEEPSEEK_API_KEY
      process.env.TARS_NG_UI_PORT = '0'
      process.env.DEEPSEEK_API_KEY = 'sk-offline-not-a-live-key'
      try {
        await runProductCli(['start', '--once', '--home', layout.root], {
          log: (text) => startLines.push(text),
          error: (text) => startLines.push(text),
        })
      } finally {
        if (previousPort === undefined) delete process.env.TARS_NG_UI_PORT
        else process.env.TARS_NG_UI_PORT = previousPort
        if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
        else process.env.DEEPSEEK_API_KEY = previousKey
      }
      assert.match(startLines.join('\n'), /profile-composition: recovery-required|safe-mode: true/)
      writeFileSync(
        path.join(profiles, 'assistant', 'cordis.patch.yml'),
        readFileSync(path.join(productPackageRoot(), 'profiles', 'assistant', 'cordis.patch.yml'), 'utf8'),
      )
      const healthy = inspectRuntimeContext(layout, {}, undefined)
      assert.equal(healthy.profileCompositionError, undefined)
      assert.equal(healthy.safeMode, false)
      assert.equal(healthy.profileIdentity, context.profileIdentity)
    } finally {
      if (previous === undefined) delete process.env.TARS_NG_PROFILE_ROOT
      else process.env.TARS_NG_PROFILE_ROOT = previous
    }
  })

  it('rejects a same-named Profile whose resolved identity changed and does not read the old session', async () => {
    const profiles = mkdtempSync(path.join(tmpdir(), 'tars-profiles-'))
    cpSync(path.join(productPackageRoot(), 'profiles'), profiles, { recursive: true })
    const previous = process.env.TARS_NG_PROFILE_ROOT
    process.env.TARS_NG_PROFILE_ROOT = profiles
    try {
      const layout = ensureProductHome(isolatedHome())
      const context = resolveRuntimeContext(layout, {}, undefined, { allowFixtures: false })
      const originalIdentity = context.profileIdentity
      assert.match(originalIdentity, /^v1:[0-9a-f]{64}$/)
      const first = await bootAssistantControl({
        home: layout.root,
        sessionRoot: context.sessionPersistenceDir,
        sessionId: context.sessionId.value,
        workspace: context.workspace.value,
      })
      try {
        const handle = await createAssistantAgent(first.ctx, context.sessionId.value, undefined, context.workspace.value)
        handle.agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'secret-under-original-profile' }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        await first.ctx.sessions.flush(handle.agent.session)
        await handle.dispose()
      } finally {
        await first.ctx.fiber.dispose()
      }
      const patch = readFileSync(path.join(profiles, 'assistant', 'cordis.patch.yml'), 'utf8').replace(
        '- id: skill\n  disabled: true\n',
        '- id: skill\n  disabled: false\n',
      )
      writeFileSync(path.join(profiles, 'assistant', 'cordis.patch.yml'), patch)
      const mutated = profileIdentityOf(loadGovernedAssistantComposition())
      assert.notEqual(mutated, originalIdentity)
      assert.throws(
        () => inspectRuntimeContext(layout, {}, undefined),
        /Profile migration required/,
      )
      const otherHome = ensureProductHome(isolatedHome())
      const drifted = inspectRuntimeContext(otherHome, {
        workspace: context.workspace.value,
        sessionRoot: context.sessionRoot.value,
      }, undefined)
      assert.notEqual(drifted.profileIdentity, originalIdentity)
      assert.notEqual(drifted.sessionPersistenceDir, context.sessionPersistenceDir)
      writeFileSync(
        path.join(profiles, 'assistant', 'cordis.patch.yml'),
        readFileSync(path.join(productPackageRoot(), 'profiles', 'assistant', 'cordis.patch.yml'), 'utf8'),
      )
      const restored = inspectRuntimeContext(layout, {}, undefined)
      assert.equal(restored.profileIdentity, originalIdentity)
      const second = await bootAssistantControl({
        home: layout.root,
        sessionRoot: restored.sessionPersistenceDir,
        sessionId: restored.sessionId.value,
        workspace: restored.workspace.value,
      })
      try {
        const resumed = await createAssistantAgent(second.ctx, restored.sessionId.value, undefined, restored.workspace.value)
        const texts = resumed.agent.session.events.map((event) => JSON.stringify(event.data))
        assert.ok(texts.some((item) => item.includes('secret-under-original-profile')))
        await resumed.dispose()
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      if (previous === undefined) delete process.env.TARS_NG_PROFILE_ROOT
      else process.env.TARS_NG_PROFILE_ROOT = previous
    }
  })

  it('does not stamp the operator Session Root during unbound recovery and can bind after restore', async () => {
    const profiles = mkdtempSync(path.join(tmpdir(), 'tars-profiles-'))
    cpSync(path.join(productPackageRoot(), 'profiles'), profiles, { recursive: true })
    const previous = process.env.TARS_NG_PROFILE_ROOT
    process.env.TARS_NG_PROFILE_ROOT = profiles
    try {
      const layout = ensureProductHome(isolatedHome())
      writeFileSync(path.join(profiles, 'assistant', 'cordis.patch.yml'), 'not: yaml: [')
      const recovered = inspectRuntimeContext(layout, {}, undefined)
      assert.equal(recovered.bound, false)
      assert.equal(recovered.ephemeralRecovery, true)
      assert.equal(recovered.sessionPersistenceDir, recoverySessionsDir(layout))
      const previousPort = process.env.TARS_NG_UI_PORT
      const previousKey = process.env.DEEPSEEK_API_KEY
      process.env.TARS_NG_UI_PORT = '0'
      process.env.DEEPSEEK_API_KEY = 'sk-offline-not-a-live-key'
      const startLines: string[] = []
      try {
        await runProductCli(['start', '--once', '--home', layout.root], {
          log: (text) => startLines.push(text),
          error: (text) => startLines.push(text),
        })
      } finally {
        if (previousPort === undefined) delete process.env.TARS_NG_UI_PORT
        else process.env.TARS_NG_UI_PORT = previousPort
        if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
        else process.env.DEEPSEEK_API_KEY = previousKey
      }
      assert.match(startLines.join('\n'), /profile-composition: recovery-required|safe-mode: true/)
      assert.equal(existsSync(runtimeContextBindingFile(layout)), false)
      assert.equal(readSessionRootOwner(recovered.sessionRoot.value), undefined)
      assert.equal(existsSync(recoverySessionsDir(layout)), false)
      writeFileSync(
        path.join(profiles, 'assistant', 'cordis.patch.yml'),
        readFileSync(path.join(productPackageRoot(), 'profiles', 'assistant', 'cordis.patch.yml'), 'utf8'),
      )
      const healthy = inspectRuntimeContext(layout, {}, undefined)
      assert.equal(healthy.profileCompositionError, undefined)
      assert.equal(healthy.ephemeralRecovery, false)
      const hold = claimSessionPartition(healthy)
      const committed = commitRuntimeContext(layout, healthy, { allowFixtures: false })
      assert.equal(hold.release(), true)
      assert.equal(existsSync(runtimeContextBindingFile(layout)), true)
      assert.equal(committed.bound, true)
      const rebound = inspectRuntimeContext(layout, {}, undefined)
      assert.equal(rebound.profileIdentity, committed.profileIdentity)
      const startHealthy: string[] = []
      process.env.TARS_NG_UI_PORT = '0'
      process.env.DEEPSEEK_API_KEY = 'sk-offline-not-a-live-key'
      try {
        await runProductCli(['start', '--once', '--home', layout.root], {
          log: (text) => startHealthy.push(text),
          error: (text) => startHealthy.push(text),
        })
        assert.doesNotMatch(startHealthy.join('\n'), /session-root is bound to another/)
      } finally {
        if (previousPort === undefined) delete process.env.TARS_NG_UI_PORT
        else process.env.TARS_NG_UI_PORT = previousPort
        if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
        else process.env.DEEPSEEK_API_KEY = previousKey
      }
    } finally {
      if (previous === undefined) delete process.env.TARS_NG_PROFILE_ROOT
      else process.env.TARS_NG_PROFILE_ROOT = previous
    }
  })

  it('migrates a legacy name identity before claim and can release the final partition lock', () => {
    const layout = ensureProductHome(isolatedHome())
    const inspected = inspectRuntimeContext(layout, {}, undefined)
    mkdirSync(inspected.workspace.value, { recursive: true, mode: 0o700 })
    mkdirSync(inspected.sessionRoot.value, { recursive: true, mode: 0o700 })
    writeFileSync(runtimeContextBindingFile(layout), `${JSON.stringify({
      schemaVersion: 1,
      home: inspected.home,
      profile: inspected.profile.value,
      profileIdentity: inspected.profile.value,
      workspace: inspected.workspace.value,
      workspaceIdentity: inspected.workspaceIdentity,
      sessionRoot: inspected.sessionRoot.value,
      sessionRootIdentity: inspected.sessionRootIdentity,
    }, null, 2)}\n`)
    const legacy = {
      home: inspected.home,
      profileIdentity: inspected.profile.value,
      workspaceIdentity: inspected.workspaceIdentity,
      sessionRoot: inspected.sessionRoot,
    }
    const oldDir = sessionPersistenceDirOf(legacy)
    mkdirSync(oldDir, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(oldDir, 'keep.jsonl'), 'legacy-session\n')
    mkdirSync(path.join(oldDir, '.writer.lock'), { recursive: true, mode: 0o700 })
    writeFileSync(path.join(oldDir, '.writer.lock', 'identity.json'), '{"stale":true}\n')
    writeFileSync(sessionRootOwnerFile(inspected.sessionRoot.value), `${JSON.stringify({
      schemaVersion: SESSION_OWNER_SCHEMA_VERSION,
      home: inspected.home,
      profileIdentity: inspected.profile.value,
      workspaceIdentity: inspected.workspaceIdentity,
      partitionKey: partitionKeyOf(legacy),
    }, null, 2)}\n`)
    const migrated = completeProfileIdentityMigration(layout, inspectRuntimeContext(layout, {}, undefined), { allowFixtures: false })
    assert.match(migrated.profileIdentity, /^v1:[0-9a-f]{64}$/)
    assert.notEqual(migrated.profileIdentity, inspected.profile.value)
    assert.equal(existsSync(path.join(migrated.sessionPersistenceDir, 'keep.jsonl')), true)
    assert.equal(existsSync(sessionPartitionLockDir(migrated.sessionPersistenceDir)), false)
    assert.equal(existsSync(oldDir), false)
    assert.equal(existsSync(profileIdentityMigrationFile(layout)), false)
    const hold = claimSessionPartition(migrated)
    assert.equal(hold.root, migrated.sessionPersistenceDir)
    assert.equal(hold.release(), true)
    assert.equal(existsSync(sessionPartitionLockDir(migrated.sessionPersistenceDir)), false)
  })

  it('resumes a legacy identity upgrade after an interrupt at each phase', async () => {
    const layout = ensureProductHome(isolatedHome())
    const inspected = inspectRuntimeContext(layout, {}, undefined)
    mkdirSync(inspected.workspace.value, { recursive: true, mode: 0o700 })
    mkdirSync(inspected.sessionRoot.value, { recursive: true, mode: 0o700 })
    const writeLegacy = () => {
      writeFileSync(runtimeContextBindingFile(layout), `${JSON.stringify({
        schemaVersion: 1,
        home: inspected.home,
        profile: inspected.profile.value,
        profileIdentity: inspected.profile.value,
        workspace: inspected.workspace.value,
        workspaceIdentity: inspected.workspaceIdentity,
        sessionRoot: inspected.sessionRoot.value,
        sessionRootIdentity: inspected.sessionRootIdentity,
      }, null, 2)}\n`)
      const legacy = {
        home: inspected.home,
        profileIdentity: inspected.profile.value,
        workspaceIdentity: inspected.workspaceIdentity,
        sessionRoot: inspected.sessionRoot,
      }
      const oldDir = sessionPersistenceDirOf(legacy)
      mkdirSync(oldDir, { recursive: true, mode: 0o700 })
      writeFileSync(path.join(oldDir, 'keep.jsonl'), 'legacy-session\n')
      writeFileSync(sessionRootOwnerFile(inspected.sessionRoot.value), `${JSON.stringify({
        schemaVersion: SESSION_OWNER_SCHEMA_VERSION,
        home: inspected.home,
        profileIdentity: inspected.profile.value,
        workspaceIdentity: inspected.workspaceIdentity,
        partitionKey: partitionKeyOf(legacy),
      }, null, 2)}\n`)
      return oldDir
    }

    for (const phase of ['copy', 'owner', 'binding'] as const) {
      const oldDir = writeLegacy()
      const current = inspectRuntimeContext(layout, {}, undefined)
      assert.throws(
        () => completeProfileIdentityMigration(layout, current, { allowFixtures: false, interruptAfter: phase }),
        new RegExp(`injected migration interrupt: ${phase}`),
      )
      assert.equal(existsSync(profileIdentityMigrationFile(layout)), true)
      const doctorLines: string[] = []
      const doctorCode = await runProductCli(['doctor', '--home', layout.root], {
        log: (text) => doctorLines.push(text),
        error: (text) => doctorLines.push(text),
      })
      assert.equal(doctorCode, 0)
      assert.equal(existsSync(profileIdentityMigrationFile(layout)), true)
      const readable = inspectRuntimeContext(layout, {}, undefined)
      const finished = completeProfileIdentityMigration(layout, readable, { allowFixtures: false })
      assert.match(finished.profileIdentity, /^v1:[0-9a-f]{64}$/)
      assert.equal(readRuntimeBinding(layout)?.profileIdentity, finished.profileIdentity)
      assert.equal(existsSync(path.join(finished.sessionPersistenceDir, 'keep.jsonl')), true)
      assert.equal(existsSync(oldDir), false)
      assert.equal(existsSync(profileIdentityMigrationFile(layout)), false)
      assert.equal(existsSync(sessionPartitionLockDir(finished.sessionPersistenceDir)), false)
    }
  })
})
