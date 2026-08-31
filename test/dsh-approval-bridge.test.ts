import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DshApprovalBroker } from '../src/domain/approval/index.js'
import { AssistantControlSurface } from '../src/ui/controller.js'
import { bootAssistantControl, createAssistantAgent } from '../src/runtime/boot.js'

describe('DSH approval bridge', () => {
  it('settles each exact request once and fails closed on disposal', async () => {
    const broker = new DshApprovalBroker()
    const allowed = broker.open({ requestId: 'request-1', toolName: 'tool_fs', sessionId: 'main', arguments: { path: 'note.md' } })
    const card = broker.list()[0]
    assert.equal(card?.status, 'pending')
    assert.match(card?.fingerprint ?? '', /^[a-f0-9]{64}$/)
    broker.resolve(card!.id, 'approve')
    assert.equal(await allowed, 'allowed-once')
    assert.throws(() => broker.resolve(card!.id, 'approve'), /stale/)

    const unavailable = broker.open({ requestId: 'request-2', toolName: 'tool_bash', sessionId: 'main' })
    broker.dispose()
    assert.equal(await unavailable, 'unavailable')
  })

  it('pauses a DSH tool, exposes one unified card, and resumes without re-executing it', async () => {
    const control = await bootAssistantControl({ allowFixtures: false })
    const handle = await createAssistantAgent(control.ctx, 'dsh-approval-test')
    const agent = handle.agent
    let executions = 0
    const unregister = control.ctx.tools.register(defineTool({
      name: 'approval_probe',
      description: 'approval integration probe',
      parameters: { value: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        executions += 1
        return args.value
      },
    }))
    const removeGate = control.ctx.on('tools/pre-execute', async (exec, next) => (
      exec.name === 'approval_probe' ? { kind: 'ask' as const, reason: 'outside the configured sandbox' } : next()
    ))

    try {
      agent.session.append('turn/start', { turn: 0 })
      agent.session.append('step/start', { turn: 0, step: 0 })
      agent.session.append('tool/call', {
        turn: 0,
        step: 0,
        callId: CallId('approval-call-1'),
        name: 'approval_probe',
        arguments: JSON.stringify({ value: 'ran once', token: 'must-not-leak' }),
      })
      const execution = control.ctx.tools.execute({
        callId: CallId('approval-call-1'),
        name: 'approval_probe',
        arguments: { value: 'ran once', token: 'must-not-leak' },
        agent,
        signal: AbortSignal.timeout(5_000),
      })

      const surface = new AssistantControlSurface(control.ctx, String(agent.id))
      const card = await waitForApproval(surface)
      assert.equal(card.kind, 'dsh-tool')
      assert.equal(card.target, 'approval_probe')
      assert.match(card.details.join('\n'), /outside the configured sandbox/)
      assert.doesNotMatch(card.details.join('\n'), /must-not-leak/)
      assert.equal(executions, 0)

      await surface.resolveApproval(card, 'approve')
      const result = await execution
      assert.equal(result.isError, false)
      assert.equal(result.value, 'ran once')
      assert.equal(executions, 1)
      assert.equal(agent.session.events.some((event) => event.type === 'approval/decided' && event.data.outcome === 'allowed-once'), true)
    } finally {
      removeGate()
      unregister()
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })
})

async function waitForApproval(surface: AssistantControlSurface) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const card = surface.workspace().approvals.find((item) => item.kind === 'dsh-tool' && item.status === 'pending')
    if (card) return card
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('DSH approval did not reach the workspace')
}
