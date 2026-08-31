import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { FakeReplyAdapter } from '../src/adapters/llm/fake-reply-adapter.js'
import { bootAssistantControl, bootSafeModeRuntime, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'

const analysisInput = {
  tasks: [
    { id: 'one', label: 'First question', prompt: 'Analyze the first independent question.' },
    { id: 'two', label: 'Second question', prompt: 'Analyze the second independent question.' },
  ],
}

class CapturingAdapter extends FakeReplyAdapter {
  readonly requests: GenerateOptions[] = []

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.requests.push(options)
    yield* super.stream(options)
  }
}

class CancelAwareAdapter extends LlmAdapter {
  invocations = 0

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.invocations += 1
    await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(options.signal?.reason ?? new Error('aborted'))
      if (options.signal?.aborted) abort()
      else options.signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition was not reached')
}

describe('registered workflows', () => {
  it('runs a fixed native DSH workflow through governed children and disposes them', async () => {
    const control = await bootAssistantControl({ allowFixtures: true })
    const adapter = new CapturingAdapter('bounded native result')
    control.ctx.llm.registerAdapter(['fake'], adapter)
    const parent = await createAssistantAgent(control.ctx, 'workflow-parent', { provider: 'fake', model: 'fake' }, process.cwd())
    const lifecycle: string[] = []
    const childHeaders: Array<typeof parent.agent.session.header> = []
    control.ctx.on('subagent/start', (info) => {
      const child = control.ctx.agents.get(info.id)
      if (child) childHeaders.push(child.session.header)
    })
    control.ctx.on('workflow/start', () => { lifecycle.push('start') })
    control.ctx.on('workflow/agent-start', (_run, agent) => { lifecycle.push(`agent-start:${agent.seq}`) })
    control.ctx.on('workflow/agent-end', (_run, agent) => { lifecycle.push(`agent-end:${agent.seq}:${agent.outcome}`) })
    control.ctx.on('workflow/end', (_run, result) => { lifecycle.push(`end:${result.stopReason}`) })
    try {
      assert.ok(control.ctx.workflowEngine)
      assert.equal(control.ctx.tools.get('workflow'), undefined)

      const catalog = await control.ctx.tools.execute({
        callId: CallId('registered-workflow-list'),
        name: 'list_registered_workflows',
        arguments: {},
        agent: parent.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(catalog.isError, false)
      assert.match(JSON.stringify(catalog), /parallel-analysis/)
      assert.doesNotMatch(JSON.stringify(catalog), /morning-brief/)

      const completed = await control.ctx.tools.execute({
        callId: CallId('registered-workflow-run'),
        name: 'run_registered_workflow',
        arguments: { name: 'parallel-analysis', input: analysisInput },
        agent: parent.agent,
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(completed.isError, false)
      assert.equal(typeof completed.value, 'string')
      const workflowValue = JSON.parse(completed.value as string) as { agentsStarted: number; result: unknown }
      assert.equal(workflowValue.agentsStarted, 2)
      assert.equal((JSON.stringify(workflowValue.result).match(/bounded native result/g) ?? []).length, 2)
      assert.equal(adapter.invocations, 2)
      assert.equal(adapter.requests.length, 2)
      for (const request of adapter.requests) {
        const tools = new Set(request.tools?.map((tool) => tool.name))
        assert.equal(tools.has('recall_memory'), true)
        assert.equal(tools.has('calendar_list_events'), true)
        assert.equal(tools.has('write_candidate_file'), false)
        assert.equal(tools.has('run_registered_workflow'), false)
        assert.equal(tools.has('workflow'), false)
      }
      assert.equal(childHeaders.length, 2)
      for (const header of childHeaders) {
        assert.equal(header.cwd, parent.agent.session.header.cwd)
        assert.equal(header.parentSession, parent.agent.id)
        assert.equal(header.seedLength, undefined)
        assert.equal(header.origin, 'subagent')
        assert.equal(header.delegationDepth, 1)
      }
      assert.equal(control.ctx.agents.list().length, 1)
      assert.equal(lifecycle[0], 'start')
      assert.equal(lifecycle.at(-1), 'end:completed')
      assert.equal(lifecycle.filter((item) => item.startsWith('agent-start:')).length, 2)
      assert.equal(lifecycle.filter((item) => item.includes('agent-end:') && item.endsWith(':completed')).length, 2)

      const unknown = await control.ctx.tools.execute({
        callId: CallId('registered-workflow-unknown'),
        name: 'run_registered_workflow',
        arguments: { name: 'not-registered', input: analysisInput },
        agent: parent.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(unknown.isError, true)
      assert.match(JSON.stringify(unknown), /unknown registered workflow/)
    } finally {
      await parent.dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('shares the absolute depth boundary and respects Plan and Safe Mode', async () => {
    const control = await bootAssistantControl({ allowFixtures: true })
    control.ctx.llm.registerAdapter(['fake'], new FakeReplyAdapter('should not run'))
    const parent = await createAssistantAgent(control.ctx, 'workflow-depth', {
      provider: 'fake', model: 'fake', subagentDepth: 3,
    })
    const surface = new AssistantControlSurface(control.ctx, 'workflow-depth')
    try {
      const deniedDepth = await control.ctx.tools.execute({
        callId: CallId('registered-workflow-depth'),
        name: 'run_registered_workflow',
        arguments: { name: 'parallel-analysis', input: analysisInput },
        agent: parent.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(deniedDepth.isError, true)
      assert.match(JSON.stringify(deniedDepth), /depth 4 exceeds maxDepth 3/)

      surface.controlPlan(true)
      const catalog = await control.ctx.tools.execute({
        callId: CallId('registered-workflow-plan-list'),
        name: 'list_registered_workflows',
        arguments: {},
        agent: parent.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(catalog.isError, false)
      const deniedPlan = await control.ctx.tools.execute({
        callId: CallId('registered-workflow-plan-run'),
        name: 'run_registered_workflow',
        arguments: { name: 'parallel-analysis', input: analysisInput },
        agent: parent.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(deniedPlan.isError, true)
      assert.match(JSON.stringify(deniedPlan), /unavailable while Plan Mode is read-only/)
    } finally {
      await parent.dispose()
      await control.ctx.fiber.dispose()
    }

    const safe = await bootSafeModeRuntime({ allowFixtures: true })
    try {
      assert.equal(safe.ctx.tools.get('run_registered_workflow'), undefined)
      assert.equal(safe.ctx.tools.get('list_registered_workflows'), undefined)
      assert.equal(safe.ctx.get('workflowEngine'), undefined)
    } finally {
      await safe.ctx.fiber.dispose()
    }
  })

  it('propagates caller cancellation and reaches child quiescence', async () => {
    const control = await bootAssistantControl({ allowFixtures: true })
    const adapter = new CancelAwareAdapter()
    control.ctx.llm.registerAdapter(['cancel-aware'], adapter)
    const parent = await createAssistantAgent(control.ctx, 'workflow-cancel', {
      provider: 'cancel-aware', model: 'cancel-aware',
    })
    const controller = new AbortController()
    try {
      const pending = control.ctx.tools.execute({
        callId: CallId('registered-workflow-cancel'),
        name: 'run_registered_workflow',
        arguments: {
          name: 'parallel-analysis',
          input: { tasks: [analysisInput.tasks[0]] },
        },
        agent: parent.agent,
        signal: controller.signal,
      })
      await until(() => adapter.invocations === 1)
      controller.abort(new Error('test cancellation'))
      const cancelled = await pending
      assert.equal(cancelled.isError, true)
      assert.match(JSON.stringify(cancelled), /cancel|abort|test cancellation/i)
      assert.equal(control.ctx.agents.list().length, 1)
    } finally {
      controller.abort()
      await parent.dispose()
      await control.ctx.fiber.dispose()
    }
  })
})
