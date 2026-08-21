import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { TOOL_ABORTED, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { FakeIntegrationSuite } from '../src/adapters/integrations/fake-providers.js'
import { IntegrationError } from '../src/domain/integrations/types.js'
import { registerIntegrationTools } from '../src/plugins/integration-tools.js'

const RANGE = {
  from: '2026-08-21T00:00:00.000Z',
  to: '2026-08-23T00:00:00.000Z',
}

async function withTools(suite = new FakeIntegrationSuite()) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const dispose = registerIntegrationTools(ctx.tools, suite.hub)
  return {
    suite,
    ctx,
    async execute(name: string, args: unknown, signal = AbortSignal.timeout(5000)) {
      return ctx.tools.execute({
        callId: CallId(`test-${name}-${Math.random().toString(16).slice(2)}`),
        name,
        arguments: args,
        signal,
      })
    },
    async disposeRuntime() {
      dispose()
      await ctx.fiber.dispose()
    },
  }
}

describe('personal integration seams', () => {
  it('reads calendar events through the hub without executing a create', async () => {
    const suite = new FakeIntegrationSuite()
    const page = await suite.hub.calendar().listEvents(RANGE)
    assert.equal(page.items[0]?.title, 'Team standup')
  })

  it('proposes a calendar mutation without applying it', async () => {
    const suite = new FakeIntegrationSuite()
    const proposal = await suite.hub.calendar().proposeCreateEvent({
      title: '1:1',
      start: '2026-08-22T02:00:00.000Z',
      end: '2026-08-22T02:30:00.000Z',
    })
    assert.equal(proposal.trust, 'propose')
    assert.equal(proposal.draft.title, '1:1')
    const still = await suite.hub.calendar().listEvents(RANGE)
    assert.equal(still.items.length, 3)
    assert.equal(still.items.some((event) => event.title === '1:1'), false)
  })

  it('returns structured errors for unavailable, invalid, failed, and cancelled calls', async () => {
    const suite = new FakeIntegrationSuite()
    suite.state.unavailable.mail = 'mail provider not configured'
    assert.throws(() => suite.hub.mail(), (error: unknown) => {
      return error instanceof IntegrationError && error.code === 'unavailable' && error.capability === 'mail'
    })

    await assert.rejects(
      () => suite.hub.calendar().proposeCreateEvent({ title: '  ', start: 'a', end: 'b' }),
      (error: unknown) => error instanceof IntegrationError && error.code === 'invalid_request',
    )

    suite.state.fail.tasks = 'upstream 500'
    await assert.rejects(
      () => suite.hub.tasks().listTasks({}),
      (error: unknown) => error instanceof IntegrationError && error.code === 'provider_failure',
    )

    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => suite.hub.calendar().listEvents({ ...RANGE, signal: controller.signal }),
      (error: unknown) => error instanceof IntegrationError && error.code === 'cancelled',
    )
  })

  it('executes read and propose through ToolRuntime without applying the mutation', async () => {
    const runtime = await withTools()
    const first = await runtime.execute('calendar_list_events', { ...RANGE, limit: 1 })
    assert.equal(first.isError, false)
    const firstPage = JSON.parse(String(first.value))
    assert.equal(firstPage.items[0]?.title, 'Team standup')
    assert.equal(firstPage.nextCursor, '1')

    const second = await runtime.execute('calendar_list_events', { ...RANGE, limit: 1, cursor: firstPage.nextCursor })
    assert.equal(second.isError, false)
    const secondPage = JSON.parse(String(second.value))
    assert.equal(secondPage.items[0]?.title, 'Office hours')

    const proposed = await runtime.execute('calendar_propose_event', {
      title: '1:1',
      start: '2026-08-22T02:00:00.000Z',
      end: '2026-08-22T02:30:00.000Z',
    })
    assert.equal(proposed.isError, false)
    const proposal = JSON.parse(String(proposed.value))
    assert.equal(proposal.trust, 'propose')
    assert.equal(proposal.draft.title, '1:1')

    const listed = await runtime.suite.hub.calendar().listEvents(RANGE)
    assert.equal(listed.items.length, 3)
    assert.equal(listed.items.some((event) => event.title === '1:1'), false)
    await runtime.disposeRuntime()
  })

  it('forwards ToolRuntime cancellation into the provider', async () => {
    const runtime = await withTools()
    runtime.suite.state.waitForAbort.calendar = true
    const controller = new AbortController()
    const started = new Promise<void>((resolve) => {
      runtime.suite.state.waiting = resolve
    })
    const pending = runtime.execute('calendar_list_events', RANGE, controller.signal)
    await started
    controller.abort()
    const result = await pending
    assert.equal(result.isError, true)
    assert.equal(result.error.info?.code, TOOL_ABORTED)
    await runtime.disposeRuntime()
  })
})
