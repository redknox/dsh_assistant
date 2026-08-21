import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { EXAMPLE_PERSONAL_POLICY, PolicyService } from '../src/domain/policy/index.js'
import * as integrationsPlugin from '../src/plugins/integrations-plugin.js'
import * as policyPlugin from '../src/plugins/policy-plugin.js'

const EVENT = {
  title: '1:1',
  start: '2026-08-22T02:00:00.000Z',
  end: '2026-08-22T02:30:00.000Z',
}

describe('action policy', () => {
  it('allows read and propose without creating an execute side effect', async () => {
    let executed = 0
    const policy = new PolicyService(EXAMPLE_PERSONAL_POLICY)
    policy.registerExecutor('calendar', 'create_event', async () => {
      executed += 1
      return { id: 'x' }
    })
    const read = await policy.apply({
      capability: 'calendar',
      operation: 'list_events',
      intent: 'read',
      payload: { from: 'a', to: 'b' },
    })
    const draft = await policy.apply({
      capability: 'calendar',
      operation: 'propose_event',
      intent: 'propose',
      payload: EVENT,
    })
    assert.equal(read.kind, 'allow')
    assert.equal(read.level, 'L0')
    assert.equal(draft.kind, 'allow')
    assert.equal(draft.level, 'L1')
    assert.equal(executed, 0)
  })

  it('returns a pending confirmation and executes the bound action only once', async () => {
    let executed = 0
    const policy = new PolicyService(EXAMPLE_PERSONAL_POLICY)
    policy.registerExecutor('calendar', 'create_event', async (payload) => {
      executed += 1
      return payload
    })
    const pending = await policy.apply({
      capability: 'calendar',
      operation: 'create_event',
      intent: 'execute',
      payload: EVENT,
    })
    assert.equal(pending.kind, 'pending_confirmation')
    assert.equal(executed, 0)
    if (pending.kind !== 'pending_confirmation') throw new Error('expected pending')

    const approved = await policy.resolve(pending.confirmationId, 'approve')
    assert.equal(approved.kind, 'allow')
    assert.equal(executed, 1)
    if (approved.kind !== 'allow') throw new Error('expected allow')
    assert.deepEqual(approved.result, EVENT)

    const replay = await policy.resolve(pending.confirmationId, 'approve')
    assert.equal(replay.kind, 'deny')
    if (replay.kind !== 'deny') throw new Error('expected deny')
    assert.equal(replay.code, 'replay')
    assert.equal(executed, 1)
  })

  it('denies or cancels without executing, and ignores a later approve', async () => {
    let executed = 0
    const policy = new PolicyService(EXAMPLE_PERSONAL_POLICY)
    policy.registerExecutor('files', 'delete', async () => {
      executed += 1
      return { deleted: true }
    })
    const pending = await policy.apply({
      capability: 'files',
      operation: 'delete',
      intent: 'execute',
      payload: { id: 'f-1' },
    })
    assert.equal(pending.kind, 'pending_confirmation')
    assert.equal(pending.level, 'L4')
    if (pending.kind !== 'pending_confirmation') throw new Error('expected pending')

    const denied = await policy.resolve(pending.confirmationId, 'deny')
    assert.equal(denied.kind, 'deny')
    assert.equal(executed, 0)
    const afterDeny = await policy.resolve(pending.confirmationId, 'approve')
    assert.equal(afterDeny.kind, 'deny')
    assert.equal(executed, 0)

    const cancelledPending = await policy.apply({
      capability: 'files',
      operation: 'delete',
      intent: 'execute',
      payload: { id: 'f-2' },
    })
    if (cancelledPending.kind !== 'pending_confirmation') throw new Error('expected pending')
    const controller = new AbortController()
    controller.abort()
    const cancelled = await policy.resolve(cancelledPending.confirmationId, 'approve', controller.signal)
    assert.equal(cancelled.kind, 'deny')
    if (cancelled.kind !== 'deny') throw new Error('expected deny')
    assert.equal(cancelled.code, 'cancelled')
    assert.equal(executed, 0)
  })

  it('auto-executes L3 when configured and never auto-executes L4', async () => {
    let tasks = 0
    let files = 0
    const policy = new PolicyService({
      ...EXAMPLE_PERSONAL_POLICY,
      autoExecute: ['tasks', 'files'],
    })
    policy.registerExecutor('tasks', 'create', async (payload) => {
      tasks += 1
      return payload
    })
    policy.registerExecutor('files', 'delete', async (payload) => {
      files += 1
      return payload
    })
    const task = await policy.apply({
      capability: 'tasks',
      operation: 'create',
      intent: 'execute',
      payload: { title: 'Buy milk' },
    })
    const file = await policy.apply({
      capability: 'files',
      operation: 'delete',
      intent: 'execute',
      payload: { id: 'f-1' },
    })
    assert.equal(task.kind, 'allow')
    assert.equal(task.level, 'L3')
    assert.equal(tasks, 1)
    assert.equal(file.kind, 'pending_confirmation')
    assert.equal(file.level, 'L4')
    assert.equal(files, 0)
  })

  it('keeps audit records free of action payloads', async () => {
    const policy = new PolicyService(EXAMPLE_PERSONAL_POLICY)
    policy.registerExecutor('calendar', 'create_event', async () => ({ id: 'evt' }))
    const pending = await policy.apply({
      capability: 'calendar',
      operation: 'create_event',
      intent: 'execute',
      payload: { title: 'Secret meeting', start: 's', end: 'e' },
    })
    if (pending.kind !== 'pending_confirmation') throw new Error('expected pending')
    await policy.resolve(pending.confirmationId, 'approve')
    const dump = JSON.stringify(policy.auditTrail())
    assert.equal(dump.includes('Secret meeting'), false)
    assert.ok(policy.auditTrail().every((entry) => entry.fingerprint && entry.reason))
  })
})

describe('policy through DSH tools', () => {
  async function bootPolicyRuntime() {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(integrationsPlugin)
    await ctx.plugin(policyPlugin)
    return ctx
  }

  async function execute(ctx: Context, name: string, args: unknown, signal = AbortSignal.timeout(5000)) {
    return ctx.tools.execute({
      callId: CallId(`policy-${name}-${Math.random().toString(16).slice(2)}`),
      name,
      arguments: args,
      signal,
    })
  }

  it('covers read, draft, confirm, deny, and replay through ToolRuntime', async () => {
    const ctx = await bootPolicyRuntime()
    const listed = await execute(ctx, 'calendar_list_events', {
      from: '2026-08-21T00:00:00.000Z',
      to: '2026-08-23T00:00:00.000Z',
    })
    assert.equal(listed.isError, false)
    assert.equal(JSON.parse(String(listed.value)).items.length, 3)

    const draft = await execute(ctx, 'calendar_propose_event', EVENT)
    assert.equal(draft.isError, false)
    assert.equal(JSON.parse(String(draft.value)).trust, 'propose')
    assert.equal((await ctx.integrations.hub.calendar().listEvents({
      from: '2026-08-21T00:00:00.000Z',
      to: '2026-08-23T00:00:00.000Z',
    })).items.length, 3)

    const pending = await execute(ctx, 'calendar_create_event', EVENT)
    assert.equal(pending.isError, false)
    const pendingBody = JSON.parse(String(pending.value))
    assert.equal(pendingBody.kind, 'pending_confirmation')
    assert.equal((await ctx.integrations.hub.calendar().listEvents({
      from: '2026-08-21T00:00:00.000Z',
      to: '2026-08-23T00:00:00.000Z',
    })).items.length, 3)

    const approved = await execute(ctx, 'confirm_action', {
      confirmationId: pendingBody.confirmationId,
      decision: 'approve',
    })
    assert.equal(approved.isError, false)
    assert.equal(JSON.parse(String(approved.value)).kind, 'allow')
    const after = await ctx.integrations.hub.calendar().listEvents({
      from: '2026-08-21T00:00:00.000Z',
      to: '2026-08-23T00:00:00.000Z',
    })
    assert.equal(after.items.some((event) => event.title === '1:1'), true)

    const replay = await execute(ctx, 'confirm_action', {
      confirmationId: pendingBody.confirmationId,
      decision: 'approve',
    })
    assert.equal(replay.isError, false)
    assert.equal(JSON.parse(String(replay.value)).code, 'replay')
    assert.equal((await ctx.integrations.hub.calendar().listEvents({
      from: '2026-08-21T00:00:00.000Z',
      to: '2026-08-23T00:00:00.000Z',
    })).items.filter((event) => event.title === '1:1').length, 1)

    const otherPending = await execute(ctx, 'files_delete', { id: 'f-1' })
    const otherBody = JSON.parse(String(otherPending.value))
    const denied = await execute(ctx, 'confirm_action', {
      confirmationId: otherBody.confirmationId,
      decision: 'deny',
    })
    assert.equal(JSON.parse(String(denied.value)).code, 'denied')
    assert.equal((await ctx.integrations.hub.files().listFiles({})).items.length, 1)

    const auto = await execute(ctx, 'tasks_create', { title: 'Buy milk' })
    assert.equal(JSON.parse(String(auto.value)).kind, 'allow')
    assert.equal((await ctx.integrations.hub.tasks().listTasks({})).items.some((item) => item.title === 'Buy milk'), true)

    await ctx.fiber.dispose()
  })
})
