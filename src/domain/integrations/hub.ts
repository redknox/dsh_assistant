import {
  IntegrationError,
  type Availability,
  type IntegrationCapability,
  type Page,
  type PageQuery,
  type ProposedMutation,
} from './types.js'

export interface CalendarEvent {
  readonly id: string
  readonly title: string
  readonly start: string
  readonly end: string
  readonly timeZone?: string
  readonly calendarId?: string
  readonly description?: string
  /** Provider-neutral participant labels (display names, addresses, or ids). */
  readonly attendees?: readonly string[]
  readonly attendeeDetails?: readonly CalendarAttendeeDetail[]
  readonly hasMoreAttendees?: boolean
  readonly allDay?: boolean
  /** Optional detail fields are omitted when the provider did not return them. */
  readonly organizer?: CalendarOrganizer
  readonly location?: CalendarLocation
  readonly reminders?: readonly CalendarReminder[]
  readonly selfRsvpStatus?: string
  readonly freeBusyStatus?: string
  readonly attendeeAbility?: string
  readonly conference?: CalendarConference
  readonly appLink?: string
  readonly visibility?: string
  readonly attachments?: readonly CalendarAttachment[]
}

export interface CalendarOrganizer {
  readonly id?: string
  readonly displayName?: string
}

export interface CalendarAttendeeDetail {
  readonly id?: string
  readonly displayName?: string
  readonly type?: string
  readonly rsvpStatus?: string
  readonly organizer?: boolean
  readonly optional?: boolean
  readonly external?: boolean
}

export interface CalendarLocation {
  readonly name?: string
  readonly address?: string
  readonly latitude?: number
  readonly longitude?: number
}

export interface CalendarReminder {
  readonly minutesBeforeStart: number
}

export interface CalendarConference {
  readonly type?: string
  readonly meetingUrl?: string
}

export interface CalendarAttachment {
  readonly id?: string
  readonly name?: string
  readonly url?: string
  readonly mimeType?: string
}

export interface CalendarCreateInput {
  readonly title: string
  readonly start: string
  readonly end: string
  readonly timeZone?: string
  readonly calendarId?: string
  readonly description?: string
  readonly attendees?: readonly string[]
  readonly allDay?: boolean
  readonly idempotencyKey?: string
}

export interface FreeBusyWindow {
  readonly start: string
  readonly end: string
  readonly busy: boolean
}

export interface MailMessage {
  readonly id: string
  readonly from: string
  readonly subject: string
  readonly snippet: string
}

export interface MailMessageDetail extends MailMessage {
  readonly body: string
}

export interface Contact {
  readonly id: string
  readonly name: string
  readonly email?: string
  readonly source?: 'mail-contact' | 'directory'
}

export interface FileEntry {
  readonly id: string
  readonly name: string
  readonly kind: 'file' | 'folder'
}

export interface TaskItem {
  readonly id: string
  readonly title: string
  readonly status: 'open' | 'done'
}

export interface CalendarProvider {
  readonly capability: 'calendar'
  availability(): Availability
  listEvents(query: { from: string; to: string } & PageQuery): Promise<Page<CalendarEvent>>
  getEvent(id: string, signal?: AbortSignal): Promise<CalendarEvent>
  freeBusy(query: { from: string; to: string; timeZone?: string } & PageQuery): Promise<Page<FreeBusyWindow>>
  proposeCreateEvent(input: CalendarCreateInput, signal?: AbortSignal): Promise<ProposedMutation<CalendarEvent>>
  createEvent(input: CalendarCreateInput, signal?: AbortSignal): Promise<CalendarEvent>
}

export interface MailProvider {
  readonly capability: 'mail'
  availability(): Availability
  listMessages(query: { query?: string } & PageQuery): Promise<Page<MailMessage>>
  getMessage(id: string, signal?: AbortSignal): Promise<MailMessageDetail>
}

export interface ContactsProvider {
  readonly capability: 'contacts'
  availability(): Availability
  listContacts(query: { query?: string } & PageQuery): Promise<Page<Contact>>
}

export interface ConfinedFileOp {
  readonly op: 'list' | 'read' | 'write'
  readonly root: string
  readonly path?: string
}

export interface ConfinedFileAccess {
  listTextFiles(input: { root: string; prefix?: string }): Promise<readonly string[]>
  readText(input: { root: string; path: string }): Promise<string>
  writeText(input: { root: string; path: string; content: string }): Promise<void>
  confinedAccesses(): readonly ConfinedFileOp[]
}

export interface FilesProvider extends ConfinedFileAccess {
  readonly capability: 'files'
  availability(): Availability
  listFiles(query: { path?: string } & PageQuery): Promise<Page<FileEntry>>
  deleteFile(id: string, signal?: AbortSignal): Promise<{ id: string; deleted: true }>
}

export interface TasksProvider {
  readonly capability: 'tasks'
  availability(): Availability
  listTasks(query: PageQuery): Promise<Page<TaskItem>>
  proposeCreateTask(input: { title: string }, signal?: AbortSignal): Promise<ProposedMutation<TaskItem>>
  createTask(input: { title: string }, signal?: AbortSignal): Promise<TaskItem>
}

export interface IntegrationProviders {
  readonly calendar: CalendarProvider
  readonly mail: MailProvider
  readonly contacts: ContactsProvider
  readonly files: FilesProvider
  readonly tasks: TasksProvider
}

/** Owns provider selection. Tools call the hub, never a concrete vendor SDK. */
export class IntegrationHub {
  constructor(private providers: IntegrationProviders) {}

  replaceCalendar(provider: CalendarProvider): () => void {
    const previous = this.providers.calendar
    this.providers = { ...this.providers, calendar: provider }
    return () => {
      this.providers = { ...this.providers, calendar: previous }
    }
  }

  replaceMail(provider: MailProvider): () => void {
    const previous = this.providers.mail
    this.providers = { ...this.providers, mail: provider }
    return () => {
      this.providers = { ...this.providers, mail: previous }
    }
  }

  replaceContacts(provider: ContactsProvider): () => void {
    const previous = this.providers.contacts
    this.providers = { ...this.providers, contacts: provider }
    return () => {
      this.providers = { ...this.providers, contacts: previous }
    }
  }

  replaceFiles(provider: FilesProvider): () => void {
    const previous = this.providers.files
    this.providers = { ...this.providers, files: provider }
    return () => {
      this.providers = { ...this.providers, files: previous }
    }
  }

  replaceTasks(provider: TasksProvider): () => void {
    const previous = this.providers.tasks
    this.providers = { ...this.providers, tasks: provider }
    return () => {
      this.providers = { ...this.providers, tasks: previous }
    }
  }

  status(): Record<IntegrationCapability, Availability> {
    return {
      calendar: this.providers.calendar.availability(),
      mail: this.providers.mail.availability(),
      contacts: this.providers.contacts.availability(),
      files: this.providers.files.availability(),
      tasks: this.providers.tasks.availability(),
    }
  }

  calendar(): CalendarProvider {
    return requireAvailable(this.providers.calendar)
  }

  mail(): MailProvider {
    return requireAvailable(this.providers.mail)
  }

  contacts(): ContactsProvider {
    return requireAvailable(this.providers.contacts)
  }

  files(): FilesProvider {
    return requireAvailable(this.providers.files)
  }

  tasks(): TasksProvider {
    return requireAvailable(this.providers.tasks)
  }
}

function requireAvailable<T extends { capability: IntegrationCapability; availability(): Availability }>(provider: T): T {
  const status = provider.availability()
  if (!status.available) {
    throw new IntegrationError(provider.capability, 'unavailable', status.reason ?? `${provider.capability} is unavailable`)
  }
  return provider
}
