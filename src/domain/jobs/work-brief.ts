import type { CalendarEvent, IntegrationHub, MailMessage, TaskItem } from '../integrations/hub.js'
import type { PersonalKnowledge } from '../knowledge/types.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_ITEMS = 10

export interface WorkBriefInput {
  readonly hub: IntegrationHub
  readonly knowledge?: PersonalKnowledge
  readonly now: Date
  readonly timeZone?: string
  readonly signal?: AbortSignal
}

interface SourceResult<T> {
  readonly items: readonly T[]
  readonly warning?: string
}

/** Build one bounded, read-only brief while containing individual provider failures. */
export async function buildWorkBrief(input: WorkBriefInput): Promise<string> {
  throwIfAborted(input.signal)
  const timeZone = validTimeZone(input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const range = zonedDayRange(input.now, timeZone)
  const availability = input.hub.status()
  const [calendar, tasks, mail] = await Promise.all([
    readSource('Calendar', availability.calendar, input.signal, () => input.hub.calendar().listEvents({ ...range, limit: MAX_ITEMS, signal: input.signal })),
    readSource('Tasks', availability.tasks, input.signal, () => input.hub.tasks().listTasks({ limit: MAX_ITEMS, signal: input.signal })),
    readSource('Mail', availability.mail, input.signal, () => input.hub.mail().listMessages({ limit: 5, signal: input.signal })),
  ])
  throwIfAborted(input.signal)

  const openTasks = tasks.items.filter((item) => item.status === 'open')
  const knowledge = relevantKnowledge(input.knowledge, [...calendar.items, ...openTasks])
  const warnings = [calendar.warning, tasks.warning, mail.warning].filter((item): item is string => item !== undefined)

  return [
    `# Work brief — ${range.date}`,
    `Time zone: ${timeZone}`,
    '',
    section('Calendar', calendar.items.length, calendar.items.map((event) => calendarLine(event, timeZone)), 'No events today.'),
    '',
    section('Open tasks', openTasks.length, openTasks.map((task) => `- ${quoted(task.title)}`), 'No open tasks.'),
    '',
    section('Recent mail', mail.items.length, mail.items.map(mailLine), 'No recent mail.'),
    '',
    section('Relevant knowledge', knowledge.length, knowledge, 'No related knowledge found.'),
    ...(warnings.length > 0 ? ['', '## Source status', ...warnings.map((warning) => `- ${warning}`)] : []),
  ].join('\n')
}

async function readSource<T>(
  label: string,
  availability: { available: boolean; configured?: boolean },
  signal: AbortSignal | undefined,
  load: () => Promise<{ readonly items: readonly T[] }>,
): Promise<SourceResult<T>> {
  if (!availability.available) {
    return { items: [], warning: `${label}: ${availability.configured === false ? 'not connected' : 'temporarily unavailable'}` }
  }
  try {
    const result = await load()
    return { items: result.items.slice(0, MAX_ITEMS) }
  } catch {
    throwIfAborted(signal)
    return { items: [], warning: `${label}: temporarily unavailable` }
  }
}

function relevantKnowledge(knowledge: PersonalKnowledge | undefined, context: readonly (CalendarEvent | TaskItem)[]): string[] {
  if (!knowledge || context.length === 0) return []
  const text = context.map((item) => item.title).join(' ').slice(0, 1_024)
  try {
    return knowledge.retrieve({ text, limit: 3 }).hits.map((hit) => {
      const label = hit.document.title ?? hit.document.sourceUri
      return `- ${quoted(label)} — ${quoted(hit.citation.excerpt, 180)}`
    })
  } catch {
    return []
  }
}

function section(title: string, count: number, lines: readonly string[], empty: string): string {
  return [`## ${title} (${count})`, ...(lines.length > 0 ? lines : [`- ${empty}`])].join('\n')
}

function calendarLine(event: CalendarEvent, timeZone: string): string {
  const when = event.allDay
    ? 'ALL DAY'
    : `${formatTime(event.start, timeZone)}–${formatTime(event.end, timeZone)}`
  const location = event.location?.name ?? event.location?.address
  const attendees = event.attendees?.length ?? event.attendeeDetails?.length ?? 0
  return `- ${when} · ${quoted(event.title)}${location ? ` · ${quoted(location)}` : ''}${attendees > 0 ? ` · ${attendees} attendee${attendees === 1 ? '' : 's'}` : ''}`
}

function mailLine(message: MailMessage): string {
  return `- ${quoted(message.subject)} · from ${quoted(message.from)}`
}

function quoted(value: string, max = 160): string {
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  return JSON.stringify(text)
}

function formatTime(value: string, timeZone: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '--:--'
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function validTimeZone(value: string | undefined): string {
  const candidate = value?.trim() || 'UTC'
  try {
    new Intl.DateTimeFormat('en', { timeZone: candidate }).format(0)
    return candidate
  } catch {
    return 'UTC'
  }
}

function zonedDayRange(now: Date, timeZone: string): { date: string; from: string; to: string } {
  const parts = dateParts(now, timeZone)
  const start = localMidnight(parts.year, parts.month, parts.day, timeZone)
  const nextCalendarDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + DAY_MS)
  const end = localMidnight(nextCalendarDay.getUTCFullYear(), nextCalendarDay.getUTCMonth() + 1, nextCalendarDay.getUTCDate(), timeZone) - 1
  return {
    date: `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
  }
}

function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  const desired = Date.UTC(year, month - 1, day)
  let instant = desired
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const actual = dateTimeParts(new Date(instant), timeZone)
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
    instant -= represented - desired
  }
  return instant
}

function dateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = dateTimeParts(date, timeZone)
  return { year: parts.year, month: parts.month, day: parts.day }
}

function dateTimeParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const entries = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(entries.find((entry) => entry.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('cancelled')
}
