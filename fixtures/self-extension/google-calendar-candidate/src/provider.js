import { eventToDraft } from './time.js'
import { sanitizeProviderError } from './sanitize.js'

export const GOOGLE_CALENDAR_API_ORIGIN = 'https://www.googleapis.com/calendar/v3'

export const FIXTURE_EVENTS = [
  {
    id: 'gcal-standup',
    title: 'Google standup',
    start: '2026-08-21T15:00:00.000Z',
    end: '2026-08-21T15:15:00.000Z',
    timeZone: 'UTC',
    calendarId: 'primary',
  },
  {
    id: 'gcal-allday',
    title: 'Offsite',
    start: '2026-08-22',
    end: '2026-08-23',
    allDay: true,
    calendarId: 'primary',
  },
  {
    id: 'gcal-dst',
    title: 'DST block',
    start: '2026-03-08T06:30:00.000Z',
    end: '2026-03-08T07:30:00.000Z',
    timeZone: 'America/New_York',
    calendarId: 'primary',
  },
]

export function createFixtureTransport(seed = FIXTURE_EVENTS) {
  const events = seed.map((event) => ({ ...event }))
  const byKey = new Map()
  return {
    events,
    async request(input) {
      if (input.path.includes('unauthorized')) return { status: 401, body: { error: { message: 'Bearer leaked-credential' } } }
      if (input.path.includes('forbidden')) return { status: 403, body: { error: { message: 'insufficient scope' } } }
      if (input.path.includes('rate-limit')) return { status: 429, body: { error: { message: 'rate limited' } } }
      if (input.path.includes('unavailable')) return { status: 503, body: { error: { message: 'backend unavailable' } } }
      if (input.method === 'GET' && input.path.startsWith('/events/')) {
        const id = input.path.slice('/events/'.length)
        const found = events.find((event) => event.id === id)
        return found === undefined ? { status: 404, body: { error: { message: 'not found' } } } : { status: 200, body: found }
      }
      if (input.method === 'GET' && input.path.startsWith('/events')) {
        return { status: 200, body: { items: events } }
      }
      if (input.method === 'POST' && input.path === '/freeBusy') {
        const query = input.body
        return {
          status: 200,
          body: {
            items: events
              .filter((event) => !event.allDay && event.start < query.to && event.end > query.from)
              .map((event) => ({ start: event.start, end: event.end, busy: true })),
          },
        }
      }
      if (input.method === 'POST' && input.path === '/events') {
        const body = input.body
        if (body.idempotencyKey !== undefined && byKey.has(body.idempotencyKey)) {
          return { status: 200, body: byKey.get(body.idempotencyKey) }
        }
        const created = { ...eventToDraft(body), id: `gcal-${events.length + 1}` }
        events.push(created)
        if (body.idempotencyKey !== undefined) byKey.set(body.idempotencyKey, created)
        return { status: 200, body: created }
      }
      return { status: 500, body: { error: { message: 'unknown fixture route' } } }
    },
  }
}

function fail(status, body) {
  const raw = body && typeof body === 'object' && body.error ? String(body.error.message ?? status) : `google calendar HTTP ${status}`
  const message = sanitizeProviderError(raw)
  const error = new Error(message)
  error.capability = 'calendar'
  error.code = status === 401 || status === 403 ? 'unavailable' : status === 400 || status === 404 ? 'invalid_request' : 'provider_failure'
  throw error
}

export function createGoogleCalendarProvider(options = {}) {
  const transport = options.transport ?? createFixtureTransport()
  const allowCreate = options.allowCreate === true
  const call = async (input) => {
    const token = typeof options.getAccessToken === 'function' ? options.getAccessToken() : undefined
    const response = await transport.request({ ...input, token })
    if (response.status >= 400) fail(response.status, response.body)
    return response.body
  }
  return {
    capability: 'calendar',
    availability() {
      return { available: true }
    },
    async listEvents(query) {
      const body = await call({ method: 'GET', path: `/events?from=${encodeURIComponent(query.from)}&to=${encodeURIComponent(query.to)}` })
      return { items: (body.items ?? []).filter((event) => event.start >= query.from && event.start <= query.to) }
    },
    async getEvent(id) {
      return await call({ method: 'GET', path: `/events/${id}` })
    },
    async freeBusy(query) {
      const body = await call({ method: 'POST', path: '/freeBusy', body: query })
      return { items: body.items ?? [] }
    },
    async proposeCreateEvent(input) {
      const draft = eventToDraft(input)
      return {
        trust: 'propose',
        summary: `Propose calendar event "${draft.title}" on ${draft.calendarId} ${draft.start}/${draft.end} ${draft.timeZone ?? ''}`.trim(),
        draft,
      }
    },
    async createEvent(input) {
      if (!allowCreate) {
        const error = new Error('calendar.events.create is not authorized on this candidate')
        error.capability = 'calendar'
        error.code = 'unavailable'
        throw error
      }
      return await call({ method: 'POST', path: '/events', body: input })
    },
  }
}
