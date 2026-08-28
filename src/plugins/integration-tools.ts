import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { IntegrationHub } from '../domain/integrations/hub.js'
import { IntegrationError } from '../domain/integrations/types.js'
import type { MeetingNotesProvider } from '../adapters/integrations/feishu-meeting-notes.js'

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

async function runJson(action: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await action())
  } catch (error) {
    if (error instanceof IntegrationError) {
      return JSON.stringify({ error: { capability: error.capability, code: error.code, message: error.message } })
    }
    throw error
  }
}

/** Thin DSH adapters. Trust is declared in names/descriptions; no vendor SDKs here. */
export function registerIntegrationTools(
  tools: Pick<ToolRuntime, 'register'>,
  hub: IntegrationHub,
  meetingNotes?: MeetingNotesProvider,
): () => void {
  const disposers = [
    tools.register(defineTool({
      name: 'calendar_list_events',
      description: 'Read-only: list calendar events in a time range. Does not create or change events.',
      parameters: {
        from: { type: 'string', required: true },
        to: { type: 'string', required: true },
        limit: { type: 'integer' },
        cursor: { type: 'string' },
      },
      output: textOutput(),
      async execute(args, exec) {
        return runJson(() => hub.calendar().listEvents({
          from: args.from,
          to: args.to,
          limit: args.limit,
          cursor: args.cursor,
          signal: exec.signal,
        }))
      },
    })),
    tools.register(defineTool({
      name: 'calendar_propose_event',
      description: 'Propose creating a calendar event. This is a draft only; it does not execute the create.',
      parameters: {
        title: { type: 'string', required: true },
        start: { type: 'string', required: true },
        end: { type: 'string', required: true },
        timeZone: { type: 'string' },
        calendarId: { type: 'string' },
        description: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' } },
        allDay: { type: 'boolean' },
      },
      output: textOutput(),
      async execute(args, exec) {
        return runJson(() => hub.calendar().proposeCreateEvent({
          title: args.title,
          start: args.start,
          end: args.end,
          timeZone: args.timeZone,
          calendarId: args.calendarId,
          description: args.description,
          attendees: args.attendees,
          allDay: args.allDay,
        }, exec.signal))
      },
    })),
    tools.register(defineTool({
      name: 'calendar_get_event',
      description: 'Read-only: inspect one calendar event by id. Optional properties are included only when the provider returns them; an omitted property means unknown/not returned, not proof that the detail does not exist. Does not create or change events.',
      parameters: {
        id: { type: 'string', required: true },
      },
      output: textOutput(),
      async execute(args, exec) {
        return runJson(() => hub.calendar().getEvent(args.id, exec.signal))
      },
    })),
    tools.register(defineTool({
      name: 'calendar_freebusy',
      description: 'Read-only: list busy windows in a time range. Does not create or change events.',
      parameters: {
        from: { type: 'string', required: true },
        to: { type: 'string', required: true },
        timeZone: { type: 'string' },
        limit: { type: 'integer' },
        cursor: { type: 'string' },
      },
      output: textOutput(),
      async execute(args, exec) {
        return runJson(() => hub.calendar().freeBusy({
          from: args.from,
          to: args.to,
          timeZone: args.timeZone,
          limit: args.limit,
          cursor: args.cursor,
          signal: exec.signal,
        }))
      },
    })),
    tools.register(defineTool({
      name: 'mail_list_messages',
      description: 'Read-only: list mail messages. Does not send mail.',
      parameters: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        cursor: { type: 'string' },
      },
      output: textOutput(),
      async execute(args, exec) {
        return runJson(() => hub.mail().listMessages({
          query: args.query,
          limit: args.limit,
          cursor: args.cursor,
          signal: exec.signal,
        }))
      },
    })),
    tools.register(defineTool({
      name: 'mail_get_message',
      description: 'Read-only: get one Feishu mail message by id. Does not modify or send mail.',
      parameters: { id: { type: 'string', required: true } },
      output: textOutput(),
      async execute(args, exec) {
        return runJson(() => hub.mail().getMessage(args.id, exec.signal))
      },
    })),
    tools.register(defineTool({
      name: 'contacts_search',
      description: 'Read-only: list personal mail contacts, or search the Feishu enterprise directory by query.',
      parameters: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        cursor: { type: 'string' },
      },
      output: textOutput(),
      async execute(args, exec) {
        return runJson(() => hub.contacts().listContacts({ query: args.query, limit: args.limit, cursor: args.cursor, signal: exec.signal }))
      },
    })),
    tools.register(defineTool({
      name: 'tasks_propose_create',
      description: 'Propose creating a task. Draft only; does not execute the create.',
      parameters: {
        title: { type: 'string', required: true },
      },
      output: textOutput(),
      async execute(args, exec) {
        return runJson(() => hub.tasks().proposeCreateTask({ title: args.title }, exec.signal))
      },
    })),
    tools.register(defineTool({
      name: 'files_list',
      description: 'Read-only: list files inside the operator sandbox. Paths are sandbox-relative. Does not write or delete.',
      parameters: {
        path: { type: 'string' },
        limit: { type: 'integer' },
        cursor: { type: 'string' },
      },
      output: textOutput(),
      async execute(args, exec) {
        return runJson(() => hub.files().listFiles({
          path: args.path,
          limit: args.limit,
          cursor: args.cursor,
          signal: exec.signal,
        }))
      },
    })),
    tools.register(defineTool({
      name: 'files_read',
      description: 'Read-only: read a text file inside the operator sandbox. Path is sandbox-relative. Does not write or delete.',
      parameters: {
        path: { type: 'string', required: true },
      },
      output: textOutput(),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        return runJson(() => hub.files().readText({ root: '', path: args.path }))
      },
    })),
    tools.register(defineTool({
      name: 'integration_status',
      description: 'Read-only: report availability of personal integration capabilities.',
      parameters: {},
      output: textOutput(),
      async execute(_args, exec) {
        exec.signal.throwIfAborted()
        return JSON.stringify({ trust: 'read', status: hub.status() })
      },
    })),
  ]
  if (meetingNotes) {
    disposers.push(
      tools.register(defineTool({
        name: 'meeting_get_artifacts',
        description: 'Read-only: resolve a calendar event id to available Feishu meeting artifacts. Reports AI notes, transcript, Minutes, and shared-document availability without reading their content.',
        parameters: { calendarEventId: { type: 'string', required: true } },
        output: textOutput(),
        async execute(args, exec) {
          return runJson(() => meetingNotes.inspect(args.calendarEventId, exec.signal))
        },
      })),
      tools.register(defineTool({
        name: 'meeting_read_ai_notes',
        description: 'Read-only: fetch the Feishu-generated AI meeting notes document for a calendar event id as Markdown. This is provider-generated AI content, not an independent analysis from the transcript. Content defaults to 20,000 characters and is capped at 50,000.',
        parameters: {
          calendarEventId: { type: 'string', required: true },
          maxChars: { type: 'integer' },
        },
        output: textOutput(),
        async execute(args, exec) {
          return runJson(() => meetingNotes.readAiNotes(args.calendarEventId, { maxChars: args.maxChars, signal: exec.signal }))
        },
      })),
    )
  }
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}
