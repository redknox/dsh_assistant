import type { ActionIntent, ActionRequest } from './types.js'

export interface ToolActionSpec {
  readonly capability: string
  readonly operation: string
  readonly intent: ActionIntent
  payload(args: Record<string, unknown>): Record<string, unknown>
}

function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]))
}

/** Model-facing tools that this policy owns. Unlisted tools are left to other gates. */
export const TOOL_ACTIONS: Record<string, ToolActionSpec> = {
  calendar_list_events: {
    capability: 'calendar',
    operation: 'list_events',
    intent: 'read',
    payload: (args) => pick(args, ['from', 'to', 'limit', 'cursor']),
  },
  calendar_propose_event: {
    capability: 'calendar',
    operation: 'propose_event',
    intent: 'propose',
    payload: (args) => pick(args, ['title', 'start', 'end', 'timeZone', 'calendarId', 'description', 'attendees', 'allDay']),
  },
  calendar_get_event: {
    capability: 'calendar',
    operation: 'get_event',
    intent: 'read',
    payload: (args) => pick(args, ['id']),
  },
  calendar_freebusy: {
    capability: 'calendar',
    operation: 'freebusy',
    intent: 'read',
    payload: (args) => pick(args, ['from', 'to', 'timeZone', 'limit', 'cursor']),
  },
  calendar_create_event: {
    capability: 'calendar',
    operation: 'create_event',
    intent: 'execute',
    payload: (args) => pick(args, ['title', 'start', 'end', 'timeZone', 'calendarId', 'description', 'attendees', 'allDay', 'idempotencyKey']),
  },
  mail_list_messages: {
    capability: 'mail',
    operation: 'list_messages',
    intent: 'read',
    payload: (args) => pick(args, ['query', 'limit', 'cursor']),
  },
  mail_get_message: {
    capability: 'mail',
    operation: 'get_message',
    intent: 'read',
    payload: (args) => pick(args, ['id']),
  },
  contacts_search: {
    capability: 'contacts',
    operation: 'search',
    intent: 'read',
    payload: (args) => pick(args, ['query', 'limit', 'cursor']),
  },
  tasks_propose_create: {
    capability: 'tasks',
    operation: 'propose_create',
    intent: 'propose',
    payload: (args) => pick(args, ['title']),
  },
  tasks_create: {
    capability: 'tasks',
    operation: 'create',
    intent: 'execute',
    payload: (args) => pick(args, ['title']),
  },
  files_list: {
    capability: 'files',
    operation: 'list',
    intent: 'read',
    payload: (args) => pick(args, ['path', 'limit', 'cursor']),
  },
  files_read: {
    capability: 'files',
    operation: 'read',
    intent: 'read',
    payload: (args) => pick(args, ['path']),
  },
  files_write: {
    capability: 'files',
    operation: 'write',
    intent: 'execute',
    payload: (args) => pick(args, ['path', 'content']),
  },
  files_delete: {
    capability: 'files',
    operation: 'delete',
    intent: 'execute',
    payload: (args) => pick(args, ['id']),
  },
  obsidian_propose_create_note: {
    capability: 'obsidian',
    operation: 'propose_create_note',
    intent: 'propose',
    payload: (args) => pick(args, ['path', 'content']),
  },
  obsidian_propose_append_note: {
    capability: 'obsidian',
    operation: 'propose_append_note',
    intent: 'propose',
    payload: (args) => pick(args, ['path', 'content']),
  },
  obsidian_create_note: {
    capability: 'obsidian',
    operation: 'create_note',
    intent: 'execute',
    payload: (args) => pick(args, ['path', 'content']),
  },
  obsidian_append_note: {
    capability: 'obsidian',
    operation: 'append_note',
    intent: 'execute',
    payload: (args) => pick(args, ['path', 'content', 'expectedDigest']),
  },
}

export function classifyTool(name: string): ToolActionSpec | undefined {
  return TOOL_ACTIONS[name]
}

export function requestFromTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): ActionRequest | undefined {
  const spec = classifyTool(name)
  if (!spec) return undefined
  const confirmationId = typeof args.confirmationId === 'string' ? args.confirmationId : undefined
  return {
    capability: spec.capability,
    operation: spec.operation,
    intent: spec.intent,
    payload: spec.payload(args),
    confirmationId,
    signal,
  }
}
