import { createHash } from 'node:crypto'

export const GOOGLE_CALENDAR_API_ORIGIN = 'https://www.googleapis.com/calendar/v3'

export function eventIdFromOperation(idempotencyKey) {
  return createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 32)
}

export function toGoogleEvent(input, id) {
  const attendees = Array.isArray(input.attendees) ? input.attendees.map((email) => ({ email })) : undefined
  if (input.allDay) {
    return {
      id,
      summary: String(input.title ?? '').trim(),
      description: input.description,
      start: { date: input.start },
      end: { date: input.end },
      attendees,
    }
  }
  return {
    id,
    summary: String(input.title ?? '').trim(),
    description: input.description,
    start: { dateTime: input.start, timeZone: input.timeZone },
    end: { dateTime: input.end, timeZone: input.timeZone },
    attendees,
  }
}

export function fromGoogleEvent(body, calendarId = 'primary') {
  const allDay = body?.start?.date !== undefined && body.start.dateTime === undefined
  return {
    id: String(body?.id ?? ''),
    title: String(body?.summary ?? ''),
    start: allDay ? String(body.start?.date ?? '') : String(body?.start?.dateTime ?? ''),
    end: allDay ? String(body.end?.date ?? '') : String(body?.end?.dateTime ?? ''),
    timeZone: body?.start?.timeZone ?? body?.end?.timeZone,
    calendarId,
    description: body?.description,
    attendees: Array.isArray(body?.attendees)
      ? body.attendees.map((item) => String(item.email ?? '')).filter(Boolean)
      : undefined,
    allDay,
  }
}

export function fromGoogleFreeBusy(body, calendarId = 'primary') {
  const busy = body?.calendars?.[calendarId]?.busy ?? []
  return busy
    .filter((item) => item.start !== undefined && item.end !== undefined)
    .map((item) => ({ start: String(item.start), end: String(item.end), busy: true }))
}

export function calendarEventsPath(calendarId, query) {
  const encoded = encodeURIComponent(calendarId)
  if (query?.timeMin === undefined || query?.timeMax === undefined) return `/calendar/v3/calendars/${encoded}/events`
  return `/calendar/v3/calendars/${encoded}/events?timeMin=${encodeURIComponent(query.timeMin)}&timeMax=${encodeURIComponent(query.timeMax)}`
}

export function calendarEventPath(calendarId, eventId) {
  return `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
}

export function isUncertainCreateError(error) {
  return Boolean(error) && (error.code === 'cancelled' || /timeout/i.test(String(error.message ?? '')))
}
