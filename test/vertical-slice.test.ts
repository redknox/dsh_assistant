import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PLAN_MY_DAY_FOCUS, PlanMyDayAdapter } from '../src/adapters/llm/plan-my-day-adapter.js'
import { bootAssistantRuntime, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'
import { renderAssistantViewAsText } from '../src/ui/surface.js'

const fixture = join(import.meta.dirname, '..', 'fixtures', 'knowledge', 'office-hours.md')

describe('plan-my-day vertical slice', () => {
  it('runs user input through DSH loop, memory, knowledge, tools, policy, jobs, and UI', async () => {
    const ctx = await bootAssistantRuntime({ knowledgeFixturePaths: [fixture] })
    ctx.llm.registerAdapter(['fake'], new PlanMyDayAdapter())
    const handle = await createAssistantAgent(ctx, 'plan-my-day', { provider: 'fake', model: 'plan-my-day' })
    const ui = new AssistantControlSurface(ctx, 'plan-my-day')
    const agent = ctx.agents.get(SessionId('plan-my-day'))
    assert.ok(agent)

    try {
      ui.remember({
        category: 'preference',
        topicKey: 'briefing',
        statement: 'Prefers a short morning brief',
      })
      const eventsBefore = (await ctx.integrations.hub.calendar().listEvents({
        from: '2026-08-21T00:00:00.000Z',
        to: '2026-08-21T23:59:59.000Z',
      })).items.length

      ui.sendMessage('Plan my day')
      await agent.whenIdle()

      const afterPlan = ui.snapshot()
      assert.equal(afterPlan.conversation.some((item) => item.kind === 'user' && item.text.includes('Plan my day')), true)
      assert.equal(afterPlan.conversation.some((item) => item.kind === 'tool_call' && item.toolName === 'recall_memory'), true)
      assert.equal(afterPlan.conversation.some((item) => item.kind === 'tool_call' && item.toolName === 'retrieve_knowledge'), true)
      assert.equal(afterPlan.conversation.some((item) => item.kind === 'tool_call' && item.toolName === 'calendar_list_events'), true)
      assert.equal(afterPlan.conversation.some((item) => item.kind === 'tool_call' && item.toolName === 'calendar_propose_event'), true)
      assert.equal(afterPlan.conversation.some((item) => item.kind === 'tool_call' && item.toolName === 'calendar_create_event'), true)
      assert.equal(afterPlan.conversation.some((item) => item.kind === 'assistant' && item.text.includes('pending confirmation')), true)
      assert.ok(afterPlan.memory.some((item) => item.topicKey === 'briefing' && item.status === 'active'))
      assert.ok(afterPlan.knowledgeSources.some((item) => item.sourceUri.includes('office-hours')))

      const pending = afterPlan.confirmations.find((item) => item.status === 'pending' && item.operation === 'create_event')
      assert.ok(pending)
      assert.deepEqual(pending.payload, { ...PLAN_MY_DAY_FOCUS })
      const approved = await ui.approve(pending.id)
      assert.equal(approved.kind, 'allow')
      assert.equal((await ctx.integrations.hub.calendar().listEvents({
        from: '2026-08-21T00:00:00.000Z',
        to: '2026-08-21T23:59:59.000Z',
      })).items.length, eventsBefore + 1)
      const replay = await ui.approve(pending.id)
      assert.equal(replay.kind, 'deny')
      if (replay.kind !== 'deny') throw new Error('expected replay deny')
      assert.equal(replay.code, 'replay')
      assert.equal((await ctx.integrations.hub.calendar().listEvents({
        from: '2026-08-21T00:00:00.000Z',
        to: '2026-08-21T23:59:59.000Z',
      })).items.length, eventsBefore + 1)

      const brief = ui.startJob('morning-brief')
      const briefRun = await ui.waitJob(brief.runId)
      assert.equal(briefRun.status, 'completed')
      assert.match(briefRun.summary ?? '', /Work brief/)
      assert.match(briefRun.summary ?? '', /Calendar \(\d+\)/)

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
      assert.equal((await ui.waitJob(held.runId)).status, 'killed')

      ui.sendMessage('Try an invalid calendar query')
      await agent.whenIdle()
      const failed = ui.snapshot()
      assert.equal(failed.conversation.some((item) => item.kind === 'tool_result' && item.text.includes('invalid_request')), true)
      assert.equal(failed.conversation.some((item) => item.kind === 'assistant' && item.text.includes('rejected')), true)

      ui.retrieveKnowledge('print confirmation')
      const view = ui.snapshot()
      assert.ok(view.knowledgeHits.some((item) => item.sourceUri.includes('office-hours')))
      assert.equal(view.jobs.find((job) => job.name === 'morning-brief')?.lastRunStatus, 'completed')
      assert.equal(view.jobs.find((job) => job.name === 'hold')?.lastRunStatus, 'killed')
      assert.equal(view.confirmations.some((item) => item.id === pending.id && item.status === 'consumed'), true)
      assert.match(renderAssistantViewAsText(view), /Focus block|pending confirmation|invalid_request|Prefers a short morning brief/)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })
})
