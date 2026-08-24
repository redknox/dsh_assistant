import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bootAssistantControl, createAssistantAgent } from '../src/runtime/boot.js'
import { FakeReplyAdapter } from '../src/adapters/llm/fake-reply-adapter.js'
import { ensureProductHome } from '../src/product/home.js'
import {
  catalogBindingOf,
  inspectSessionCatalog,
  SessionCatalog,
  SessionCatalogError,
  sessionCatalogFile,
} from '../src/product/session-catalog.js'
import { inspectRuntimeContext } from '../src/product/runtime-context.js'

function isolatedHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'tars-catalog-'))
}

function catalogFor(home = isolatedHome()) {
  const layout = ensureProductHome(home)
  const context = inspectRuntimeContext(layout, {}, undefined)
  mkdirSync(context.sessionPersistenceDir, { recursive: true, mode: 0o700 })
  const catalog = new SessionCatalog(context.sessionPersistenceDir, catalogBindingOf(context))
  return { layout, context, catalog }
}

describe('Session Catalog', () => {
  it('migrates a #88 main session as the current topic without rewriting the id', () => {
    const { catalog } = catalogFor()
    const view = catalog.ensureMigrated('main')
    assert.equal(view.currentSessionId, 'main')
    assert.equal(view.sessions[0]?.id, 'main')
    assert.equal(view.sessions[0]?.title, 'Conversation')
    assert.equal(catalog.ensureMigrated('main').revision, view.revision)
  })

  it('creates isolated topics and keeps rename off the Session ID', () => {
    const { catalog } = catalogFor()
    catalog.ensureMigrated('main')
    const first = catalog.create('Personal')
    const second = catalog.create('TARS-NG Development')
    assert.notEqual(first.id, second.id)
    assert.notEqual(first.id, 'main')
    const renamed = catalog.rename(first.id, 'Life')
    assert.equal(renamed.sessions.find((item) => item.id === first.id)?.title, 'Life')
    assert.equal(renamed.sessions.find((item) => item.id === first.id)?.id, first.id)
  })

  it('archives, restores, and refuses to delete the last active topic', () => {
    const { catalog } = catalogFor()
    catalog.ensureMigrated('main')
    const extra = catalog.create('Scratch')
    const archived = catalog.archive(extra.id)
    assert.equal(archived.sessions.find((item) => item.id === extra.id)?.lifecycle, 'archived')
    assert.equal(archived.sessions.find((item) => item.id === extra.id)?.current, false)
    const restored = catalog.restore(extra.id)
    assert.equal(restored.sessions.find((item) => item.id === extra.id)?.lifecycle, 'active')
    catalog.archive(extra.id)
    catalog.delete(extra.id, { confirm: true })
    assert.equal(catalog.inspect().sessions.some((item) => item.id === extra.id), false)
    assert.throws(() => catalog.delete('main', { confirm: true }), SessionCatalogError)
    assert.throws(() => catalog.delete('main'), (error: SessionCatalogError) => error.code === 'confirmation-required')
  })

  it('rejects stale revision and path-like titles', () => {
    const { catalog } = catalogFor()
    const migrated = catalog.ensureMigrated('main')
    assert.throws(() => catalog.rename('main', 'Other', { revision: migrated.revision - 1 }), (error: SessionCatalogError) => error.code === 'stale-revision')
    assert.throws(() => catalog.create('../secret'), SessionCatalogError)
    assert.throws(() => catalog.create('ok/nope'), SessionCatalogError)
  })

  it('fails closed on future or foreign catalog files', () => {
    const first = catalogFor()
    first.catalog.ensureMigrated('main')
    const file = sessionCatalogFile(first.context.sessionPersistenceDir)
    writeFileSync(file, `${JSON.stringify({ schemaVersion: 99, binding: catalogBindingOf(first.context), currentSessionId: 'main', revision: 1, sessions: [] }, null, 2)}\n`)
    assert.throws(() => first.catalog.inspect(), (error: SessionCatalogError) => error.code === 'unsupported-schema')
    const second = catalogFor()
    mkdirSync(second.context.sessionPersistenceDir, { recursive: true })
    writeFileSync(sessionCatalogFile(second.context.sessionPersistenceDir), `${JSON.stringify({
      schemaVersion: 1,
      binding: catalogBindingOf(first.context),
      currentSessionId: 'main',
      revision: 1,
      sessions: [{ id: 'main', title: 'Conversation', lifecycle: 'active', createdAt: 't', lastActivityAt: 't', persistence: 'persistent' }],
      approvalOrigins: {},
    }, null, 2)}\n`)
    assert.throws(() => inspectSessionCatalog(second.context.sessionPersistenceDir, catalogBindingOf(second.context)), (error: SessionCatalogError) => error.code === 'context-mismatch')
  })

  it('keeps three topic histories isolated across switch', async () => {
    const home = isolatedHome()
    const { context, catalog } = catalogFor(home)
    catalog.ensureMigrated('main')
    const control = await bootAssistantControl({
      home: context.home,
      sessionRoot: context.sessionPersistenceDir,
      sessionId: 'main',
      workspace: context.workspace.value,
    })
    control.ctx.llm.registerAdapter(['fake'], new FakeReplyAdapter('ack'))
    try {
      const markers = [
        { id: 'main', text: 'marker-main' },
        { id: catalog.create('A').id, text: 'marker-a' },
        { id: catalog.create('B').id, text: 'marker-b' },
      ]
      for (const marker of markers) {
        const handle = await createAssistantAgent(control.ctx, marker.id, { provider: 'fake', model: 'fake-echo' }, context.workspace.value)
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: marker.text }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
        await control.ctx.sessions.flush(handle.agent.session)
        await handle.dispose()
      }
      for (const marker of markers) {
        const resumed = await createAssistantAgent(control.ctx, marker.id, { provider: 'fake', model: 'fake-echo' }, context.workspace.value)
        const blob = JSON.stringify(resumed.agent.session.events)
        assert.match(blob, new RegExp(marker.text))
        for (const other of markers.filter((item) => item.id !== marker.id)) {
          assert.doesNotMatch(blob, new RegExp(other.text))
        }
        await resumed.dispose()
      }
    } finally {
      await control.ctx.fiber.dispose()
    }
  })
})
