import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { parseProductArgv, runProductCli } from '../src/product/cli.js'
import { ensureProductHome } from '../src/product/home.js'
import {
  DEFAULT_PROFILE_NAME,
  DEFAULT_SESSION_ID,
  resolveRuntimeContext,
  runtimeContextBindingFile,
  RuntimeContextError,
} from '../src/product/runtime-context.js'
import { bootAssistantControl, createAssistantAgent } from '../src/runtime/boot.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

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
      assert.match(text, /profile-composition: product-adapter/)
      assert.doesNotMatch(text, new RegExp(`workspace: ${process.cwd().replaceAll('\\', '\\\\')}`))
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
      sessionRoot: context.sessionRoot.value,
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
      sessionRoot: context.sessionRoot.value,
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
      sessionRoot: context.sessionRoot.value,
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
      sessionRoot: context.sessionRoot.value,
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
})
