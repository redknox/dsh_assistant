import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { FakeReplyAdapter } from '../src/adapters/llm/fake-reply-adapter.js'
import { bootAssistantControl, bootSafeModeRuntime, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'

class GateAdapter extends LlmAdapter {
  invocations = 0
  private releaseGate!: () => void
  private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve })

  release(): void { this.releaseGate() }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.invocations += 1
    await this.gate
    if (options.signal?.aborted) throw options.signal.reason
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition was not reached')
}

describe('governed subagents', () => {
  it('runs a fresh one-shot child and releases it after returning only the final answer', async () => {
    const control = await bootAssistantControl({ allowFixtures: true })
    const adapter = new FakeReplyAdapter('bounded child answer')
    control.ctx.llm.registerAdapter(['fake'], adapter)
    const parent = await createAssistantAgent(control.ctx, 'subagent-parent', { provider: 'fake', model: 'fake' })
    let childId: Parameters<NonNullable<Parameters<typeof control.ctx.on<'subagent/start'>>[1]>>[0]['id'] | undefined
    control.ctx.on('subagent/start', (info) => { childId = info.id })
    try {
      assert.equal(control.ctx.tools.get('subagent'), undefined)
      assert.equal(control.ctx.tools.get('send_message'), undefined)
      const result = await control.ctx.tools.execute({
        callId: CallId('governed-subagent'),
        name: 'delegate_task',
        arguments: { description: 'inspect facts', prompt: 'Return the bounded answer.' },
        agent: parent.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(result.isError, false)
      assert.match(JSON.stringify(result), /bounded child answer/)
      assert.equal(adapter.invocations, 1)
      assert.ok(childId)
      assert.equal(control.ctx.agents.get(childId), undefined)
    } finally {
      await parent.dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('enforces absolute depth 3 and withholds delegation in Plan and Safe Mode', async () => {
    const control = await bootAssistantControl({ allowFixtures: true })
    control.ctx.llm.registerAdapter(['fake'], new FakeReplyAdapter('should not run'))
    const parent = await createAssistantAgent(control.ctx, 'subagent-depth', {
      provider: 'fake', model: 'fake', subagentDepth: 3,
    })
    const surface = new AssistantControlSurface(control.ctx, 'subagent-depth')
    try {
      const deniedDepth = await control.ctx.tools.execute({
        callId: CallId('governed-subagent-depth'),
        name: 'delegate_task',
        arguments: { description: 'too deep', prompt: 'Do not run.' },
        agent: parent.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(deniedDepth.isError, true)
      assert.match(JSON.stringify(deniedDepth), /depth 4 exceeds maxDepth 3/)

      surface.controlPlan(true)
      const deniedPlan = await control.ctx.tools.execute({
        callId: CallId('governed-subagent-plan'),
        name: 'delegate_task',
        arguments: { description: 'plan task', prompt: 'Do not run.' },
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
      assert.equal(safe.ctx.tools.get('delegate_task'), undefined)
      assert.equal(safe.ctx.get('subagents'), undefined)
    } finally {
      await safe.ctx.fiber.dispose()
    }
  })

  it('caps the complete runtime at four simultaneous child runs', async () => {
    const control = await bootAssistantControl({ allowFixtures: true })
    const adapter = new GateAdapter()
    control.ctx.llm.registerAdapter(['gate'], adapter)
    const parent = await createAssistantAgent(control.ctx, 'subagent-cap', { provider: 'gate', model: 'gate' })
    const call = (index: number) => control.ctx.tools.execute({
      callId: CallId(`governed-subagent-cap-${index}`),
      name: 'delegate_task',
      arguments: { description: `child ${index}`, prompt: `Wait as child ${index}.` },
      agent: parent.agent,
      signal: AbortSignal.timeout(5_000),
    })
    try {
      const running = [0, 1, 2, 3].map(call)
      await until(() => adapter.invocations === 4)
      const denied = await call(4)
      assert.equal(denied.isError, true)
      assert.match(JSON.stringify(denied), /at most 4 subagents may run at once/)
      adapter.release()
      const results = await Promise.all(running)
      assert.equal(results.every((result) => !result.isError), true)
    } finally {
      adapter.release()
      await parent.dispose()
      await control.ctx.fiber.dispose()
    }
  })
})
