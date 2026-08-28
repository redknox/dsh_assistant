import { ConfinedRootFiles } from './confined-root-files.js'
import { eventToDraft } from '../../domain/integrations/calendar-time.js'
import { IntegrationHub, type CalendarCreateInput, type FreeBusyWindow, type IntegrationProviders } from '../../domain/integrations/hub.js'
import {
  IntegrationError,
  throwIfAborted,
  type Availability,
  type IntegrationCapability,
  type Page,
  type PageQuery,
  type ProposedMutation,
} from '../../domain/integrations/types.js'
import type {
  CalendarEvent,
  CalendarProvider,
  Contact,
  ContactsProvider,
  FileEntry,
  FilesProvider,
  MailMessage,
  MailProvider,
  TaskItem,
  TasksProvider,
} from '../../domain/integrations/hub.js'

interface FakeState {
  unavailable: Partial<Record<IntegrationCapability, string>>
  notConfigured: Set<IntegrationCapability>
  fail: Partial<Record<IntegrationCapability, string>>
  waitForAbort: Partial<Record<IntegrationCapability, boolean>>
  waiting?: () => void
}

function pageSlice<T>(items: readonly T[], query: PageQuery, capability: IntegrationCapability): Page<T> {
  throwIfAborted(capability, query.signal)
  const limit = query.limit === undefined ? 10 : query.limit
  if (!Number.isInteger(limit) || limit < 1) {
    throw new IntegrationError(capability, 'invalid_request', 'limit must be a positive integer')
  }
  const size = Math.min(limit, 20)
  const start = query.cursor ? Number.parseInt(query.cursor, 10) : 0
  if (!Number.isFinite(start) || start < 0) {
    throw new IntegrationError(capability, 'invalid_request', 'cursor is invalid')
  }
  const slice = items.slice(start, start + size)
  const next = start + size < items.length ? String(start + size) : undefined
  return next ? { items: slice, nextCursor: next } : { items: slice }
}

class FakeBase<C extends IntegrationCapability> {
  constructor(
    readonly capability: C,
    protected readonly state: FakeState,
  ) {}

  availability(): Availability {
    const reason = this.state.unavailable[this.capability]
    return reason
      ? { available: false, configured: !this.state.notConfigured.has(this.capability), reason, provider: 'fake' }
      : { available: true, configured: true, provider: 'fake' }
  }

  protected guard(signal?: AbortSignal): void {
    throwIfAborted(this.capability, signal)
    const failure = this.state.fail[this.capability]
    if (failure) throw new IntegrationError(this.capability, 'provider_failure', failure)
  }

  protected async waitIfRequested(signal?: AbortSignal): Promise<void> {
    if (!this.state.waitForAbort[this.capability]) return
    if (!signal) {
      throw new IntegrationError(this.capability, 'invalid_request', 'cancellation signal is required')
    }
    if (!signal.aborted) {
      this.state.waiting?.()
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  }
}

class FakeCalendar extends FakeBase<'calendar'> implements CalendarProvider {
  readonly events: CalendarEvent[] = [
    { id: 'evt-1', title: 'Team standup', start: '2026-08-21T01:00:00.000Z', end: '2026-08-21T01:15:00.000Z', timeZone: 'UTC', calendarId: 'primary' },
    { id: 'evt-2', title: 'Office hours', start: '2026-08-21T03:00:00.000Z', end: '2026-08-21T04:00:00.000Z', timeZone: 'UTC', calendarId: 'primary' },
    { id: 'evt-3', title: 'Retro', start: '2026-08-21T06:00:00.000Z', end: '2026-08-21T07:00:00.000Z', timeZone: 'UTC', calendarId: 'primary' },
  ]
  private readonly idempotent = new Map<string, CalendarEvent>()

  constructor(state: FakeState) {
    super('calendar', state)
  }

  async listEvents(query: { from: string; to: string } & PageQuery): Promise<Page<CalendarEvent>> {
    await this.waitIfRequested(query.signal)
    this.guard(query.signal)
    if (!query.from || !query.to) {
      throw new IntegrationError('calendar', 'invalid_request', 'from and to are required')
    }
    const items = this.events.filter((event) => event.start >= query.from && event.start <= query.to)
    return pageSlice(items, query, 'calendar')
  }

  async getEvent(id: string, signal?: AbortSignal): Promise<CalendarEvent> {
    await this.waitIfRequested(signal)
    this.guard(signal)
    const found = this.events.find((event) => event.id === id)
    if (found === undefined) throw new IntegrationError('calendar', 'invalid_request', 'event not found')
    return found
  }

  async freeBusy(query: { from: string; to: string; timeZone?: string } & PageQuery): Promise<Page<FreeBusyWindow>> {
    await this.waitIfRequested(query.signal)
    this.guard(query.signal)
    if (!query.from || !query.to) throw new IntegrationError('calendar', 'invalid_request', 'from and to are required')
    const windows: FreeBusyWindow[] = this.events
      .filter((event) => event.start < query.to && event.end > query.from)
      .map((event) => ({ start: event.start, end: event.end, busy: true }))
    return pageSlice(windows, query, 'calendar')
  }

  async proposeCreateEvent(input: CalendarCreateInput, signal?: AbortSignal): Promise<ProposedMutation<CalendarEvent>> {
    await this.waitIfRequested(signal)
    this.guard(signal)
    if (!input.title.trim()) throw new IntegrationError('calendar', 'invalid_request', 'title is required')
    const draft = eventToDraft(input)
    return { trust: 'propose', summary: `Propose calendar event "${draft.title}" on ${draft.calendarId ?? 'primary'} ${draft.start}/${draft.end} ${draft.timeZone ?? ''}`.trim(), draft }
  }

  async createEvent(input: CalendarCreateInput, signal?: AbortSignal): Promise<CalendarEvent> {
    await this.waitIfRequested(signal)
    this.guard(signal)
    if (!input.title.trim()) throw new IntegrationError('calendar', 'invalid_request', 'title is required')
    if (input.idempotencyKey !== undefined && this.idempotent.has(input.idempotencyKey)) {
      return this.idempotent.get(input.idempotencyKey)!
    }
    const event: CalendarEvent = { ...eventToDraft(input), id: `evt-${this.events.length + 1}` }
    this.events.push(event)
    if (input.idempotencyKey !== undefined) this.idempotent.set(input.idempotencyKey, event)
    return event
  }
}

class FakeMail extends FakeBase<'mail'> implements MailProvider {
  constructor(state: FakeState) {
    super('mail', state)
  }

  async listMessages(query: { query?: string } & PageQuery): Promise<Page<MailMessage>> {
    await this.waitIfRequested(query.signal)
    this.guard(query.signal)
    const all: MailMessage[] = [
      { id: 'msg-1', from: 'noreply@example.com', subject: 'Weekly digest', snippet: 'Three unread items' },
    ]
    const filtered = query.query ? all.filter((item) => item.subject.toLowerCase().includes(query.query!.toLowerCase())) : all
    return pageSlice(filtered, query, 'mail')
  }

  async getMessage(id: string, signal?: AbortSignal) {
    await this.waitIfRequested(signal)
    this.guard(signal)
    return { id, from: 'noreply@example.com', subject: 'Weekly digest', snippet: 'Three unread items', body: 'Three unread items' }
  }
}

class FakeContacts extends FakeBase<'contacts'> implements ContactsProvider {
  constructor(state: FakeState) {
    super('contacts', state)
  }

  async listContacts(query: PageQuery): Promise<Page<Contact>> {
    await this.waitIfRequested(query.signal)
    this.guard(query.signal)
    return pageSlice([{ id: 'c-1', name: 'Alex Example', email: 'alex@example.com' }], query, 'contacts')
  }
}

class FakeFiles extends FakeBase<'files'> implements FilesProvider {
  readonly entries: FileEntry[] = [{ id: 'f-1', name: 'notes.md', kind: 'file' }]
  private readonly confined = new ConfinedRootFiles()

  constructor(state: FakeState) {
    super('files', state)
  }

  confinedAccesses() {
    return this.confined.confinedAccesses()
  }

  async listTextFiles(input: { root: string; prefix?: string }) {
    return this.confined.listTextFiles(input)
  }

  async readText(input: { root: string; path: string }) {
    return this.confined.readText(input)
  }

  async writeText(input: { root: string; path: string; content: string }) {
    return this.confined.writeText(input)
  }

  async listFiles(query: { path?: string } & PageQuery): Promise<Page<FileEntry>> {
    await this.waitIfRequested(query.signal)
    this.guard(query.signal)
    return pageSlice(this.entries, query, 'files')
  }

  async deleteFile(id: string, signal?: AbortSignal): Promise<{ id: string; deleted: true }> {
    await this.waitIfRequested(signal)
    this.guard(signal)
    const index = this.entries.findIndex((entry) => entry.id === id)
    if (index < 0) throw new IntegrationError('files', 'invalid_request', 'file not found')
    this.entries.splice(index, 1)
    return { id, deleted: true }
  }
}

class FakeTasks extends FakeBase<'tasks'> implements TasksProvider {
  readonly items: TaskItem[] = [{ id: 't-1', title: 'Review agenda', status: 'open' }]

  constructor(state: FakeState) {
    super('tasks', state)
  }

  async listTasks(query: PageQuery): Promise<Page<TaskItem>> {
    await this.waitIfRequested(query.signal)
    this.guard(query.signal)
    return pageSlice(this.items, query, 'tasks')
  }

  async proposeCreateTask(input: { title: string }, signal?: AbortSignal): Promise<ProposedMutation<TaskItem>> {
    await this.waitIfRequested(signal)
    this.guard(signal)
    if (!input.title.trim()) throw new IntegrationError('tasks', 'invalid_request', 'title is required')
    const draft: TaskItem = { id: 'proposed-task', title: input.title.trim(), status: 'open' }
    return { trust: 'propose', summary: `Propose task "${draft.title}"`, draft }
  }

  async createTask(input: { title: string }, signal?: AbortSignal): Promise<TaskItem> {
    await this.waitIfRequested(signal)
    this.guard(signal)
    if (!input.title.trim()) throw new IntegrationError('tasks', 'invalid_request', 'title is required')
    const item: TaskItem = { id: `t-${this.items.length + 1}`, title: input.title.trim(), status: 'open' }
    this.items.push(item)
    return item
  }
}

export class FakeIntegrationSuite {
  readonly state: FakeState = { unavailable: {}, notConfigured: new Set(), fail: {}, waitForAbort: {} }
  readonly providers: IntegrationProviders
  readonly hub: IntegrationHub

  constructor() {
    this.providers = {
      calendar: new FakeCalendar(this.state),
      mail: new FakeMail(this.state),
      contacts: new FakeContacts(this.state),
      files: new FakeFiles(this.state),
      tasks: new FakeTasks(this.state),
    }
    this.hub = new IntegrationHub(this.providers)
  }
}
