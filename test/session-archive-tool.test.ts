import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { bootAssistantControl, createAssistantAgent } from '../src/runtime/boot.js'
import type { PublicSessionCatalog } from '../src/product/session-catalog.js'

function catalog(currentSessionId = 'delivery-1', revision = 7): PublicSessionCatalog {
  return {
    schemaVersion: 1,
    revision,
    currentSessionId,
    activeCount: 2,
    archivedCount: 0,
    sessions: [
      { id: 'main', title: 'Today', lifecycle: 'active', createdAt: '2026-09-07T00:00:00.000Z', lastActivityAt: '2026-09-07T00:00:00.000Z', persistence: 'persistent', current: false, management: true },
      { id: 'delivery-1', title: 'Build · text.morse.encode', lifecycle: 'active', createdAt: '2026-09-07T00:00:00.000Z', lastActivityAt: '2026-09-07T00:00:00.000Z', persistence: 'persistent', current: true, management: false },
    ],
    health: 'ok',
  }
}

describe('Session archive tool', () => {
  it('requests exact approval and archives through the host only after approval', async () => {
    const control = await bootAssistantControl()
    const handle = await createAssistantAgent(control.ctx, 'delivery-1')
    const archived: Array<{ id: string; expected: { sessionId: string; revision: number } }> = []
    const origins: string[][] = []
    control.ctx.sessionArchive.bind({
      inspect: () => catalog(),
      noteApprovals: (ids) => { origins.push([...ids]) },
      archive: async (id, expected) => {
        archived.push({ id, expected })
        return catalog('main', 8)
      },
    })
    try {
      const result = await control.ctx.tools.execute({
        callId: CallId('archive-current'),
        name: 'request_session_archive',
        arguments: {},
        agent: handle.agent,
        signal: new AbortController().signal,
      })
      assert.equal(result.isError, false)
      const outcome = JSON.parse(String(result.value)) as { kind: string; confirmationId: string }
      assert.equal(outcome.kind, 'pending_confirmation')
      assert.deepEqual(origins, [[outcome.confirmationId]])
      assert.deepEqual(archived, [])

      const approved = await control.ctx.actionPolicy.policy.resolve(outcome.confirmationId, 'approve')
      assert.equal(approved.kind, 'allow')
      assert.deepEqual(archived, [{ id: 'delivery-1', expected: { sessionId: 'delivery-1', revision: 7 } }])
    } finally {
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('exposes a deterministic /archive command without sending text to the model', async () => {
    const control = await bootAssistantControl()
    const handle = await createAssistantAgent(control.ctx, 'delivery-1')
    control.ctx.sessionArchive.bind({
      inspect: () => catalog(),
      noteApprovals: () => {},
      archive: async () => catalog('main', 8),
    })
    try {
      assert.equal(control.ctx.commands.list(handle.agent).some((item) => item.name === 'archive'), true)
      const execution = await control.ctx.commands.execute(handle.agent, '/archive', [], new AbortController().signal)
      assert.equal(execution?.result.kind, 'success')
      assert.match(execution?.result.text ?? '', /ARCHIVE CONVERSATION/)
      assert.equal(control.ctx.actionPolicy.policy.confirmations().length, 1)
      assert.equal(handle.agent.session.events.some((event) => event.type === 'user/message'), false)
    } finally {
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('refuses to archive the permanent Today session', async () => {
    const control = await bootAssistantControl()
    const handle = await createAssistantAgent(control.ctx, 'main')
    control.ctx.sessionArchive.bind({
      inspect: () => catalog('main'),
      noteApprovals: () => {},
      archive: async () => catalog(),
    })
    try {
      const result = await control.ctx.tools.execute({
        callId: CallId('archive-today'),
        name: 'request_session_archive',
        arguments: {},
        agent: handle.agent,
        signal: new AbortController().signal,
      })
      assert.equal(result.isError, true)
      assert.match(result.content.map((block) => block.type === 'text' ? block.text : '').join(''), /Today.*cannot be archived/i)
      assert.equal(control.ctx.actionPolicy.policy.confirmations().length, 0)
    } finally {
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })
})
