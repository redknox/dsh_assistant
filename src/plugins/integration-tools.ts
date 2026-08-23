import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { IntegrationHub } from '../domain/integrations/hub.js'
import { IntegrationError } from '../domain/integrations/types.js'

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
export function registerIntegrationTools(tools: Pick<ToolRuntime, 'register'>, hub: IntegrationHub): () => void {
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
      description: 'Read-only: inspect one calendar event by id. Does not create or change events.',
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
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}
