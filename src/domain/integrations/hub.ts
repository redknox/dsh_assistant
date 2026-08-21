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
}

export interface MailMessage {
  readonly id: string
  readonly from: string
  readonly subject: string
  readonly snippet: string
}

export interface Contact {
  readonly id: string
  readonly name: string
  readonly email?: string
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
  proposeCreateEvent(input: { title: string; start: string; end: string }, signal?: AbortSignal): Promise<ProposedMutation<CalendarEvent>>
  createEvent(input: { title: string; start: string; end: string }, signal?: AbortSignal): Promise<CalendarEvent>
}

export interface MailProvider {
  readonly capability: 'mail'
  availability(): Availability
  listMessages(query: { query?: string } & PageQuery): Promise<Page<MailMessage>>
}

export interface ContactsProvider {
  readonly capability: 'contacts'
  availability(): Availability
  listContacts(query: PageQuery): Promise<Page<Contact>>
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
  constructor(private readonly providers: IntegrationProviders) {}

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
