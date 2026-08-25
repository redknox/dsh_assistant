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
  inspectSessionJournal,
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

  it('fails closed when current session or timestamps are invalid', () => {
    const { context, catalog } = catalogFor()
    catalog.ensureMigrated('main')
    const file = sessionCatalogFile(context.sessionPersistenceDir)
    const binding = catalogBindingOf(context)
    writeFileSync(file, `${JSON.stringify({
      schemaVersion: 1,
      binding,
      currentSessionId: 'ghost',
      revision: 1,
      sessions: [{ id: 'main', title: 'Conversation', lifecycle: 'active', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z', persistence: 'persistent' }],
      approvalOrigins: {},
    }, null, 2)}\n`)
    assert.throws(() => catalog.inspect(), (error: SessionCatalogError) => error.code === 'corrupt')
    writeFileSync(file, `${JSON.stringify({
      schemaVersion: 1,
      binding,
      currentSessionId: 'main',
      revision: 1,
      sessions: [{ id: 'main', title: 'Conversation', lifecycle: 'archived', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z', persistence: 'persistent' }],
      approvalOrigins: {},
    }, null, 2)}\n`)
    assert.throws(() => catalog.inspect(), (error: SessionCatalogError) => error.code === 'corrupt')
    writeFileSync(file, `${JSON.stringify({
      schemaVersion: 1,
      binding,
      currentSessionId: 'main',
      revision: 1.5,
      sessions: [{ id: 'main', title: 'Conversation', lifecycle: 'active', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z', persistence: 'persistent' }],
      approvalOrigins: {},
    }, null, 2)}\n`)
    assert.throws(() => catalog.inspect(), (error: SessionCatalogError) => error.code === 'corrupt')
  })

  it('keeps approval origin tombstones after delete', () => {
    const { catalog } = catalogFor()
    catalog.ensureMigrated('main')
    const extra = catalog.create('Scratch')
    catalog.noteApprovalOrigin('ticket-a', extra.id)
    catalog.delete(extra.id, { confirm: true })
    assert.equal(catalog.approvalOrigin('ticket-a'), extra.id)
    catalog.noteApprovalOrigin('ticket-a', 'main')
    assert.equal(catalog.approvalOrigin('ticket-a'), extra.id)
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

  it('recovers a committed journal before boot would rewrite current from product.json', () => {
    const { catalog, context } = catalogFor()
    catalog.ensureMigrated('main')
    const extra = catalog.create('Scratch')
    const previous = catalog.load()
    catalog.switchTo(extra.id)
    catalog.writeJournal({
      schemaVersion: 1,
      op: 'switch',
      fromSessionId: 'main',
      toSessionId: extra.id,
      previous,
      intended: catalog.load(),
      phase: 'committed',
    })
    const started = catalog.resolveStartSession('main')
    assert.equal(started.sessionId, extra.id)
    assert.equal(catalog.inspect().currentSessionId, extra.id)
    assert.equal(started.journal?.phase, 'committed')
  })

  it('recovers a committed delete without resurrecting the deleted session', () => {
    const { catalog, context } = catalogFor()
    catalog.ensureMigrated('main')
    const extra = catalog.create('Scratch')
    const previous = catalog.load()
    const deleted = catalog.delete('main', { confirm: true })
    catalog.writeJournal({
      schemaVersion: 1,
      op: 'delete',
      fromSessionId: 'main',
      toSessionId: extra.id,
      previous,
      intended: catalog.load(),
      phase: 'committed',
      unlink: ['main'],
    })
    const started = catalog.resolveStartSession('main')
    assert.equal(started.sessionId, extra.id)
    assert.equal(catalog.inspect().sessions.some((item) => item.id === 'main'), false)
    assert.equal(deleted.currentSessionId, extra.id)
    assert.equal(inspectSessionJournal(context.sessionPersistenceDir, catalogBindingOf(context))?.phase, 'committed')
  })

  it('rolls a prepared journal back on restart', () => {
    const { catalog, context } = catalogFor()
    catalog.ensureMigrated('main')
    const extra = catalog.create('Scratch')
    const previous = catalog.load()
    catalog.switchTo(extra.id)
    catalog.writeJournal({
      schemaVersion: 1,
      op: 'switch',
      fromSessionId: 'main',
      toSessionId: extra.id,
      previous,
      phase: 'prepared',
    })
    const started = catalog.resolveStartSession('main')
    assert.equal(started.sessionId, 'main')
    assert.equal(catalog.inspect().currentSessionId, 'main')
    assert.equal(started.journal, undefined)
    assert.equal(inspectSessionJournal(context.sessionPersistenceDir, catalogBindingOf(context)), undefined)
  })

  it('rejects a structurally valid switch journal that would unlink the wrong history', () => {
    const { catalog } = catalogFor()
    catalog.ensureMigrated('main')
    const extra = catalog.create('Scratch')
    const previous = catalog.load()
    catalog.switchTo(extra.id)
    assert.throws(() => catalog.writeJournal({
      schemaVersion: 1,
      op: 'switch',
      fromSessionId: 'main',
      toSessionId: 'main',
      previous,
      intended: previous,
      phase: 'committed',
      unlink: ['main'],
    }), (error: SessionCatalogError) => error.code === 'corrupt')
    assert.equal(catalog.inspect().currentSessionId, extra.id)
  })

  it('rejects a create journal that also drops an existing session', () => {
    const { catalog } = catalogFor()
    catalog.ensureMigrated('main')
    const extra = catalog.create('Scratch')
    const previous = catalog.load()
    const created = catalog.createAndSwitch('t1111111111111111', 'New')
    const intended = {
      ...catalog.load(),
      sessions: catalog.load().sessions.filter((item) => item.id !== extra.id),
    }
    assert.throws(() => catalog.writeJournal({
      schemaVersion: 1,
      op: 'create',
      fromSessionId: 'main',
      toSessionId: created.currentSessionId,
      previous,
      intended,
      phase: 'committed',
    }), (error: SessionCatalogError) => error.code === 'corrupt')
  })

  it('rejects a delete journal that also injects a new session', () => {
    const { catalog } = catalogFor()
    catalog.ensureMigrated('main')
    const extra = catalog.create('Scratch')
    const previous = catalog.load()
    catalog.delete('main', { confirm: true })
    const live = catalog.load()
    const at = extra.createdAt
    const intended = {
      ...live,
      revision: live.revision + 1,
      sessions: [...live.sessions, {
        id: 't2222222222222222',
        title: 'Injected',
        lifecycle: 'active' as const,
        createdAt: at,
        lastActivityAt: at,
        persistence: 'persistent' as const,
      }],
    }
    assert.throws(() => catalog.writeJournal({
      schemaVersion: 1,
      op: 'delete',
      fromSessionId: 'main',
      toSessionId: extra.id,
      previous,
      intended,
      phase: 'committed',
      unlink: ['main'],
    }), (error: SessionCatalogError) => error.code === 'corrupt')
  })

  it('keeps a newer successor catalog instead of restoring a stale intended snapshot', () => {
    const { catalog } = catalogFor()
    catalog.ensureMigrated('main')
    const extra = catalog.create('Scratch')
    const previous = catalog.load()
    catalog.switchTo(extra.id)
    const intended = catalog.load()
    catalog.writeJournal({
      schemaVersion: 1,
      op: 'switch',
      fromSessionId: 'main',
      toSessionId: extra.id,
      previous,
      intended,
      phase: 'committed',
    })
    catalog.noteApprovalOrigin('ticket-after-adopt', extra.id)
    catalog.touch(extra.id, 'after-adopt preview')
    const started = catalog.resolveStartSession('main')
    assert.equal(started.sessionId, extra.id)
    assert.equal(catalog.inspect().sessions.find((item) => item.id === extra.id)?.preview, 'after-adopt preview')
    assert.equal(catalog.approvalOrigin('ticket-after-adopt'), extra.id)
    assert.ok(catalog.inspect().revision > intended.revision)
  })

  it('fails closed on a future or malformed journal', () => {
    const { catalog, context } = catalogFor()
    catalog.ensureMigrated('main')
    const file = catalog.journalFile()
    writeFileSync(file, `${JSON.stringify({ schemaVersion: 99, op: 'switch', fromSessionId: 'main', toSessionId: 'main', previous: catalog.load(), phase: 'committed' }, null, 2)}\n`)
    assert.throws(() => catalog.readJournal(), (error: SessionCatalogError) => error.code === 'unsupported-schema')
    writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, op: 'nope', fromSessionId: 'main', toSessionId: 'main', phase: 'prepared' }, null, 2)}\n`)
    assert.throws(() => catalog.readJournal(), (error: SessionCatalogError) => error.code === 'corrupt')
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
