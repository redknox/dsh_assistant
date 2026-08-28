import { eventToDraft } from '../../domain/integrations/calendar-time.js'
import type {
  CalendarAttachment,
  CalendarAttendeeDetail,
  CalendarConference,
  CalendarCreateInput,
  CalendarEvent,
  CalendarLocation,
  CalendarOrganizer,
  CalendarProvider,
  CalendarReminder,
  FreeBusyWindow,
} from '../../domain/integrations/hub.js'
import { IntegrationError, type Page, type PageQuery, type ProposedMutation } from '../../domain/integrations/types.js'
import type { FeishuCliRunner } from './feishu-cli.js'

type JsonObject = Record<string, unknown>

export interface FeishuCalendarOptions {
  readonly runner: FeishuCliRunner
  readonly allowCreate?: boolean
}

/** Provider-neutral CalendarProvider backed only by allowlisted lark-cli calendar shortcuts. */
export function createFeishuCalendarProvider(options: FeishuCalendarOptions): CalendarProvider {
  const createdByKey = new Map<string, CalendarEvent>()
  return {
    capability: 'calendar',
    availability: () => ({ available: true, configured: true, provider: 'feishu' }),
    async listEvents(query): Promise<Page<CalendarEvent>> {
      const data = payloadOf(await options.runner.run([
        'calendar', '+agenda', '--start', query.from, '--end', query.to,
        '--calendar-id', 'primary', '--as', 'user', '--format', 'json',
      ], query.signal))
      return pageSlice(rowsOf(data, ['events', 'items']).map((row) => eventOf(row, 'primary')), query)
    },
    async getEvent(id, signal): Promise<CalendarEvent> {
      if (!id) throw new IntegrationError('calendar', 'invalid_request', 'event id is required')
      const data = payloadOf(await options.runner.run([
        'calendar', 'events', 'get', '--calendar-id', 'primary', '--event-id', id,
        '--need-attendee', '--max-attendee-num', '100', '--user-id-type', 'open_id',
        '--as', 'user', '--format', 'json',
      ], signal))
      const object = objectOf(data)
      return eventOf(object.event ?? object, 'primary')
    },
    async freeBusy(query): Promise<Page<FreeBusyWindow>> {
      const data = payloadOf(await options.runner.run([
        'calendar', '+freebusy', '--start', query.from, '--end', query.to, '--as', 'user', '--format', 'json',
      ], query.signal))
      return pageSlice(rowsOf(data, ['freebusy_list', 'free_busy', 'items']).map(freeBusyOf), query)
    },
    async proposeCreateEvent(input, signal): Promise<ProposedMutation<CalendarEvent>> {
      if (signal?.aborted) throw new IntegrationError('calendar', 'cancelled', 'calendar request was cancelled')
      const draft = eventToDraft(input)
      return {
        trust: 'propose',
        summary: `Propose calendar event "${draft.title}" on ${draft.calendarId ?? 'primary'} ${draft.start}/${draft.end} ${draft.timeZone ?? ''}`.trim(),
        draft,
      }
    },
    async createEvent(input, signal): Promise<CalendarEvent> {
      if (options.allowCreate !== true) throw new IntegrationError('calendar', 'unavailable', 'Feishu calendar create is not authorized')
      const draft = eventToDraft(input)
      if (!draft.title) throw new IntegrationError('calendar', 'invalid_request', 'event title is required')
      if (input.idempotencyKey) {
        const existing = createdByKey.get(input.idempotencyKey)
        if (existing) return existing
      }
      const args = [
        'calendar', '+create', '--summary', draft.title, '--start', draft.start, '--end', draft.end,
        '--calendar-id', draft.calendarId ?? 'primary', '--as', 'user', '--format', 'json',
      ]
      if (draft.description) args.push('--description', draft.description)
      if (draft.attendees?.length) args.push('--attendee-ids', draft.attendees.join(','))
      const data = objectOf(payloadOf(await options.runner.run(args, signal)))
      const event = eventOf(data.event ?? data, draft.calendarId ?? 'primary')
      if (input.idempotencyKey) createdByKey.set(input.idempotencyKey, event)
      return event
    },
  }
}

function eventOf(value: unknown, fallbackCalendarId: string): CalendarEvent {
  const row = objectOf(value)
  const start = timeOf(row.start ?? row.start_time)
  const end = timeOf(row.end ?? row.end_time)
  const attendees = optionalArrayOf(row.attendees, attendeeOf)
  const attendeeDetails = optionalArrayOf(row.attendees, attendeeDetailOf)
  const attachments = optionalArrayOf(row.attachments, attachmentOf)
  const reminders = optionalArrayOf(row.reminders, reminderOf)
  const startObject = objectOf(row.start ?? row.start_time)
  const organizer = organizerOf(row.event_organizer ?? row.organizer)
  const location = locationOf(row.location)
  const conference = conferenceOf(row.vchat ?? row.conference)
  return {
    id: stringOf(row.event_id ?? row.id) ?? '',
    title: stringOf(row.summary ?? row.title) ?? '',
    start,
    end,
    ...(stringOf(startObject.timezone ?? row.timezone) ? { timeZone: stringOf(startObject.timezone ?? row.timezone)! } : {}),
    calendarId: stringOf(row.calendar_id ?? row.organizer_calendar_id) ?? fallbackCalendarId,
    ...(stringOf(row.description_rich ?? row.description) ? { description: stringOf(row.description_rich ?? row.description)! } : {}),
    ...(attendees !== undefined ? { attendees } : {}),
    ...(attendeeDetails !== undefined ? { attendeeDetails } : {}),
    ...(typeof row.has_more_attendee === 'boolean' ? { hasMoreAttendees: row.has_more_attendee } : {}),
    ...(typeof startObject.date === 'string' ? { allDay: true } : {}),
    ...(organizer ? { organizer } : {}),
    ...(location ? { location } : {}),
    ...(reminders !== undefined ? { reminders } : {}),
    ...(stringOf(row.self_rsvp_status) ? { selfRsvpStatus: stringOf(row.self_rsvp_status)! } : {}),
    ...(stringOf(row.free_busy_status) ? { freeBusyStatus: stringOf(row.free_busy_status)! } : {}),
    ...(stringOf(row.attendee_ability) ? { attendeeAbility: stringOf(row.attendee_ability)! } : {}),
    ...(conference ? { conference } : {}),
    ...(stringOf(row.app_link) ? { appLink: stringOf(row.app_link)! } : {}),
    ...(stringOf(row.visibility) ? { visibility: stringOf(row.visibility)! } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  }
}

function organizerOf(value: unknown): CalendarOrganizer | undefined {
  const row = objectOf(value)
  const id = stringOf(row.user_id ?? row.open_id ?? row.id)
  const displayName = stringOf(row.display_name ?? row.name)
  return id || displayName ? { ...(id ? { id } : {}), ...(displayName ? { displayName } : {}) } : undefined
}

function locationOf(value: unknown): CalendarLocation | undefined {
  if (typeof value === 'string') return value ? { name: value } : undefined
  const row = objectOf(value)
  const name = stringOf(row.name)
  const address = stringOf(row.address)
  const latitude = numberOf(row.latitude)
  const longitude = numberOf(row.longitude)
  return name || address || latitude !== undefined || longitude !== undefined
    ? {
        ...(name ? { name } : {}),
        ...(address ? { address } : {}),
        ...(latitude !== undefined ? { latitude } : {}),
        ...(longitude !== undefined ? { longitude } : {}),
      }
    : undefined
}

function attendeeDetailOf(value: unknown): CalendarAttendeeDetail | undefined {
  const row = objectOf(value)
  const id = stringOf(row.user_id ?? row.chat_id ?? row.room_id ?? row.attendee_id ?? row.third_party_email ?? row.id)
  const displayName = stringOf(row.display_name ?? row.name ?? row.email)
  const type = stringOf(row.type)
  const rsvpStatus = stringOf(row.rsvp_status)
  const organizer = booleanOf(row.is_organizer)
  const optional = booleanOf(row.is_optional)
  const external = booleanOf(row.is_external)
  if (!id && !displayName && !type && !rsvpStatus && organizer === undefined && optional === undefined && external === undefined) return undefined
  return {
    ...(id ? { id } : {}),
    ...(displayName ? { displayName } : {}),
    ...(type ? { type } : {}),
    ...(rsvpStatus ? { rsvpStatus } : {}),
    ...(organizer !== undefined ? { organizer } : {}),
    ...(optional !== undefined ? { optional } : {}),
    ...(external !== undefined ? { external } : {}),
  }
}

function reminderOf(value: unknown): CalendarReminder | undefined {
  const row = objectOf(value)
  const minutes = numberOf(row.minutes ?? row.minutes_before_start)
  return minutes === undefined || minutes < 0 ? undefined : { minutesBeforeStart: minutes }
}

function conferenceOf(value: unknown): CalendarConference | undefined {
  const row = objectOf(value)
  const type = stringOf(row.vc_type ?? row.type)
  const meetingUrl = stringOf(row.meeting_url ?? row.url)
  return type || meetingUrl ? { ...(type ? { type } : {}), ...(meetingUrl ? { meetingUrl } : {}) } : undefined
}

function attachmentOf(value: unknown): CalendarAttachment | undefined {
  const row = objectOf(value)
  const id = stringOf(row.file_token ?? row.attachment_id ?? row.id)
  const name = stringOf(row.file_name ?? row.name)
  const url = stringOf(row.url ?? row.download_url)
  const mimeType = stringOf(row.mime_type ?? row.type)
  return id || name || url || mimeType
    ? { ...(id ? { id } : {}), ...(name ? { name } : {}), ...(url ? { url } : {}), ...(mimeType ? { mimeType } : {}) }
    : undefined
}

function freeBusyOf(value: unknown): FreeBusyWindow {
  const row = objectOf(value)
  return {
    start: timeOf(row.start ?? row.start_time),
    end: timeOf(row.end ?? row.end_time),
    busy: row.busy !== false,
  }
}

function attendeeOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const row = objectOf(value)
  return stringOf(row.display_name ?? row.name ?? row.email ?? row.third_party_email ?? row.user_id ?? row.open_id ?? row.room_id ?? row.chat_id ?? row.attendee_id ?? row.id)
}

function timeOf(value: unknown): string {
  if (typeof value === 'string') return value
  const row = objectOf(value)
  const date = stringOf(row.date)
  if (date) return date
  const datetime = stringOf(row.datetime)
  if (datetime) return datetime
  const timestamp = stringOf(row.timestamp)
  if (timestamp && /^\d+$/.test(timestamp)) return new Date(Number(timestamp) * 1000).toISOString()
  return ''
}

function pageSlice<T>(items: readonly T[], query: PageQuery): Page<T> {
  const limit = boundLimit(query.limit)
  const start = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10)
  if (!Number.isInteger(start) || start < 0) throw new IntegrationError('calendar', 'invalid_request', 'cursor is invalid')
  const page = items.slice(start, start + limit)
  const next = start + limit < items.length ? String(start + limit) : undefined
  return next ? { items: page, nextCursor: next } : { items: page }
}

function boundLimit(value: number | undefined): number {
  if (value === undefined) return 20
  if (!Number.isInteger(value) || value < 1) throw new IntegrationError('calendar', 'invalid_request', 'limit must be a positive integer')
  return Math.min(value, 20)
}

function payloadOf(value: unknown): unknown {
  const root = objectOf(value)
  if (root.ok === false) throw new IntegrationError('calendar', 'unavailable', 'Feishu calendar request was not authorized')
  return root.data ?? value
}

function rowsOf(value: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value
  const object = objectOf(value)
  for (const key of keys) {
    if (Array.isArray(object[key])) return object[key] as unknown[]
  }
  return []
}

function objectOf(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {}
}

function optionalArrayOf<T>(value: unknown, map: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(map).filter((item): item is T => item !== undefined)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
