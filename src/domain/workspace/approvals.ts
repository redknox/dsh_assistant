import type { ApprovalCard, ApprovalResolution, WorkspaceSnapshotInput } from './types.js'
import { allowedApprovalPayload, redactUnknown } from './redact.js'

const RESOLVED_TICKET = new Set(['denied', 'cancelled', 'consumed', 'failed'])
const HISTORY_EXTENSION = new Set(['approval-requested', 'unreviewed'])

export function projectApprovalCards(input: WorkspaceSnapshotInput): readonly ApprovalCard[] {
  const cards: ApprovalCard[] = []
  for (const ticket of input.pendingConfirmations.filter((item) => item.status === 'pending' || RESOLVED_TICKET.has(item.status))) {
    cards.push({
      ...sideEffectCard(ticket),
      ...(input.approvalOrigins?.[ticket.id] ? { sessionId: input.approvalOrigins[ticket.id] } : {}),
    })
  }
  for (const approval of input.extensionApprovals ?? []) {
    if (!HISTORY_EXTENSION.has(approval.decision)) continue
    cards.push({
      ...selfExtensionCard(approval),
      ...(input.approvalOrigins?.[approval.id] ? { sessionId: input.approvalOrigins[approval.id] } : {}),
    })
  }
  for (const approval of input.dshApprovals ?? []) cards.push(dshToolCard(approval))
  return cards
}

export function projectApprovalResolutions(input: WorkspaceSnapshotInput): readonly ApprovalResolution[] {
  const items: ApprovalResolution[] = []
  for (const ticket of input.pendingConfirmations) {
    const resolution = resolutionFromTicket(ticket)
    if (resolution) items.push(resolution)
  }
  for (const approval of input.extensionApprovals ?? []) {
    if (approval.decision === 'approved-for-exact-diff') {
      items.push({
        type: 'approval/resolved',
        confirmationId: approval.id,
        decision: 'approve',
        outcome: 'completed',
        capability: 'self-extension',
        operation: 'approve-exact-diff',
      })
    } else if (approval.decision === 'rejected') {
      items.push({
        type: 'approval/resolved',
        confirmationId: approval.id,
        decision: 'deny',
        outcome: 'denied',
        capability: 'self-extension',
        operation: 'approve-exact-diff',
      })
    }
  }
  for (const approval of input.dshApprovals ?? []) {
    if (approval.status === 'pending') continue
    items.push({
      type: 'approval/resolved',
      confirmationId: approval.id,
      decision: approval.status === 'allowed-once' ? 'approve' : approval.status === 'cancelled' ? 'cancel' : 'deny',
      outcome: approval.status === 'allowed-once'
        ? 'resumed'
        : approval.status === 'rejected' ? 'denied' : approval.status === 'cancelled' ? 'cancelled' : 'failed',
      capability: 'dsh-tool',
      operation: approval.toolName,
      occurredAt: approval.createdAt,
    })
  }
  return items
}

export function acknowledgementOf(resolution: ApprovalResolution): { readonly text: string } {
  const target = resolution.capability && resolution.operation ? `${resolution.capability}.${resolution.operation}` : 'action'
  if (resolution.outcome === 'completed') return { text: `Approved. ${target} completed.` }
  if (resolution.outcome === 'resumed') return { text: `Approved once. ${target} resumed.` }
  if (resolution.outcome === 'denied') return { text: `Rejected. ${target} was denied.` }
  if (resolution.outcome === 'cancelled') return { text: `Cancelled. ${target} was not executed.` }
  return { text: `Failed. ${target} did not complete.` }
}

function dshToolCard(approval: NonNullable<WorkspaceSnapshotInput['dshApprovals']>[number]): ApprovalCard {
  return {
    id: approval.id,
    kind: 'dsh-tool',
    title: 'AUTHORIZE TOOL EXECUTION',
    target: approval.toolName,
    sideEffect: approval.reason ?? 'allow this DSH tool call to continue once',
    authorityChange: 'none — one exact DSH tool call only',
    fingerprint: approval.fingerprint,
    status: approval.status,
    sessionId: approval.sessionId,
    details: [
      `Tool        ${approval.toolName}`,
      ...(approval.callId ? [`Call        ${approval.callId}`] : []),
      ...(approval.reason ? [`Reason      ${approval.reason}`] : []),
      ...argumentDetails(approval.arguments),
      'Approval returns allowed-once to DSH; TARS-NG does not re-run the tool.',
    ],
  }
}

function argumentDetails(value: unknown): readonly string[] {
  if (value === undefined) return []
  const safe = redactUnknown(value)
  if (safe !== null && typeof safe === 'object' && !Array.isArray(safe)) {
    return Object.entries(safe as Record<string, unknown>)
      .map(([key, nested]) => `${key.padEnd(12)}${stringify(nested)}`)
  }
  return [`Arguments   ${stringify(safe)}`]
}

function resolutionFromTicket(ticket: WorkspaceSnapshotInput['pendingConfirmations'][number]): ApprovalResolution | undefined {
  if (ticket.status === 'consumed') {
    return {
      type: 'approval/resolved',
      confirmationId: ticket.id,
      decision: 'approve',
      outcome: 'completed',
      capability: ticket.capability,
      operation: ticket.operation,
    }
  }
  if (ticket.status === 'denied') {
    return {
      type: 'approval/resolved',
      confirmationId: ticket.id,
      decision: 'deny',
      outcome: 'denied',
      capability: ticket.capability,
      operation: ticket.operation,
    }
  }
  if (ticket.status === 'cancelled') {
    return {
      type: 'approval/resolved',
      confirmationId: ticket.id,
      decision: 'cancel',
      outcome: 'cancelled',
      capability: ticket.capability,
      operation: ticket.operation,
    }
  }
  if (ticket.status === 'failed') {
    return {
      type: 'approval/resolved',
      confirmationId: ticket.id,
      decision: 'approve',
      outcome: 'failed',
      capability: ticket.capability,
      operation: ticket.operation,
    }
  }
  return undefined
}

function sideEffectCard(ticket: WorkspaceSnapshotInput['pendingConfirmations'][number]): ApprovalCard {
  const payload = allowedApprovalPayload(ticket.payload)
  if (ticket.capability === 'calendar' && ticket.operation === 'create_event') {
    return {
      id: ticket.id,
      kind: 'calendar-create',
      title: 'CREATE CALENDAR EVENT',
      target: String(payload.calendarId ?? 'Personal'),
      sideEffect: 'yes',
      authorityChange: 'none',
      fingerprint: ticket.fingerprint,
      status: ticket.status,
      details: [
        `Title       ${String(payload.title ?? '(untitled)')}`,
        `When        ${formatWhen(payload)}`,
        `Attendees   ${formatAttendees(payload.attendees)}`,
      ],
    }
  }
  if (ticket.capability === 'obsidian') {
    const content = String(payload.content ?? '')
    return {
      id: ticket.id,
      kind: 'other-side-effect',
      title: ticket.operation === 'create_note' ? 'CREATE OBSIDIAN NOTE' : 'APPEND TO OBSIDIAN NOTE',
      target: String(payload.path ?? '(unknown note)'),
      sideEffect: ticket.operation === 'create_note' ? 'create one Markdown note' : 'append to one existing Markdown note',
      authorityChange: 'none — one exact write only',
      fingerprint: ticket.fingerprint,
      status: ticket.status,
      details: [
        `Path        ${String(payload.path ?? '(unknown)')}`,
        `Content     ${content.slice(0, 4_000)}${content.length > 4_000 ? `\n… (${content.length} characters total)` : ''}`,
        ...(payload.expectedDigest ? [`Version     ${String(payload.expectedDigest)}`] : []),
      ],
    }
  }
  return {
    id: ticket.id,
    kind: 'other-side-effect',
    title: `${ticket.capability}.${ticket.operation}`.toUpperCase(),
    target: ticket.capability,
    sideEffect: 'yes',
    authorityChange: 'none',
    fingerprint: ticket.fingerprint,
    status: ticket.status,
    details: [
      ...Object.entries(payload).map(([key, value]) => `${key}: ${stringify(value)}`),
    ],
  }
}

function selfExtensionCard(approval: NonNullable<WorkspaceSnapshotInput['extensionApprovals']>[number]): ApprovalCard {
  return {
    id: approval.id,
    kind: 'self-extension',
    title: 'SELF-EXTENSION APPROVAL',
    target: `${approval.owner}@${approval.candidateVersion}`,
    sideEffect: approval.effects.join(', ') || 'capability/permission change',
    authorityChange: 'yes — human approval of exact digest/diff required',
    fingerprint: approval.fingerprint,
    status: approval.decision,
    candidateId: approval.candidateId,
    digest: approval.digest,
    details: [
      `Candidate   ${approval.candidateId}`,
      `Digest      ${approval.digest}`,
      `Capabilities +${approval.capabilitiesAdded.join(', ') || 'none'} −${approval.capabilitiesRemoved.join(', ') || 'none'}`,
      `Permissions +${approval.permissionsAdded.join(', ') || 'none'} −${approval.permissionsRemoved.join(', ') || 'none'}`,
      `Effects     ${approval.effects.join('; ') || 'none'}`,
      'This is not self-authorization. Model/tools cannot mint approval.',
    ],
  }
}

function formatWhen(payload: Record<string, unknown>): string {
  const start = String(payload.start ?? '')
  const end = String(payload.end ?? '')
  const zone = String(payload.timeZone ?? '')
  return [start, end ? `– ${end}` : '', zone].filter(Boolean).join(' ')
}

function formatAttendees(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return 'none'
  return value.map((item) => String(item)).join(', ')
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
