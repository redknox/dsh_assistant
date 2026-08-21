import { createHash } from 'node:crypto'
import type { CalendarCreateInput, CalendarEvent, FreeBusyWindow } from './hub.js'
import { IntegrationError } from './types.js'

export const GOOGLE_CALENDAR_ORIGIN = 'https://www.googleapis.com'
export const GOOGLE_CALENDAR_API_PREFIX = '/calendar/v3'
export const GOOGLE_CALENDAR_API_ORIGIN = `${GOOGLE_CALENDAR_ORIGIN}${GOOGLE_CALENDAR_API_PREFIX}`
/** Fresh read budget after an uncertain create. Must not reuse an already-aborted create signal. */
export const GOOGLE_CREATE_RECONCILE_TIMEOUT_MS = 3_000

export function reconciliationSignal(): AbortSignal {
  return AbortSignal.timeout(GOOGLE_CREATE_RECONCILE_TIMEOUT_MS)
}

export interface GoogleDateTime {
  readonly date?: string
  readonly dateTime?: string
  readonly timeZone?: string
}

export interface GoogleEventResource {
  readonly id?: string
  readonly summary?: string
  readonly description?: string
  readonly start?: GoogleDateTime
  readonly end?: GoogleDateTime
  readonly attendees?: readonly { readonly email?: string }[]
}

export interface GoogleFreeBusyResponse {
  readonly calendars?: Record<string, { busy?: readonly { start?: string; end?: string }[] }>
}

export interface BoundedGoogleCalendarRequest {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly body?: unknown
}

export interface BoundedGoogleCalendarResponse {
  readonly status: number
  readonly body: unknown
}

export interface BoundedGoogleCalendarTransport {
  readonly origin: typeof GOOGLE_CALENDAR_API_ORIGIN
  credentialState(): 'injected' | 'absent'
  request(input: BoundedGoogleCalendarRequest, signal?: AbortSignal): Promise<BoundedGoogleCalendarResponse>
}

/** Reject absolute URLs, escapes, and any path outside /calendar/v3. */
export function assertGoogleCalendarPath(path: string): string {
  if (typeof path !== 'string' || path === '') {
    throw new IntegrationError('calendar', 'invalid_request', 'google calendar path is required')
  }
  if (path.includes('://') || path.startsWith('//') || path.includes('..') || path.includes('\\')) {
    throw new IntegrationError('calendar', 'invalid_request', 'google calendar path is outside the approved boundary')
  }
  const pathname = path.split('?')[0] ?? path
  if (pathname !== GOOGLE_CALENDAR_API_PREFIX && !pathname.startsWith(`${GOOGLE_CALENDAR_API_PREFIX}/`)) {
    throw new IntegrationError('calendar', 'invalid_request', 'google calendar path is outside the approved boundary')
  }
  return path
}

/** Google event ids must be base32hex; SHA-256 hex is a valid subset. */
export function eventIdFromOperation(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
}

export function toGoogleEvent(input: CalendarCreateInput, id?: string): GoogleEventResource {
  const attendees = input.attendees?.map((email) => ({ email }))
  if (input.allDay) {
    return {
      id,
      summary: input.title.trim(),
      description: input.description,
      start: { date: input.start },
      end: { date: input.end },
      attendees,
    }
  }
  return {
    id,
    summary: input.title.trim(),
    description: input.description,
    start: { dateTime: input.start, timeZone: input.timeZone },
    end: { dateTime: input.end, timeZone: input.timeZone },
    attendees,
  }
}

export function fromGoogleEvent(body: unknown, calendarId = 'primary'): CalendarEvent {
  const value = body as GoogleEventResource
  const allDay = value.start?.date !== undefined && value.start.dateTime === undefined
  return {
    id: String(value.id ?? ''),
    title: String(value.summary ?? ''),
    start: allDay ? String(value.start?.date ?? '') : String(value.start?.dateTime ?? ''),
    end: allDay ? String(value.end?.date ?? '') : String(value.end?.dateTime ?? ''),
    timeZone: value.start?.timeZone ?? value.end?.timeZone,
    calendarId,
    description: value.description,
    attendees: value.attendees?.map((item) => String(item.email ?? '')).filter((item) => item !== ''),
    allDay,
  }
}

export function fromGoogleFreeBusy(body: unknown, calendarId = 'primary'): readonly FreeBusyWindow[] {
  const busy = (body as GoogleFreeBusyResponse).calendars?.[calendarId]?.busy ?? []
  return busy
    .filter((item) => item.start !== undefined && item.end !== undefined)
    .map((item) => ({ start: String(item.start), end: String(item.end), busy: true }))
}

export function calendarEventsPath(calendarId: string, query?: { timeMin?: string; timeMax?: string }): string {
  const encoded = encodeURIComponent(calendarId)
  if (query?.timeMin === undefined || query.timeMax === undefined) return `${GOOGLE_CALENDAR_API_PREFIX}/calendars/${encoded}/events`
  return `${GOOGLE_CALENDAR_API_PREFIX}/calendars/${encoded}/events?timeMin=${encodeURIComponent(query.timeMin)}&timeMax=${encodeURIComponent(query.timeMax)}`
}

export function calendarEventPath(calendarId: string, eventId: string): string {
  return `${GOOGLE_CALENDAR_API_PREFIX}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
}

export function freeBusyPath(): string {
  return `${GOOGLE_CALENDAR_API_PREFIX}/freeBusy`
}

export function isUncertainCreateError(error: unknown): boolean {
  if (!(error instanceof IntegrationError)) return false
  return error.code === 'cancelled' || /timeout/i.test(error.message)
}
