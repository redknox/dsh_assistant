import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import { requestFromTool, type PolicyService } from '../domain/policy/index.js'

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? args as Record<string, unknown> : {}
}

/** Execute/confirm adapters. Side effects run only after PolicyService allows them. */
export function registerPolicyTools(tools: Pick<ToolRuntime, 'register'>, policy: PolicyService, obsidianAvailable = false): () => void {
  const disposers = [
    tools.register(defineTool({
      name: 'calendar_create_event',
      description: 'Execute creating a calendar event. High-risk: returns pending confirmation unless a bound confirmation id is already approved.',
      parameters: {
        title: { type: 'string', required: true },
        start: { type: 'string', required: true },
        end: { type: 'string', required: true },
        timeZone: { type: 'string' },
        calendarId: { type: 'string' },
        description: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' } },
        allDay: { type: 'boolean' },
        idempotencyKey: { type: 'string' },
        confirmationId: { type: 'string' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const request = requestFromTool('calendar_create_event', asRecord(args), exec.signal)
        return JSON.stringify(await policy.apply(request!))
      },
    })),
    tools.register(defineTool({
      name: 'tasks_create',
      description: 'Execute creating a task. May auto-execute when the example L3 policy allows it.',
      parameters: {
        title: { type: 'string', required: true },
        confirmationId: { type: 'string' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const request = requestFromTool('tasks_create', asRecord(args), exec.signal)
        return JSON.stringify(await policy.apply(request!))
      },
    })),
    tools.register(defineTool({
      name: 'files_write',
      description: 'Execute writing a text file inside the operator sandbox. L4: always requires confirmation bound to this exact path and content. Never auto-executes.',
      parameters: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
        confirmationId: { type: 'string' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const request = requestFromTool('files_write', asRecord(args), exec.signal)
        return JSON.stringify(await policy.apply(request!))
      },
    })),
    tools.register(defineTool({
      name: 'files_delete',
      description: 'Execute deleting a file. L4: always requires confirmation bound to this exact file id. Never auto-executes.',
      parameters: {
        id: { type: 'string', required: true },
        confirmationId: { type: 'string' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const request = requestFromTool('files_delete', asRecord(args), exec.signal)
        return JSON.stringify(await policy.apply(request!))
      },
    })),
    tools.register(defineTool({
      name: 'confirm_action',
      description: 'Approve, deny, or cancel a pending confirmation. Approve executes the bound action once.',
      parameters: {
        confirmationId: { type: 'string', required: true },
        decision: { type: 'string', enum: ['approve', 'deny', 'cancel'], required: true },
      },
      output: textOutput(),
      async execute(args, exec) {
        return JSON.stringify(await policy.resolve(args.confirmationId, args.decision, exec.signal))
      },
    })),
  ]
  if (obsidianAvailable) {
    disposers.push(
      tools.register(defineTool({
        name: 'obsidian_create_note',
        description: 'Execute creating a new Obsidian Markdown note. L4: always requires confirmation bound to the exact Vault-relative path and content. Existing notes are never overwritten.',
        parameters: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
          confirmationId: { type: 'string' },
        },
        output: textOutput(),
        async execute(args, exec) {
          return JSON.stringify(await policy.apply(requestFromTool('obsidian_create_note', asRecord(args), exec.signal)!))
        },
      })),
      tools.register(defineTool({
        name: 'obsidian_append_note',
        description: 'Execute appending Markdown to an existing Obsidian note. L4: always requires confirmation bound to the exact path, content, and expected current digest.',
        parameters: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
          expectedDigest: { type: 'string', required: true },
          confirmationId: { type: 'string' },
        },
        output: textOutput(),
        async execute(args, exec) {
          return JSON.stringify(await policy.apply(requestFromTool('obsidian_append_note', asRecord(args), exec.signal)!))
        },
      })),
    )
  }
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}
