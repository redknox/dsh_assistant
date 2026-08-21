import { IntegrationHub, type IntegrationProviders } from '../../domain/integrations/hub.js'
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
  WebSearchHit,
  WebSearchProvider,
} from '../../domain/integrations/hub.js'

interface FakeState {
  unavailable: Partial<Record<IntegrationCapability, string>>
  fail: Partial<Record<IntegrationCapability, string>>
}

function pageSlice<T extends { id?: string } | WebSearchHit>(items: readonly T[], query: PageQuery, capability: IntegrationCapability): Page<T> {
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
    private readonly state: FakeState,
  ) {}

  availability(): Availability {
    const reason = this.state.unavailable[this.capability]
    return reason ? { available: false, reason } : { available: true }
  }

  protected guard(signal?: AbortSignal): void {
    throwIfAborted(this.capability, signal)
    const failure = this.state.fail[this.capability]
    if (failure) throw new IntegrationError(this.capability, 'provider_failure', failure)
  }
}

class FakeCalendar extends FakeBase<'calendar'> implements CalendarProvider {
  readonly events: CalendarEvent[] = [
    { id: 'evt-1', title: 'Team standup', start: '2026-08-21T01:00:00.000Z', end: '2026-08-21T01:15:00.000Z' },
  ]

  constructor(state: FakeState) {
    super('calendar', state)
  }

  async listEvents(query: { from: string; to: string } & PageQuery): Promise<Page<CalendarEvent>> {
    this.guard(query.signal)
    if (!query.from || !query.to) {
      throw new IntegrationError('calendar', 'invalid_request', 'from and to are required')
    }
    const items = this.events.filter((event) => event.start >= query.from && event.start <= query.to)
    return pageSlice(items, query, 'calendar')
  }

  async proposeCreateEvent(input: { title: string; start: string; end: string }, signal?: AbortSignal): Promise<ProposedMutation<CalendarEvent>> {
    this.guard(signal)
    if (!input.title.trim()) throw new IntegrationError('calendar', 'invalid_request', 'title is required')
    const draft: CalendarEvent = { id: 'proposed-evt', title: input.title.trim(), start: input.start, end: input.end }
    return { trust: 'propose', summary: `Propose calendar event "${draft.title}"`, draft }
  }
}

class FakeMail extends FakeBase<'mail'> implements MailProvider {
  constructor(state: FakeState) {
    super('mail', state)
  }

  async listMessages(query: { query?: string } & PageQuery): Promise<Page<MailMessage>> {
    this.guard(query.signal)
    const all: MailMessage[] = [
      { id: 'msg-1', from: 'noreply@example.com', subject: 'Weekly digest', snippet: 'Three unread items' },
    ]
    const filtered = query.query ? all.filter((item) => item.subject.toLowerCase().includes(query.query!.toLowerCase())) : all
    return pageSlice(filtered, query, 'mail')
  }
}

class FakeContacts extends FakeBase<'contacts'> implements ContactsProvider {
  constructor(state: FakeState) {
    super('contacts', state)
  }

  async listContacts(query: PageQuery): Promise<Page<Contact>> {
    this.guard(query.signal)
    return pageSlice([{ id: 'c-1', name: 'Alex Example', email: 'alex@example.com' }], query, 'contacts')
  }
}

class FakeFiles extends FakeBase<'files'> implements FilesProvider {
  constructor(state: FakeState) {
    super('files', state)
  }

  async listFiles(query: { path?: string } & PageQuery): Promise<Page<FileEntry>> {
    this.guard(query.signal)
    return pageSlice([{ id: 'f-1', name: 'notes.md', kind: 'file' }], query, 'files')
  }
}

class FakeTasks extends FakeBase<'tasks'> implements TasksProvider {
  constructor(state: FakeState) {
    super('tasks', state)
  }

  async listTasks(query: PageQuery): Promise<Page<TaskItem>> {
    this.guard(query.signal)
    return pageSlice([{ id: 't-1', title: 'Review agenda', status: 'open' }], query, 'tasks')
  }

  async proposeCreateTask(input: { title: string }, signal?: AbortSignal): Promise<ProposedMutation<TaskItem>> {
    this.guard(signal)
    if (!input.title.trim()) throw new IntegrationError('tasks', 'invalid_request', 'title is required')
    const draft: TaskItem = { id: 'proposed-task', title: input.title.trim(), status: 'open' }
    return { trust: 'propose', summary: `Propose task "${draft.title}"`, draft }
  }
}

class FakeWebSearch extends FakeBase<'web_search'> implements WebSearchProvider {
  constructor(state: FakeState) {
    super('web_search', state)
  }

  async search(query: { text: string } & PageQuery): Promise<Page<WebSearchHit>> {
    this.guard(query.signal)
    if (!query.text.trim()) throw new IntegrationError('web_search', 'invalid_request', 'text is required')
    return pageSlice(
      [{ title: `Fake result for ${query.text}`, url: 'https://example.com/search', snippet: 'Fixture search hit' }],
      query,
      'web_search',
    )
  }
}

export class FakeIntegrationSuite {
  readonly state: FakeState = { unavailable: {}, fail: {} }
  readonly providers: IntegrationProviders
  readonly hub: IntegrationHub

  constructor() {
    this.providers = {
      calendar: new FakeCalendar(this.state),
      mail: new FakeMail(this.state),
      contacts: new FakeContacts(this.state),
      files: new FakeFiles(this.state),
      tasks: new FakeTasks(this.state),
      webSearch: new FakeWebSearch(this.state),
    }
    this.hub = new IntegrationHub(this.providers)
  }
}
