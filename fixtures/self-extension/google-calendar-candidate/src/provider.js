import { eventToDraft } from './time.js'
import { sanitizeProviderError } from './sanitize.js'
import {
  calendarEventPath,
  calendarEventsPath,
  eventIdFromOperation,
  fromGoogleEvent,
  fromGoogleFreeBusy,
  isUncertainCreateError,
  reconciliationSignal,
  toGoogleEvent,
} from './google-event.js'

export { GOOGLE_CALENDAR_API_ORIGIN } from './google-event.js'

function fail(status, body) {
  const raw = body && typeof body === 'object' && body.error ? String(body.error.message ?? status) : `google calendar HTTP ${status}`
  const message = sanitizeProviderError(raw)
  const error = new Error(message)
  error.capability = 'calendar'
  error.code = status === 401 || status === 403 ? 'unavailable' : status === 400 || status === 404 ? 'invalid_request' : 'provider_failure'
  throw error
}

export function createGoogleCalendarProvider(options = {}) {
  if (options.transport === undefined || typeof options.transport.request !== 'function') {
    throw new Error('host-managed Google Calendar transport is required')
  }
  const allowCreate = options.allowCreate === true
  const call = async (input, signal) => {
    const response = await options.transport.request(input, signal)
    if (response.status >= 400) fail(response.status, response.body)
    return response.body
  }
  const tryGet = async (calendarId, eventId, signal) => {
    const response = await options.transport.request({ method: 'GET', path: calendarEventPath(calendarId, eventId) }, signal)
    if (response.status === 404) return undefined
    if (response.status >= 400) fail(response.status, response.body)
    return fromGoogleEvent(response.body, calendarId)
  }
  return {
    capability: 'calendar',
    availability() {
      return { available: true }
    },
    async listEvents(query) {
      const calendarId = 'primary'
      const body = await call({
        method: 'GET',
        path: calendarEventsPath(calendarId, { timeMin: query.from, timeMax: query.to }),
      })
      return { items: (body.items ?? []).map((item) => fromGoogleEvent(item, calendarId)) }
    },
    async getEvent(id) {
      return fromGoogleEvent(await call({ method: 'GET', path: calendarEventPath('primary', id) }), 'primary')
    },
    async freeBusy(query) {
      const calendarId = 'primary'
      const body = await call({
        method: 'POST',
        path: '/calendar/v3/freeBusy',
        body: { timeMin: query.from, timeMax: query.to, timeZone: query.timeZone, items: [{ id: calendarId }] },
      })
      return { items: fromGoogleFreeBusy(body, calendarId) }
    },
    async proposeCreateEvent(input) {
      const draft = eventToDraft(input)
      return {
        trust: 'propose',
        summary: `Propose calendar event "${draft.title}" on ${draft.calendarId} ${draft.start}/${draft.end} ${draft.timeZone ?? ''}`.trim(),
        draft,
      }
    },
    async createEvent(input, signal) {
      if (!allowCreate) {
        const error = new Error('calendar.events.create is not authorized on this candidate')
        error.capability = 'calendar'
        error.code = 'unavailable'
        throw error
      }
      const calendarId = input.calendarId ?? 'primary'
      const eventId = input.idempotencyKey === undefined ? undefined : eventIdFromOperation(input.idempotencyKey)
      if (eventId !== undefined) {
        const existing = await tryGet(calendarId, eventId, signal)
        if (existing !== undefined) return existing
      }
      try {
        const response = await options.transport.request({
          method: 'POST',
          path: calendarEventsPath(calendarId),
          body: toGoogleEvent(input, eventId),
        }, signal)
        if (response.status === 409 && eventId !== undefined) {
          const recovered = await tryGet(calendarId, eventId, reconciliationSignal())
          if (recovered !== undefined) return recovered
        }
        if (response.status >= 400) fail(response.status, response.body)
        return fromGoogleEvent(response.body, calendarId)
      } catch (error) {
        if (eventId !== undefined && isUncertainCreateError(error)) {
          const recovered = await tryGet(calendarId, eventId, reconciliationSignal())
          if (recovered !== undefined) return recovered
        }
        throw error
      }
    },
  }
}
