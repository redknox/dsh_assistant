import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as integrationsPlugin from '../src/plugins/integrations-plugin.js'
import { FakeClock } from '../src/adapters/jobs/interval-scheduler.js'
import * as jobsPlugin from '../src/plugins/jobs-plugin.js'
import * as policyPlugin from '../src/plugins/policy-plugin.js'
import { FakeIntegrationSuite } from '../src/adapters/integrations/fake-providers.js'
import { buildWorkBrief } from '../src/domain/jobs/work-brief.js'
import { KnowledgeService } from '../src/domain/knowledge/service.js'

async function bootJobs(clock?: FakeClock, everyMs?: number) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(integrationsPlugin)
  await ctx.plugin(policyPlugin)
  await ctx.plugin(jobsPlugin, {
    now: () => new Date(clock?.now() ?? Date.parse('2026-08-21T08:00:00.000Z')),
    clock,
    morningBriefEveryMs: everyMs,
    autoTickMs: clock ? null : 1000,
  })
  return ctx
}

describe('assistant jobs', () => {
  it('runs a recurring morning brief from fake local providers', async () => {
    const ctx = await bootJobs()
    const first = ctx.assistantJobs.service.start('morning-brief')
    const firstRun = await ctx.assistantJobs.service.wait(first.runId)
    assert.equal(firstRun.status, 'completed')
    assert.match(firstRun.summary ?? '', /Work brief/)
    assert.match(firstRun.summary ?? '', /Calendar \(3\)/)
    assert.match(firstRun.summary ?? '', /Open tasks \(1\)/)
    assert.match(firstRun.summary ?? '', /Recent mail \(1\)/)
    assert.match(firstRun.summary ?? '', /Team standup/)

    const second = ctx.assistantJobs.service.start('morning-brief')
    const secondRun = await ctx.assistantJobs.service.wait(second.runId)
    assert.equal(secondRun.status, 'completed')
    assert.equal(ctx.assistantJobs.service.lastRun('morning-brief')?.runId, second.runId)
    const status = ctx.assistantJobs.service.list().find((item) => item.name === 'morning-brief')
    assert.equal(status?.schedule.kind, 'every')
    assert.equal(ctx.jobs.get(first.jobId).status, 'completed')
    await ctx.fiber.dispose()
  })

  it('uses the requested local day and degrades one unavailable source without losing the brief', async () => {
    const suite = new FakeIntegrationSuite()
    suite.state.unavailable.mail = 'mail offline token=SECRET'
    suite.state.notConfigured.add('mail')

    const brief = await buildWorkBrief({
      hub: suite.hub,
      now: new Date('2026-08-20T16:30:00.000Z'),
      timeZone: 'Asia/Shanghai',
    })

    assert.match(brief, /Work brief — 2026-08-21/)
    assert.match(brief, /09:00–09:15 · "Team standup"/)
    assert.match(brief, /Calendar \(3\)/)
    assert.match(brief, /Mail: not connected/)
    assert.doesNotMatch(brief, /SECRET|offline token/)
  })

  it('retrieves knowledge related to the actual events and tasks in the brief', async () => {
    const suite = new FakeIntegrationSuite()
    const knowledge = new KnowledgeService()
    knowledge.ingest({
      sourceUri: 'vault/team-standup.md',
      sourceKind: 'note',
      title: 'Team standup playbook',
      text: 'For the Team standup, bring the Review agenda and name the decision owner.',
    })

    const brief = await buildWorkBrief({
      hub: suite.hub,
      knowledge,
      now: new Date('2026-08-21T08:00:00.000Z'),
      timeZone: 'UTC',
    })

    assert.match(brief, /Relevant knowledge \(1\)/)
    assert.match(brief, /Team standup playbook/)
    assert.match(brief, /decision owner/)
  })

  it('triggers morning brief twice from the scheduler after time advances', async () => {
    const clock = new FakeClock(Date.parse('2026-08-21T08:00:00.000Z'))
    const ctx = await bootJobs(clock, 60_000)
    assert.equal(ctx.assistantJobs.service.lastRun('morning-brief'), undefined)
    assert.equal(ctx.assistantJobs.scheduler.peek('morning-brief')?.nextRunAt, clock.now() + 60_000)

    clock.advance(60_000)
    assert.deepEqual(ctx.assistantJobs.scheduler.tick(), ['morning-brief'])
    const first = ctx.assistantJobs.service.lastRun('morning-brief')
    assert.ok(first)
    await ctx.assistantJobs.service.wait(first.runId)
    assert.equal(first.status === 'completed' || ctx.assistantJobs.service.getRun(first.runId)?.status === 'completed', true)

    clock.advance(60_000)
    assert.deepEqual(ctx.assistantJobs.scheduler.tick(), ['morning-brief'])
    const second = ctx.assistantJobs.service.lastRun('morning-brief')
    assert.ok(second)
    assert.notEqual(second.runId, first.runId)
    await ctx.assistantJobs.service.wait(second.runId)
    assert.equal(ctx.assistantJobs.service.getRun(second.runId)?.status, 'completed')
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
      schedule: { kind: 'manual' },
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
      schedule: { kind: 'manual' },
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
