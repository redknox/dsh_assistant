import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createFixtureTransport, createGoogleCalendarProvider } from '../src/provider.js'
import { sanitizeProviderError } from '../src/sanitize.js'
import { assertCalendarRange } from '../src/time.js'

describe('google calendar candidate', () => {
  it('proposes without mutating the fixture', async () => {
    const transport = createFixtureTransport()
    const provider = createGoogleCalendarProvider({ transport, allowCreate: false })
    const before = transport.events.length
    const proposal = await provider.proposeCreateEvent({
      title: 'Focus',
      start: '2026-08-22T14:00:00.000Z',
      end: '2026-08-22T15:00:00.000Z',
      timeZone: 'UTC',
      calendarId: 'primary',
      attendees: ['ada@example.com'],
    })
    assert.equal(proposal.trust, 'propose')
    assert.equal(transport.events.length, before)
  })

  it('denies create on the read-only candidate', async () => {
    const provider = createGoogleCalendarProvider({ allowCreate: false })
    await assert.rejects(() => provider.createEvent({
      title: 'Focus',
      start: '2026-08-22T14:00:00.000Z',
      end: '2026-08-22T15:00:00.000Z',
      timeZone: 'UTC',
    }), /not authorized/)
  })

  it('reuses an idempotency key instead of duplicating', async () => {
    const transport = createFixtureTransport()
    const provider = createGoogleCalendarProvider({ transport, allowCreate: true })
    const input = {
      title: 'Focus',
      start: '2026-08-22T14:00:00.000Z',
      end: '2026-08-22T15:00:00.000Z',
      timeZone: 'UTC',
      idempotencyKey: 'op-focus-1',
    }
    const first = await provider.createEvent(input)
    const second = await provider.createEvent(input)
    assert.equal(first.id, second.id)
    assert.equal(transport.events.filter((event) => event.title === 'Focus').length, 1)
  })

  it('sanitizes credential-bearing provider errors', async () => {
    const provider = createGoogleCalendarProvider()
    await assert.rejects(async () => {
      await provider.getEvent('unauthorized')
    }, (error) => {
      assert.match(error.message, /redacted/)
      assert.doesNotMatch(error.message, /leaked-credential/)
      assert.doesNotMatch(error.message, /Bearer /)
      return true
    })
  })

  it('rejects vague timed ranges and preserves all-day / DST bounds', () => {
    assert.throws(() => assertCalendarRange({ start: '2026-03-08T01:30', end: '2026-03-08T03:30' }))
    assertCalendarRange({ start: '2026-08-22', end: '2026-08-23', allDay: true })
    assertCalendarRange({
      start: '2026-03-08T06:30:00.000Z',
      end: '2026-03-08T07:30:00.000Z',
      timeZone: 'America/New_York',
    })
  })
})
