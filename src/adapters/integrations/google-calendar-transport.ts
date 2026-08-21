import {
  assertGoogleCalendarPath,
  fromGoogleEvent,
  toGoogleEvent,
  GOOGLE_CALENDAR_API_ORIGIN,
  GOOGLE_CALENDAR_ORIGIN,
  type BoundedGoogleCalendarRequest,
  type BoundedGoogleCalendarResponse,
  type BoundedGoogleCalendarTransport,
  type GoogleEventResource,
} from '../../domain/integrations/google-api.js'
import type { CalendarEvent } from '../../domain/integrations/hub.js'
import { IntegrationError } from '../../domain/integrations/types.js'
import { sanitizeProviderError } from '../../domain/integrations/sanitize.js'

export const DEFAULT_GOOGLE_FIXTURE_EVENTS: readonly CalendarEvent[] = [
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

export interface LiveGoogleCalendarTransportOptions {
  readonly fetchImpl?: typeof fetch
  readonly getAccessToken?: () => string | undefined
  readonly origin?: string
}

function credentialState(getAccessToken?: () => string | undefined): 'injected' | 'absent' {
  const value = getAccessToken?.()
  return typeof value === 'string' && value !== '' ? 'injected' : 'absent'
}

function timeoutError(): IntegrationError {
  return new IntegrationError('calendar', 'cancelled', 'timeout')
}

function isTimeout(error: unknown): boolean {
  if (error instanceof IntegrationError) return /timeout/i.test(error.message) || error.code === 'cancelled'
  if (!(error instanceof Error)) return false
  return error.name === 'TimeoutError' || error.name === 'AbortError' || /timeout/i.test(error.message)
}

/** Host-owned live transport: injects credentials and refuses any origin/path outside Google Calendar v3. */
export function createLiveGoogleCalendarTransport(options: LiveGoogleCalendarTransportOptions = {}): BoundedGoogleCalendarTransport {
  const origin = options.origin ?? GOOGLE_CALENDAR_ORIGIN
  if (origin !== GOOGLE_CALENDAR_ORIGIN) {
    throw new IntegrationError('calendar', 'invalid_request', 'google calendar origin is outside the approved boundary')
  }
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    origin: GOOGLE_CALENDAR_API_ORIGIN,
    credentialState: () => credentialState(options.getAccessToken),
    async request(input: BoundedGoogleCalendarRequest, signal?: AbortSignal): Promise<BoundedGoogleCalendarResponse> {
      const path = assertGoogleCalendarPath(input.path)
      if (signal?.aborted) throw timeoutError()
      const token = options.getAccessToken?.()
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (typeof token === 'string' && token !== '') headers.Authorization = `Bearer ${token}`
      if (input.body !== undefined) headers['Content-Type'] = 'application/json'
      try {
        const response = await fetchImpl(`${origin}${path}`, {
          method: input.method,
          headers,
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          signal,
        })
        const body = await response.json().catch(() => ({}))
        return { status: response.status, body }
      } catch (error) {
        if (isTimeout(error) || signal?.aborted) throw timeoutError()
        throw new IntegrationError('calendar', 'provider_failure', sanitizeProviderError(error instanceof Error ? error.message : 'google calendar request failed'))
      }
    },
  }
}

export interface FakeGoogleCalendarTransportOptions {
  readonly seed?: readonly CalendarEvent[]
  readonly getAccessToken?: () => string | undefined
  /** Inserts the Google event, then fails locally — the remote side-effect already happened. */
  readonly failNextCreate?: 'timeout-after-success' | 'timeout-before-success'
}

export interface FakeGoogleCalendarTransport extends BoundedGoogleCalendarTransport {
  readonly events: GoogleEventResource[]
}

function toStoredEvent(event: CalendarEvent): GoogleEventResource {
  return toGoogleEvent(event, event.id)
}

function parseEventsPath(path: string): { calendarId: string; eventId?: string; timeMin?: string; timeMax?: string } | undefined {
  const [pathname, query = ''] = path.split('?')
  const match = pathname?.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/)
  if (match === null || match === undefined) return undefined
  const params = new URLSearchParams(query)
  return {
    calendarId: decodeURIComponent(match[1] ?? 'primary'),
    eventId: match[2] === undefined ? undefined : decodeURIComponent(match[2]),
    timeMin: params.get('timeMin') ?? undefined,
    timeMax: params.get('timeMax') ?? undefined,
  }
}

/** Deterministic Google Calendar v3 double. Speaks the real API shape; does not grant arbitrary HTTP. */
export function createFakeGoogleCalendarTransport(options: FakeGoogleCalendarTransportOptions = {}): FakeGoogleCalendarTransport {
  const events = (options.seed ?? DEFAULT_GOOGLE_FIXTURE_EVENTS).map(toStoredEvent)
  let failNextCreate = options.failNextCreate
  return {
    origin: GOOGLE_CALENDAR_API_ORIGIN,
    events,
    credentialState: () => credentialState(options.getAccessToken),
    async request(input, signal) {
      if (signal?.aborted) throw timeoutError()
      const path = assertGoogleCalendarPath(input.path)
      if (path.includes('unauthorized')) return { status: 401, body: { error: { message: 'Bearer leaked-credential' } } }
      if (path.includes('forbidden')) return { status: 403, body: { error: { message: 'insufficient scope' } } }
      if (path.includes('rate-limit')) return { status: 429, body: { error: { message: 'rate limited' } } }
      if (path.includes('unavailable')) return { status: 503, body: { error: { message: 'backend unavailable' } } }
      if (input.method === 'POST' && path === '/calendar/v3/freeBusy') {
        const body = input.body as { timeMin?: string; timeMax?: string; items?: readonly { id?: string }[] }
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
      const parsed = parseEventsPath(path)
      if (parsed !== undefined && input.method === 'GET' && parsed.eventId !== undefined) {
        const found = events.find((event) => event.id === parsed.eventId)
        return found === undefined
          ? { status: 404, body: { error: { message: 'not found' } } }
          : { status: 200, body: found }
      }
      if (parsed !== undefined && input.method === 'GET') {
        const items = events
          .map((event) => fromGoogleEvent(event, parsed.calendarId))
          .filter((event) => {
            if (parsed.timeMin === undefined || parsed.timeMax === undefined) return true
            return event.start >= parsed.timeMin && event.start <= parsed.timeMax
          })
          .map((event) => toStoredEvent(event))
        return { status: 200, body: { items } }
      }
      if (parsed !== undefined && input.method === 'POST') {
        if (failNextCreate === 'timeout-before-success') {
          failNextCreate = undefined
          throw timeoutError()
        }
        const body = input.body as GoogleEventResource
        if (body.id !== undefined && events.some((event) => event.id === body.id)) {
          return { status: 409, body: { error: { message: 'conflict' } } }
        }
        const created: GoogleEventResource = {
          ...body,
          id: body.id ?? `gcal-${events.length + 1}`,
        }
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

export function createHostGoogleCalendarTransport(): BoundedGoogleCalendarTransport {
  const getAccessToken = () => process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN
  if (process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_MODE === 'live') {
    return createLiveGoogleCalendarTransport({ getAccessToken })
  }
  return createFakeGoogleCalendarTransport({ getAccessToken })
}
