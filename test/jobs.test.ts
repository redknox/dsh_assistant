import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as integrationsPlugin from '../src/plugins/integrations-plugin.js'
import * as jobsPlugin from '../src/plugins/jobs-plugin.js'
import * as policyPlugin from '../src/plugins/policy-plugin.js'

async function bootJobs() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(integrationsPlugin)
  await ctx.plugin(policyPlugin)
  await ctx.plugin(jobsPlugin, { now: () => new Date('2026-08-21T08:00:00.000Z') })
  return ctx
}

describe('assistant jobs', () => {
  it('runs a recurring morning brief from fake local providers', async () => {
    const ctx = await bootJobs()
    const first = ctx.assistantJobs.service.start('morning-brief')
    const firstRun = await ctx.assistantJobs.service.wait(first.runId)
    assert.equal(firstRun.status, 'completed')
    assert.match(firstRun.summary ?? '', /calendarEvents: 3/)
    assert.match(firstRun.summary ?? '', /openTasks: 1/)

    const second = ctx.assistantJobs.service.start('morning-brief')
    const secondRun = await ctx.assistantJobs.service.wait(second.runId)
    assert.equal(secondRun.status, 'completed')
    assert.equal(ctx.assistantJobs.service.lastRun('morning-brief')?.runId, second.runId)
    const status = ctx.assistantJobs.service.list().find((item) => item.name === 'morning-brief')
    assert.equal(status?.recurrence, 'recurring')
    assert.equal(ctx.jobs.get(first.jobId).status, 'completed')
    await ctx.fiber.dispose()
  })

  it('sends job-triggered mutations through policy', async () => {
    const ctx = await bootJobs()
    const before = (await ctx.integrations.hub.tasks().listTasks({})).items.length
    const created = await ctx.assistantJobs.service.wait(ctx.assistantJobs.service.start('create-followup-task').runId)
    assert.equal(created.status, 'completed')
    assert.match(created.summary ?? '', /"kind":"allow"/)
    assert.equal((await ctx.integrations.hub.tasks().listTasks({})).items.length, before + 1)

    const filesBefore = (await ctx.integrations.hub.files().listFiles({})).items.length
    const blocked = await ctx.assistantJobs.service.wait(ctx.assistantJobs.service.start('delete-file', { id: 'f-1' }).runId)
    assert.equal(blocked.status, 'completed')
    assert.match(blocked.summary ?? '', /pending_confirmation/)
    assert.equal((await ctx.integrations.hub.files().listFiles({})).items.length, filesBefore)
    await ctx.fiber.dispose()
  })

  it('records cancellation and failure without leaking secrets', async () => {
    const ctx = await bootJobs()
    ctx.assistantJobs.service.register({
      name: 'hold',
      title: 'Hold',
      recurrence: 'manual',
      intent: 'read',
      run({ signal }) {
        if (signal.aborted) throw new Error('cancelled')
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        })
      },
    })
    ctx.assistantJobs.service.register({
      name: 'fail',
      title: 'Fail',
      recurrence: 'manual',
      intent: 'read',
      async run() {
        throw new Error('provider exploded; token=SECRET')
      },
    })

    const held = ctx.assistantJobs.service.start('hold')
    assert.equal(ctx.jobs.get(held.jobId).status, 'running')
    ctx.assistantJobs.service.cancel(held.runId)
    const cancelled = await ctx.assistantJobs.service.wait(held.runId)
    assert.equal(cancelled.status, 'killed')
    assert.equal(ctx.jobs.get(held.jobId).status, 'killed')

    const failed = await ctx.assistantJobs.service.wait(ctx.assistantJobs.service.start('fail').runId)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error, 'failed')
    const snapshot = ctx.jobs.get(ctx.assistantJobs.service.lastRun('fail')!.jobId)
    assert.equal(snapshot.status, 'failed')
    assert.equal(JSON.stringify(ctx.assistantJobs.service.list()).includes('SECRET'), false)
    assert.equal(snapshot.detail?.includes('SECRET'), false)
    await ctx.fiber.dispose()
  })
})
