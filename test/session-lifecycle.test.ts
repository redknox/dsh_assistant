import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { bootAssistantControl, createAssistantAgent } from '../src/runtime/boot.js'
import { FakeReplyAdapter } from '../src/adapters/llm/fake-reply-adapter.js'
import { ensureProductHome } from '../src/product/home.js'
import { catalogBindingOf, SessionCatalog, SessionCatalogError } from '../src/product/session-catalog.js'
import { LiveSessionHost } from '../src/product/session-lifecycle.js'
import { inspectRuntimeContext } from '../src/product/runtime-context.js'
import { AssistantControlSurface } from '../src/ui/controller.js'

class GateAdapter extends LlmAdapter {
  constructor(private readonly release: Promise<void>) {
    super()
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) throw options.signal.reason
    await this.release
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ack' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ack' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function liveHost(input: { readonly failAt?: import('../src/product/session-lifecycle.js').SessionLifecycleFault } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'tars-session-host-'))
  const layout = ensureProductHome(home)
  const context = inspectRuntimeContext(layout, {}, undefined)
  mkdirSync(context.sessionPersistenceDir, { recursive: true, mode: 0o700 })
  const catalog = new SessionCatalog(context.sessionPersistenceDir, catalogBindingOf(context))
  catalog.ensureMigrated('main')
  const extra = catalog.create('Scratch')
  const control = await bootAssistantControl({
    home: context.home,
    sessionRoot: context.sessionPersistenceDir,
    sessionId: 'main',
    workspace: context.workspace.value,
  })
  control.ctx.llm.registerAdapter(['fake'], new FakeReplyAdapter('ack'))
  const handle = await createAssistantAgent(control.ctx, 'main', { provider: 'fake', model: 'fake-echo' }, context.workspace.value)
  const surface = new AssistantControlSurface(control.ctx, 'main', context, catalog)
  const persisted: string[] = ['main']
  const host = new LiveSessionHost(
    control.ctx,
    surface,
    catalog,
    context.workspace.value,
    (nextId) => { persisted.push(nextId) },
    handle,
    false,
    input,
  )
  return { catalog, extra, host, surface, control, persisted, context }
}

describe('Session lifecycle transactions', () => {
  it('rolls switch back to the previous current session after a catalog-commit fault', async () => {
    const { catalog, extra, host, surface, control } = await liveHost({ failAt: 'after-catalog-commit' })
    try {
      await assert.rejects(
        () => host.switchTo(extra.id, { sessionId: 'main', revision: catalog.inspect().revision }),
        (error: SessionCatalogError) => error.code === 'injected-fault',
      )
      assert.equal(surface.sessionId, 'main')
      assert.equal(catalog.inspect().currentSessionId, 'main')
    } finally {
      await host.currentHandle().dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('does not unlink history when delete adopt fails', async () => {
    const { catalog, extra, host, surface, control, context } = await liveHost({ failAt: 'after-catalog-commit' })
    const handle = await createAssistantAgent(control.ctx, extra.id, { provider: 'fake', model: 'fake-echo' }, context.workspace.value)
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'keep-this-history' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    await control.ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    try {
      await assert.rejects(
        () => host.delete(extra.id, { sessionId: 'main', revision: catalog.inspect().revision, confirm: true }),
        (error: SessionCatalogError) => error.code === 'injected-fault',
      )
      assert.equal(surface.sessionId, 'main')
      assert.equal(catalog.inspect().sessions.some((item) => item.id === extra.id), true)
      const resumed = await createAssistantAgent(control.ctx, extra.id, { provider: 'fake', model: 'fake-echo' }, context.workspace.value)
      assert.match(JSON.stringify(resumed.agent.session.events), /keep-this-history/)
      await resumed.dispose()
    } finally {
      await host.currentHandle().dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('refuses switch while the current agent is running', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'tars-session-busy-'))
    const layout = ensureProductHome(home)
    const context = inspectRuntimeContext(layout, {}, undefined)
    mkdirSync(context.sessionPersistenceDir, { recursive: true, mode: 0o700 })
    const catalog = new SessionCatalog(context.sessionPersistenceDir, catalogBindingOf(context))
    catalog.ensureMigrated('main')
    const extra = catalog.create('Scratch')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const control = await bootAssistantControl({
      home: context.home,
      sessionRoot: context.sessionPersistenceDir,
      sessionId: 'main',
      workspace: context.workspace.value,
    })
    control.ctx.llm.registerAdapter(['fake'], new GateAdapter(gate))
    const handle = await createAssistantAgent(control.ctx, 'main', { provider: 'fake', model: 'fake-echo' }, context.workspace.value)
    const surface = new AssistantControlSurface(control.ctx, 'main', context, catalog)
    const host = new LiveSessionHost(control.ctx, surface, catalog, context.workspace.value, () => {}, handle, false)
    try {
      surface.sendMessage('hold the turn')
      await waitUntil(() => handle.agent.status === 'running')
      await assert.rejects(
        () => host.switchTo(extra.id, { sessionId: 'main', revision: catalog.inspect().revision }),
        (error: SessionCatalogError) => error.code === 'busy',
      )
      assert.equal(surface.sessionId, 'main')
      release()
      await handle.agent.whenIdle()
      await host.switchTo(extra.id, { sessionId: 'main', revision: catalog.inspect().revision })
      assert.equal(surface.sessionId, extra.id)
    } finally {
      release()
      await host.currentHandle().dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('keeps approval origin after switch, decision, and delete', async () => {
    const { catalog, extra, host, surface, control } = await liveHost()
    try {
      const pending = surface.requestExecute('calendar', 'create_event', {
        calendarId: 'primary',
        title: 'Focus',
        start: '2026-08-21T09:00:00.000Z',
        end: '2026-08-21T10:00:00.000Z',
      })
      assert.equal(pending.kind, 'pending_confirmation')
      if (pending.kind !== 'pending_confirmation') return
      host.noteApprovals([pending.confirmationId])
      await host.switchTo(extra.id, { sessionId: 'main', revision: catalog.inspect().revision })
      await surface.deny(pending.confirmationId)
      const view = surface.workspace()
      assert.equal(view.approvals.find((item) => item.id === pending.confirmationId)?.sessionId, 'main')
      assert.equal(view.activity.find((item) => item.id === `approval-resolved-${pending.confirmationId}`)?.sessionId, 'main')
      await host.delete('main', { sessionId: extra.id, revision: catalog.inspect().revision, confirm: true })
      assert.equal(catalog.approvalOrigin(pending.confirmationId), 'main')
      assert.equal(surface.workspace().approvals.find((item) => item.id === pending.confirmationId)?.sessionId, 'main')
    } finally {
      await host.currentHandle().dispose()
      await control.ctx.fiber.dispose()
    }
  })
})
