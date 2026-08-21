import { fromGoogleEvent, toGoogleEvent } from '../src/google-event.js'

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

function timeoutError() {
  const error = new Error('timeout')
  error.code = 'cancelled'
  return error
}

export function createFakeGoogleCalendarTransport(options = {}) {
  const events = (options.seed ?? FIXTURE_EVENTS).map((event) => toGoogleEvent(event, event.id))
  let failNextCreate = options.failNextCreate
  return {
    origin: 'https://www.googleapis.com/calendar/v3',
    events,
    credentialState() {
      return 'absent'
    },
    async request(input, signal) {
      if (signal?.aborted) {
        const error = new Error('timeout')
        error.code = 'cancelled'
        throw error
      }
      const path = String(input.path ?? '')
      if (path.includes('://') || path.startsWith('//') || !path.startsWith('/calendar/v3')) {
        const error = new Error('google calendar path is outside the approved boundary')
        error.code = 'invalid_request'
        throw error
      }
      if (path.includes('unauthorized')) return { status: 401, body: { error: { message: 'Bearer leaked-credential' } } }
      if (input.method === 'POST' && path === '/calendar/v3/freeBusy') {
        const body = input.body ?? {}
        const calendarId = body.items?.[0]?.id ?? 'primary'
        return {
          status: 200,
          body: {
            calendars: {
              [calendarId]: {
                busy: events
                  .map((event) => fromGoogleEvent(event, calendarId))
                  .filter((event) => event.allDay !== true && event.start < String(body.timeMax ?? '') && event.end > String(body.timeMin ?? ''))
                  .map((event) => ({ start: event.start, end: event.end })),
              },
            },
          },
        }
      }
      const match = path.split('?')[0].match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/)
      if (match && input.method === 'GET' && match[2]) {
        const found = events.find((event) => event.id === decodeURIComponent(match[2]))
        return found === undefined ? { status: 404, body: { error: { message: 'not found' } } } : { status: 200, body: found }
      }
      if (match && input.method === 'GET') {
        return { status: 200, body: { items: events } }
      }
      if (match && input.method === 'POST') {
        if (failNextCreate === 'timeout-before-success') {
          failNextCreate = undefined
          throw timeoutError()
        }
        const body = input.body ?? {}
        if (body.id !== undefined && events.some((event) => event.id === body.id)) {
          return { status: 409, body: { error: { message: 'conflict' } } }
        }
        const created = { ...body, id: body.id ?? `gcal-${events.length + 1}` }
        events.push(created)
        if (failNextCreate === 'timeout-after-success') {
          failNextCreate = undefined
          throw timeoutError()
        }
        return { status: 200, body: created }
      }
      return { status: 500, body: { error: { message: 'unknown google calendar route' } } }
    },
  }
}
