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
    payload: (args) => pick(args, ['title', 'start', 'end']),
  },
  calendar_create_event: {
    capability: 'calendar',
    operation: 'create_event',
    intent: 'execute',
    payload: (args) => pick(args, ['title', 'start', 'end']),
  },
  mail_list_messages: {
    capability: 'mail',
    operation: 'list_messages',
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
  files_delete: {
    capability: 'files',
    operation: 'delete',
    intent: 'execute',
    payload: (args) => pick(args, ['id']),
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
