import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { bootAssistantControl, bootSafeModeRuntime, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'

describe('registered workflows', () => {
  it('starts only host-registered workflows and fences jobs by owning session', async () => {
    const control = await bootAssistantControl({ allowFixtures: true })
    const first = await createAssistantAgent(control.ctx, 'workflow-first')
    const second = await createAssistantAgent(control.ctx, 'workflow-second')
    try {
      assert.equal(control.ctx.tools.get('workflow'), undefined)
      assert.equal(control.ctx.get('workflowEngine'), undefined)

      const catalog = await control.ctx.tools.execute({
        callId: CallId('registered-workflow-list'),
        name: 'list_registered_workflows',
        arguments: {},
        agent: first.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(catalog.isError, false)
      assert.match(JSON.stringify(catalog), /morning-brief/)

      const started = await control.ctx.tools.execute({
        callId: CallId('registered-workflow-start'),
        name: 'run_registered_workflow',
        arguments: { name: 'morning-brief' },
        agent: first.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(started.isError, false)
      const jobId = /assistant-\d+/.exec(JSON.stringify(started))?.[0]
      assert.ok(jobId)

      const foreignList = await control.ctx.tools.execute({
        callId: CallId('registered-workflow-foreign-list'),
        name: 'job_list',
        arguments: {},
        agent: second.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(foreignList.isError, false)
      assert.doesNotMatch(JSON.stringify(foreignList), new RegExp(jobId))

      const output = await control.ctx.tools.execute({
        callId: CallId('registered-workflow-output'),
        name: 'job_output',
        arguments: { job_id: jobId, wait: true, timeout_ms: 5_000 },
        agent: first.agent,
        signal: AbortSignal.timeout(6_000),
      })
      assert.equal(output.isError, false)
      assert.match(JSON.stringify(output), /Work brief/)
      assert.match(JSON.stringify(output), /Calendar \(\d+\)/)
      assert.match(JSON.stringify(output), /completed/)
    } finally {
      await first.dispose()
      await second.dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('allows inspection but not workflow start in Plan Mode, and withholds all controls in Safe Mode', async () => {
    const control = await bootAssistantControl({ allowFixtures: true })
    const handle = await createAssistantAgent(control.ctx, 'workflow-plan')
    const surface = new AssistantControlSurface(control.ctx, 'workflow-plan')
    try {
      surface.controlPlan(true)
      const catalog = await control.ctx.tools.execute({
        callId: CallId('registered-workflow-plan-list'),
        name: 'list_registered_workflows',
        arguments: {},
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(catalog.isError, false)

      const denied = await control.ctx.tools.execute({
        callId: CallId('registered-workflow-plan-start'),
        name: 'run_registered_workflow',
        arguments: { name: 'morning-brief' },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(denied.isError, true)
      assert.match(JSON.stringify(denied), /unavailable while Plan Mode is read-only/)
    } finally {
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }

    const safe = await bootSafeModeRuntime({ allowFixtures: true })
    try {
      assert.equal(safe.ctx.tools.get('run_registered_workflow'), undefined)
      assert.equal(safe.ctx.tools.get('job_list'), undefined)
    } finally {
      await safe.ctx.fiber.dispose()
    }
  })
})
