import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createFixtureTransport, createGoogleCalendarProvider } from '../src/adapters/integrations/google-calendar.js'
import { FakeIntegrationSuite } from '../src/adapters/integrations/fake-providers.js'
import { assertCalendarRange } from '../src/domain/integrations/calendar-time.js'
import { sanitizeProviderError } from '../src/domain/integrations/sanitize.js'

describe('google calendar provider adapter', () => {
  it('maps fixture transport into provider-neutral calendar events', async () => {
    const provider = createGoogleCalendarProvider({
      transport: createFixtureTransport([{
        id: 'g1',
        title: 'Sync',
        start: '2026-08-21T15:00:00.000Z',
        end: '2026-08-21T15:30:00.000Z',
        timeZone: 'UTC',
        calendarId: 'primary',
      }]),
    })
    const page = await provider.listEvents({ from: '2026-08-21T00:00:00.000Z', to: '2026-08-22T00:00:00.000Z' })
    assert.equal(page.items[0]?.title, 'Sync')
    assert.equal(page.items[0]?.calendarId, 'primary')
    const one = await provider.getEvent('g1')
    assert.equal(one.id, 'g1')
  })

  it('replaces the hub calendar provider without leaking a second calendar domain', async () => {
    const suite = new FakeIntegrationSuite()
    const google = createGoogleCalendarProvider({
      transport: createFixtureTransport([{
        id: 'g1',
        title: 'Google only',
        start: '2026-08-21T15:00:00.000Z',
        end: '2026-08-21T15:30:00.000Z',
        timeZone: 'UTC',
      }]),
    })
    const restore = suite.hub.replaceCalendar(google)
    assert.equal((await suite.hub.calendar().listEvents({
      from: '2026-08-21T00:00:00.000Z',
      to: '2026-08-22T00:00:00.000Z',
    })).items[0]?.title, 'Google only')
    restore()
    assert.equal((await suite.hub.calendar().listEvents({
      from: '2026-08-21T00:00:00.000Z',
      to: '2026-08-23T00:00:00.000Z',
    })).items[0]?.title, 'Team standup')
  })

  it('sanitizes tokens and keeps timed / all-day validation explicit', () => {
    assert.match(sanitizeProviderError('Authorization: Bearer ya29.secret-token https://www.googleapis.com/calendar/v3/calendars/primary/events?access_token=abc'), /redacted/)
    assert.doesNotMatch(sanitizeProviderError('Authorization: Bearer ya29.secret-token'), /ya29/)
    assert.throws(() => assertCalendarRange({ start: '2026-03-08T01:30', end: '2026-03-08T03:30' }))
    assertCalendarRange({ start: '2026-08-22', end: '2026-08-23', allDay: true })
  })
})
