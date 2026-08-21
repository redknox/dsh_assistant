import type { CalendarEvent } from './hub.js'
import { IntegrationError } from './types.js'

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

export function assertCalendarRange(input: { start: string; end: string; timeZone?: string; allDay?: boolean }): void {
  if (input.allDay) {
    if (!DATE_ONLY.test(input.start) || !DATE_ONLY.test(input.end)) {
      throw new IntegrationError('calendar', 'invalid_request', 'all-day events require YYYY-MM-DD start and end')
    }
    if (input.start >= input.end) throw new IntegrationError('calendar', 'invalid_request', 'all-day end must be after start')
    return
  }
  const start = Date.parse(input.start)
  const end = Date.parse(input.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new IntegrationError('calendar', 'invalid_request', 'start and end must be timezone-aware timestamps')
  }
  if (start >= end) throw new IntegrationError('calendar', 'invalid_request', 'event end must be after start')
  const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(input.start) && /([zZ]|[+-]\d{2}:?\d{2})$/.test(input.end)
  if (!hasOffset && (input.timeZone === undefined || input.timeZone === '')) {
    throw new IntegrationError('calendar', 'invalid_request', 'timed events require an explicit timezone or offset')
  }
}

export function eventToDraft(input: {
  readonly title: string
  readonly start: string
  readonly end: string
  readonly timeZone?: string
  readonly calendarId?: string
  readonly description?: string
  readonly attendees?: readonly string[]
  readonly allDay?: boolean
  readonly id?: string
}): CalendarEvent {
  assertCalendarRange(input)
  return {
    id: input.id ?? 'proposed-evt',
    title: input.title.trim(),
    start: input.start,
    end: input.end,
    timeZone: input.timeZone,
    calendarId: input.calendarId ?? 'primary',
    description: input.description,
    attendees: input.attendees,
    allDay: input.allDay,
  }
}
