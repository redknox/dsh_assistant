import { eventToDraft } from '../../domain/integrations/calendar-time.js'
import {
  calendarEventPath,
  calendarEventsPath,
  eventIdFromOperation,
  freeBusyPath,
  fromGoogleEvent,
  fromGoogleFreeBusy,
  isUncertainCreateError,
  reconciliationSignal,
  toGoogleEvent,
  type BoundedGoogleCalendarTransport,
} from '../../domain/integrations/google-api.js'
import type { CalendarCreateInput, CalendarEvent, CalendarProvider, FreeBusyWindow } from '../../domain/integrations/hub.js'
import { IntegrationError, type Availability, type Page, type PageQuery, type ProposedMutation } from '../../domain/integrations/types.js'
import { sanitizeProviderError } from '../../domain/integrations/sanitize.js'

export { GOOGLE_CALENDAR_API_ORIGIN } from '../../domain/integrations/google-api.js'
export {
  createFakeGoogleCalendarTransport,
  createHostGoogleCalendarTransport,
  createLiveGoogleCalendarTransport,
} from './google-calendar-transport.js'

export interface GoogleCalendarOptions {
  readonly allowCreate?: boolean
  readonly transport: BoundedGoogleCalendarTransport
}

function fail(status: number, body: unknown): never {
  const raw = typeof body === 'object' && body !== null && 'error' in body
    ? String((body as { error?: { message?: string } }).error?.message ?? status)
    : `google calendar HTTP ${status}`
  const message = sanitizeProviderError(raw)
  if (status === 401 || status === 403) throw new IntegrationError('calendar', 'unavailable', message)
  if (status === 400 || status === 404) throw new IntegrationError('calendar', 'invalid_request', message)
  throw new IntegrationError('calendar', 'provider_failure', message)
}

/** Provider-neutral CalendarProvider. Talks Google Calendar v3 only through a host-bounded transport. */
export function createGoogleCalendarProvider(options: GoogleCalendarOptions): CalendarProvider {
  const allowCreate = options.allowCreate === true
  const call = async (input: { method: 'GET' | 'POST'; path: string; body?: unknown }, signal?: AbortSignal) => {
    const response = await options.transport.request(input, signal)
    if (response.status >= 400) fail(response.status, response.body)
    return response.body
  }
  const tryGet = async (calendarId: string, eventId: string, signal?: AbortSignal): Promise<CalendarEvent | undefined> => {
    const response = await options.transport.request({ method: 'GET', path: calendarEventPath(calendarId, eventId) }, signal)
    if (response.status === 404) return undefined
    if (response.status >= 400) fail(response.status, response.body)
    return fromGoogleEvent(response.body, calendarId)
  }
  return {
    capability: 'calendar',
    availability(): Availability {
      return { available: true }
    },
    async listEvents(query: { from: string; to: string } & PageQuery): Promise<Page<CalendarEvent>> {
      const calendarId = 'primary'
      const body = await call({
        method: 'GET',
        path: calendarEventsPath(calendarId, { timeMin: query.from, timeMax: query.to }),
      }, query.signal) as { items?: unknown[] }
      return { items: (body.items ?? []).map((item) => fromGoogleEvent(item, calendarId)) }
    },
    async getEvent(id: string, signal?: AbortSignal): Promise<CalendarEvent> {
      return fromGoogleEvent(await call({ method: 'GET', path: calendarEventPath('primary', id) }, signal), 'primary')
    },
    async freeBusy(query: { from: string; to: string; timeZone?: string } & PageQuery): Promise<Page<FreeBusyWindow>> {
      const calendarId = 'primary'
      const body = await call({
        method: 'POST',
        path: freeBusyPath(),
        body: {
          timeMin: query.from,
          timeMax: query.to,
          timeZone: query.timeZone,
          items: [{ id: calendarId }],
        },
      }, query.signal)
      return { items: fromGoogleFreeBusy(body, calendarId) }
    },
    async proposeCreateEvent(input: CalendarCreateInput, signal?: AbortSignal): Promise<ProposedMutation<CalendarEvent>> {
      void signal
      const draft = eventToDraft(input)
      return {
        trust: 'propose',
        summary: `Propose calendar event "${draft.title}" on ${draft.calendarId ?? 'primary'} ${draft.start}/${draft.end} ${draft.timeZone ?? ''}`.trim(),
        draft,
      }
    },
    async createEvent(input: CalendarCreateInput, signal?: AbortSignal): Promise<CalendarEvent> {
      if (!allowCreate) throw new IntegrationError('calendar', 'unavailable', 'calendar.events.create is not authorized on this candidate')
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
