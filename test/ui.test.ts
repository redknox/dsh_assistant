import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { bootAssistantRuntime, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'
import { projectConversationFromEvents } from '../src/ui/projection.js'
import { renderAssistantViewAsHtml, renderAssistantViewAsText } from '../src/ui/surface.js'

const fixture = join(import.meta.dirname, '..', 'fixtures', 'knowledge', 'office-hours.md')

describe('assistant UI projection and control surface', () => {
  it('projects session/tool boundaries from public session events', () => {
    const session = Session.create(SessionId('ui-transcript'))
    const callId = CallId('ui-retrieve-1')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'What are the print rules?' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: 'retrieve_knowledge',
      arguments: '{"query":"print rules"}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'Print jobs need confirmation at the library desk.' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Print jobs need a desk confirmation.' }],
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })

    const conversation = projectConversationFromEvents(session.events, [
      { id: 'queued-1', text: 'Also remind me tomorrow' },
    ])
    assert.deepEqual(conversation.map((item) => item.kind), ['user', 'tool_call', 'tool_result', 'assistant', 'queued'])
    assert.equal(conversation[1]?.toolName, 'retrieve_knowledge')
    assert.equal(conversation[1]?.callId, 'ui-retrieve-1')
    assert.equal(conversation[2]?.callId, 'ui-retrieve-1')
    assert.match(conversation[0]?.text ?? '', /print rules/)
  })

  it('drives confirm, memory, knowledge, and jobs through the control surface', async () => {
    const ctx = await bootAssistantRuntime({ knowledgeFixturePaths: [fixture] })
    const handle = await createAssistantAgent(ctx, 'ui-e2e')
    const ui = new AssistantControlSurface(ctx, 'ui-e2e')
    try {
      ui.sendMessage('Also remind me tomorrow')
      const queuedView = ui.snapshot()
      assert.equal(queuedView.conversation.some((item) => item.kind === 'queued' && item.text.includes('remind me')), true)
      assert.match(renderAssistantViewAsText(queuedView), /\[queued\] Also remind me tomorrow/)
      assert.match(renderAssistantViewAsHtml(queuedView), /data-kind="queued"/)
      const remembered = ui.remember({
        category: 'preference',
        topicKey: 'briefing',
        statement: 'Prefers a short morning brief',
      })
      ui.editMemory({ id: remembered.record.id, statement: 'Prefers a very short morning brief' })
      ui.retrieveKnowledge('print confirmation')
      const source = ui.inspectSource(ui.snapshot().knowledgeHits[0]?.documentId ?? '')
      assert.ok(source)
      assert.match(source.sourceUri, /office-hours/)

      const brief = ui.startJob('morning-brief')
      const briefRun = await ui.waitJob(brief.runId)
      assert.equal(briefRun.status, 'completed')

      ctx.assistantJobs.service.register({
        name: 'hold',
        title: 'Hold',
        schedule: { kind: 'manual' },
        intent: 'read',
        run({ signal }) {
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
          })
        },
      })
      const held = ui.startJob('hold')
      assert.equal(ui.cancelJob(held.runId), 'requested')
      const cancelled = await ui.waitJob(held.runId)
      assert.equal(cancelled.status, 'killed')

      const pending = ui.requestExecute('files', 'delete', { id: 'f-1' })
      assert.equal(pending.kind, 'pending_confirmation')
      if (pending.kind !== 'pending_confirmation') throw new Error('expected pending')
      const denied = await ui.deny(pending.confirmationId)
      assert.equal(denied.kind, 'deny')
      assert.equal((await ctx.integrations.hub.files().listFiles({})).items.length, 1)

      const again = ui.requestExecute('files', 'delete', { id: 'f-1' })
      assert.equal(again.kind, 'pending_confirmation')
      if (again.kind !== 'pending_confirmation') throw new Error('expected pending')
      assert.notEqual(again.confirmationId, pending.confirmationId)
      assert.equal(again.fingerprint, pending.fingerprint)
      const approved = await ui.approve(again.confirmationId)
      assert.equal(approved.kind, 'allow')
      assert.equal((await ctx.integrations.hub.files().listFiles({})).items.length, 0)

      ui.cancelAgentWork()
      const view = ui.snapshot()
      assert.equal(view.memory.some((item) => item.statement.includes('very short') && item.status === 'active'), true)
      assert.ok(view.knowledgeSources.some((item) => item.sourceUri.includes('office-hours')))
      assert.ok(view.knowledgeHits.some((item) => item.excerpt.length > 0 && item.sourceUri.includes('office-hours')))
      assert.match(view.knowledgeTrace ?? '', /selected/)
      assert.equal(view.jobs.find((job) => job.name === 'morning-brief')?.lastRunStatus, 'completed')
      assert.equal(view.jobs.find((job) => job.name === 'hold')?.lastRunStatus, 'killed')
      assert.equal(view.confirmations.some((item) => item.id === pending.confirmationId && item.status === 'denied'), true)
      assert.equal(view.confirmations.some((item) => item.id === again.confirmationId && item.status === 'consumed'), true)
      assert.ok(view.capabilities.some((item) => item.capability === 'calendar' && item.available))

      const text = renderAssistantViewAsText(view)
      const html = renderAssistantViewAsHtml(view)
      assert.match(text, /Prefers a very short morning brief/)
      assert.match(html, /id="jobs"/)
      assert.match(html, /data-confirmation-id="conf-/)
      assert.match(html, /id="knowledge-sources"/)

      ui.forgetMemory(remembered.record.id)
      assert.equal(ui.snapshot().memory.find((item) => item.id === remembered.record.id)?.status, 'deleted')
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })
})
