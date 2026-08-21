export function assertCalendarRange(input) {
  if (input.allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.start) || !/^\d{4}-\d{2}-\d{2}$/.test(input.end)) {
      throw Object.assign(new Error('all-day events require YYYY-MM-DD start and end'), { code: 'invalid_request' })
    }
    if (input.start >= input.end) throw Object.assign(new Error('all-day end must be after start'), { code: 'invalid_request' })
    return
  }
  const start = Date.parse(input.start)
  const end = Date.parse(input.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw Object.assign(new Error('start and end must be timezone-aware timestamps'), { code: 'invalid_request' })
  }
  if (start >= end) throw Object.assign(new Error('event end must be after start'), { code: 'invalid_request' })
  const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(input.start) && /([zZ]|[+-]\d{2}:?\d{2})$/.test(input.end)
  if (!hasOffset && (input.timeZone === undefined || input.timeZone === '')) {
    throw Object.assign(new Error('timed events require an explicit timezone or offset'), { code: 'invalid_request' })
  }
}

export function eventToDraft(input) {
  assertCalendarRange(input)
  return {
    id: input.id ?? 'proposed-evt',
    title: String(input.title ?? '').trim(),
    start: input.start,
    end: input.end,
    timeZone: input.timeZone,
    calendarId: input.calendarId ?? 'primary',
    description: input.description,
    attendees: input.attendees,
    allDay: input.allDay,
  }
}
