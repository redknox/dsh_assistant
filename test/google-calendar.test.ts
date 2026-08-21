import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createFakeGoogleCalendarTransport,
  createGoogleCalendarProvider,
  createLiveGoogleCalendarTransport,
} from '../src/adapters/integrations/google-calendar.js'
import { FakeIntegrationSuite } from '../src/adapters/integrations/fake-providers.js'
import { assertCalendarRange } from '../src/domain/integrations/calendar-time.js'
import {
  assertGoogleCalendarPath,
  eventIdFromOperation,
  GOOGLE_CALENDAR_ORIGIN,
  toGoogleEvent,
} from '../src/domain/integrations/google-api.js'
import { IntegrationError } from '../src/domain/integrations/types.js'
import { sanitizeProviderError } from '../src/domain/integrations/sanitize.js'

const RANGE = { from: '2026-08-21T00:00:00.000Z', to: '2026-08-22T00:00:00.000Z' }

describe('google calendar provider adapter', () => {
  it('constructs a live transport without failing merely because it is not a fixture', () => {
    const transport = createLiveGoogleCalendarTransport({
      getAccessToken: () => undefined,
      fetchImpl: async () => {
        throw new Error('fetch must not run during construction')
      },
    })
    assert.equal(transport.origin, 'https://www.googleapis.com/calendar/v3')
    assert.equal(transport.credentialState(), 'absent')
    const provider = createGoogleCalendarProvider({ transport, allowCreate: true })
    assert.equal(provider.capability, 'calendar')
  })

  it('maps Google Calendar v3 resources into provider-neutral events and injects the token only at the transport', async () => {
    const calls: { url: string; authorization?: string; body?: unknown }[] = []
    const transport = createLiveGoogleCalendarTransport({
      getAccessToken: () => 'ya29.secret-token',
      fetchImpl: async (url, init) => {
        const headers = init?.headers as Record<string, string>
        calls.push({
          url: String(url),
          authorization: headers.Authorization,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        })
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{
              id: 'g1',
              summary: 'Sync',
              start: { dateTime: '2026-08-21T15:00:00.000Z', timeZone: 'UTC' },
              end: { dateTime: '2026-08-21T15:30:00.000Z', timeZone: 'UTC' },
            }],
          }),
        } as Response
      },
    })
    assert.equal(transport.credentialState(), 'injected')
    const provider = createGoogleCalendarProvider({ transport })
    const page = await provider.listEvents(RANGE)
    assert.equal(page.items[0]?.title, 'Sync')
    assert.equal(page.items[0]?.calendarId, 'primary')
    assert.equal(calls[0]?.url, `${GOOGLE_CALENDAR_ORIGIN}/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(RANGE.from)}&timeMax=${encodeURIComponent(RANGE.to)}`)
    assert.equal(calls[0]?.authorization, 'Bearer ya29.secret-token')
    assert.doesNotMatch(calls[0]?.url ?? '', /ya29|access_token/)
  })

  it('refuses origins and paths outside the approved Google Calendar boundary', async () => {
    assert.throws(() => createLiveGoogleCalendarTransport({ origin: 'https://evil.example' }), IntegrationError)
    assert.throws(() => assertGoogleCalendarPath('https://evil.example/calendar/v3/events'), IntegrationError)
    assert.throws(() => assertGoogleCalendarPath('/v1/other'), IntegrationError)
    const transport = createLiveGoogleCalendarTransport({
      fetchImpl: async () => {
        throw new Error('must not fetch a refused path')
      },
    })
    await assert.rejects(() => transport.request({ method: 'GET', path: '/mail/v1/users/me/messages' }), IntegrationError)
  })

  it('creates with Google event fields and reconciles remote success plus local timeout', async () => {
    const transport = createFakeGoogleCalendarTransport({ seed: [], failNextCreate: 'timeout-after-success' })
    const provider = createGoogleCalendarProvider({ transport, allowCreate: true })
    const input = {
      title: 'Focus',
      start: '2026-08-22T14:00:00.000Z',
      end: '2026-08-22T15:00:00.000Z',
      timeZone: 'UTC',
      calendarId: 'primary',
      attendees: ['ada@example.com'],
      description: 'Deep work',
      idempotencyKey: 'op-focus-1',
    }
    const first = await provider.createEvent(input)
    const second = await provider.createEvent(input)
    assert.equal(first.id, eventIdFromOperation('op-focus-1'))
    assert.equal(first.id, second.id)
    assert.equal(first.title, 'Focus')
    assert.deepEqual(first.attendees, ['ada@example.com'])
    assert.equal(transport.events.length, 1)
    assert.equal(transport.events[0]?.summary, 'Focus')
    assert.deepEqual(toGoogleEvent(input, first.id).start, { dateTime: input.start, timeZone: 'UTC' })
  })

  it('replaces the hub calendar provider without leaking a second calendar domain', async () => {
    const suite = new FakeIntegrationSuite()
    const google = createGoogleCalendarProvider({
      transport: createFakeGoogleCalendarTransport({
        seed: [{
          id: 'g1',
          title: 'Google only',
          start: '2026-08-21T15:00:00.000Z',
          end: '2026-08-21T15:30:00.000Z',
          timeZone: 'UTC',
        }],
      }),
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

  it('types 401/429/5xx failures without leaking the injected credential', async () => {
    const provider = createGoogleCalendarProvider({ transport: createFakeGoogleCalendarTransport() })
    await assert.rejects(() => provider.getEvent('unauthorized'), (error: unknown) => (
      error instanceof IntegrationError && error.code === 'unavailable' && !/leaked-credential|Bearer /.test(error.message)
    ))
    await assert.rejects(() => provider.getEvent('rate-limit'), (error: unknown) => (
      error instanceof IntegrationError && error.code === 'provider_failure'
    ))
    await assert.rejects(() => provider.getEvent('unavailable'), (error: unknown) => (
      error instanceof IntegrationError && error.code === 'provider_failure'
    ))
  })

  it('sanitizes tokens and keeps timed / all-day validation explicit', () => {
    assert.match(sanitizeProviderError('Authorization: Bearer ya29.secret-token https://www.googleapis.com/calendar/v3/calendars/primary/events?access_token=abc'), /redacted/)
    assert.doesNotMatch(sanitizeProviderError('Authorization: Bearer ya29.secret-token'), /ya29/)
    assert.throws(() => assertCalendarRange({ start: '2026-03-08T01:30', end: '2026-03-08T03:30' }))
    assertCalendarRange({ start: '2026-08-22', end: '2026-08-23', allDay: true })
  })
})
