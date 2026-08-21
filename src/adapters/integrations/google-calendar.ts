import { eventToDraft } from '../../domain/integrations/calendar-time.js'
import type { CalendarCreateInput, CalendarEvent, CalendarProvider, FreeBusyWindow } from '../../domain/integrations/hub.js'
import { IntegrationError, type Availability, type Page, type PageQuery, type ProposedMutation } from '../../domain/integrations/types.js'
import { sanitizeProviderError } from '../../domain/integrations/sanitize.js'

export const GOOGLE_CALENDAR_API_ORIGIN = 'https://www.googleapis.com/calendar/v3'

export interface GoogleCalendarTransport {
  request(input: { method: string; path: string; body?: unknown; token?: string }): Promise<{ status: number; body: unknown }>
}

export interface GoogleCalendarOptions {
  readonly allowCreate?: boolean
  readonly transport?: GoogleCalendarTransport
  readonly getAccessToken?: () => string | undefined
}

interface FixtureEvent extends CalendarEvent {
  readonly idempotencyKey?: string
}

export function createFixtureTransport(seed: CalendarEvent[] = []): GoogleCalendarTransport {
  const events = [...seed]
  const byKey = new Map<string, CalendarEvent>()
  return {
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
        const query = input.body as { from: string; to: string }
        return {
          status: 200,
          body: {
            items: events
              .filter((event) => event.start < query.to && event.end > query.from)
              .map((event) => ({ start: event.start, end: event.end, busy: true })),
          },
        }
      }
      if (input.method === 'POST' && input.path === '/events') {
        const body = input.body as CalendarCreateInput
        if (body.idempotencyKey !== undefined && byKey.has(body.idempotencyKey)) {
          return { status: 200, body: byKey.get(body.idempotencyKey) }
        }
        const created: FixtureEvent = { ...eventToDraft(body), id: `gcal-${events.length + 1}`, idempotencyKey: body.idempotencyKey }
        events.push(created)
        if (body.idempotencyKey !== undefined) byKey.set(body.idempotencyKey, created)
        return { status: 200, body: created }
      }
      return { status: 500, body: { error: { message: 'unknown fixture route' } } }
    },
  }
}

function asEvent(body: unknown): CalendarEvent {
  const value = body as CalendarEvent
  return {
    id: String(value.id),
    title: String(value.title),
    start: String(value.start),
    end: String(value.end),
    timeZone: value.timeZone,
    calendarId: value.calendarId ?? 'primary',
    description: value.description,
    attendees: value.attendees,
    allDay: value.allDay,
  }
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

/** Provider-neutral CalendarProvider backed by a Google Calendar transport. Live tokens stay out of this module. */
export function createGoogleCalendarProvider(options: GoogleCalendarOptions = {}): CalendarProvider {
  const transport = options.transport ?? createFixtureTransport()
  const allowCreate = options.allowCreate === true
  const call = async (input: { method: string; path: string; body?: unknown }) => {
    const token = options.getAccessToken?.()
    const response = await transport.request({ ...input, token })
    if (response.status >= 400) fail(response.status, response.body)
    return response.body
  }
  return {
    capability: 'calendar',
    availability(): Availability {
      return { available: true }
    },
    async listEvents(query: { from: string; to: string } & PageQuery): Promise<Page<CalendarEvent>> {
      const body = await call({ method: 'GET', path: `/events?from=${encodeURIComponent(query.from)}&to=${encodeURIComponent(query.to)}` }) as { items?: CalendarEvent[] }
      const items = (body.items ?? []).filter((event) => event.start >= query.from && event.start <= query.to)
      return { items }
    },
    async getEvent(id: string): Promise<CalendarEvent> {
      return asEvent(await call({ method: 'GET', path: `/events/${id}` }))
    },
    async freeBusy(query: { from: string; to: string; timeZone?: string } & PageQuery): Promise<Page<FreeBusyWindow>> {
      const body = await call({ method: 'POST', path: '/freeBusy', body: query }) as { items?: FreeBusyWindow[] }
      return { items: body.items ?? [] }
    },
    async proposeCreateEvent(input: CalendarCreateInput): Promise<ProposedMutation<CalendarEvent>> {
      const draft = eventToDraft(input)
      return {
        trust: 'propose',
        summary: `Propose calendar event "${draft.title}" on ${draft.calendarId ?? 'primary'} ${draft.start}/${draft.end} ${draft.timeZone ?? ''}`.trim(),
        draft,
      }
    },
    async createEvent(input: CalendarCreateInput): Promise<CalendarEvent> {
      if (!allowCreate) throw new IntegrationError('calendar', 'unavailable', 'calendar.events.create is not authorized on this candidate')
      return asEvent(await call({ method: 'POST', path: '/events', body: input }))
    },
  }
}
