import { projectApprovalResolutions } from './approvals.js'
import type { ActivityItem, WorkspaceSnapshotInput } from './types.js'

const TOOL_LABELS: Record<string, string> = {
  calendar_list_events: 'Calendar inspected',
  calendar_get_event: 'Calendar event read',
  calendar_freebusy: 'Free/busy calculated',
  calendar_propose_event: 'Event proposal prepared',
  calendar_create_event: 'Calendar create requested',
  retrieve_knowledge: 'Knowledge retrieved',
  recall_memory: 'Memory recalled',
  remember_memory: 'Memory write requested',
  integration_status: 'Integration status inspected',
}

export function projectActivity(input: WorkspaceSnapshotInput): readonly ActivityItem[] {
  const items: ActivityItem[] = []
  for (const event of input.toolEvents) {
    const label = TOOL_LABELS[event.name ?? ''] ?? operationalLabel(event.name ?? 'tool')
    if (event.type === 'tool/call') {
      items.push({
        id: `tool-${event.seq}`,
        kind: 'RUNNING',
        summary: label,
        source: 'session.tool',
        ...(input.runtimeContext?.sessionId ? { sessionId: input.runtimeContext.sessionId } : {}),
      })
      continue
    }
    items.push({
      id: `tool-${event.seq}`,
      kind: event.isError ? 'FAILED' : 'COMPLETED',
      summary: event.isError ? `${label} failed` : completedLabel(event.name, event.text, label),
      source: 'session.tool',
      ...(input.runtimeContext?.sessionId ? { sessionId: input.runtimeContext.sessionId } : {}),
    })
  }
  for (const ticket of input.pendingConfirmations.filter((item) => item.status === 'pending')) {
    items.push({
      id: `approval-${ticket.id}`,
      kind: 'APPROVAL_REQUIRED',
      summary: `${ticket.capability}.${ticket.operation} waiting for approval`,
      source: 'actionPolicy',
      ...(input.approvalOrigins?.[ticket.id] ? { sessionId: input.approvalOrigins[ticket.id] } : {}),
    })
  }
  for (const resolution of projectApprovalResolutions(input)) {
    const target = resolution.capability && resolution.operation
      ? `${resolution.capability}.${resolution.operation}`
      : resolution.confirmationId
    items.push({
      id: `approval-resolved-${resolution.confirmationId}`,
      kind: resolution.outcome === 'failed' ? 'FAILED' : 'COMPLETED',
      summary: `${target} ${resolution.outcome}`,
      source: 'approval/resolved',
      ...(input.approvalOrigins?.[resolution.confirmationId]
        ? { sessionId: input.approvalOrigins[resolution.confirmationId] }
        : {}),
    })
  }
  if (input.blockedReason) {
    items.push({
      id: 'blocked',
      kind: 'BLOCKED',
      summary: input.blockedReason,
      source: 'workspace',
    })
  }
  if (input.activation?.rollbackTarget && input.activation.current
    && input.activation.current.generation !== input.activation.rollbackTarget.generation
    && !input.recoveryRequired
    && !input.safeMode) {
    items.push({
      id: 'rollback-planned',
      kind: 'PLANNED',
      summary: `Rollback planned to generation ${input.activation.rollbackTarget.generation}`,
      source: 'extensionRecovery',
    })
  }
  if (input.recoveryRequired && input.recoveryWhy) {
    items.push({
      id: 'recovery',
      kind: input.safeMode ? 'BLOCKED' : 'FAILED',
      summary: input.recoveryWhy,
      source: 'extensionRecovery',
    })
  } else if (input.activation?.state === 'activation-failed' && input.activation.lastFailure) {
    items.push({
      id: 'activation-failure',
      kind: 'FAILED',
      summary: `Activation failed at ${input.activation.lastFailure.phase}: ${input.activation.lastFailure.diagnostics}`,
      source: 'extensionActivation',
    })
  }
  return items
}

function operationalLabel(name: string): string {
  return name.replaceAll('_', ' ')
}

function completedLabel(name: string | undefined, text: string, fallback: string): string {
  if (name === 'calendar_list_events') {
    const match = text.match(/(\d+)/)
    if (match) return `${match[1]} events found`
  }
  if (name === 'calendar_freebusy') return 'Free/busy calculated'
  return fallback
}
