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
      },
      output: textOutput(),
      async execute(args) {
        return runJson(() => hub.calendar().listEvents({ from: args.from, to: args.to, limit: args.limit }))
      },
    })),
    tools.register(defineTool({
      name: 'calendar_propose_event',
      description: 'Propose creating a calendar event. This is a draft only; it does not execute the create.',
      parameters: {
        title: { type: 'string', required: true },
        start: { type: 'string', required: true },
        end: { type: 'string', required: true },
      },
      output: textOutput(),
      async execute(args) {
        return runJson(() => hub.calendar().proposeCreateEvent({ title: args.title, start: args.start, end: args.end }))
      },
    })),
    tools.register(defineTool({
      name: 'mail_list_messages',
      description: 'Read-only: list mail messages. Does not send mail.',
      parameters: {
        query: { type: 'string' },
        limit: { type: 'integer' },
      },
      output: textOutput(),
      async execute(args) {
        return runJson(() => hub.mail().listMessages({ query: args.query, limit: args.limit }))
      },
    })),
    tools.register(defineTool({
      name: 'tasks_propose_create',
      description: 'Propose creating a task. Draft only; does not execute the create.',
      parameters: {
        title: { type: 'string', required: true },
      },
      output: textOutput(),
      async execute(args) {
        return runJson(() => hub.tasks().proposeCreateTask({ title: args.title }))
      },
    })),
    tools.register(defineTool({
      name: 'integration_status',
      description: 'Read-only: report availability of personal integration capabilities.',
      parameters: {},
      output: textOutput(),
      async execute() {
        return JSON.stringify({ trust: 'read', status: hub.status() })
      },
    })),
  ]
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}
