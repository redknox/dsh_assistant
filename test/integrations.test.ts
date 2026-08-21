import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FakeIntegrationSuite } from '../src/adapters/integrations/fake-providers.js'
import { IntegrationError } from '../src/domain/integrations/types.js'

describe('personal integration seams', () => {
  it('reads calendar events through the hub without executing a create', async () => {
    const suite = new FakeIntegrationSuite()
    const page = await suite.hub.calendar().listEvents({
      from: '2026-08-21T00:00:00.000Z',
      to: '2026-08-21T23:59:59.000Z',
    })
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
    const still = await suite.hub.calendar().listEvents({
      from: '2026-08-21T00:00:00.000Z',
      to: '2026-08-23T00:00:00.000Z',
    })
    assert.equal(still.items.length, 1)
    assert.equal(still.items[0]?.title, 'Team standup')
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
      () => suite.hub.webSearch().search({ text: 'news', signal: controller.signal }),
      (error: unknown) => error instanceof IntegrationError && error.code === 'cancelled',
    )
  })
})
