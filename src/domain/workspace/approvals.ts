import type { ApprovalCard, ApprovalResolution, WorkspaceSnapshotInput } from './types.js'
import { allowedApprovalPayload } from './redact.js'

const RESOLVED_TICKET = new Set(['denied', 'cancelled', 'consumed', 'failed'])
const HISTORY_EXTENSION = new Set(['approval-requested', 'unreviewed'])

export function projectApprovalCards(input: WorkspaceSnapshotInput): readonly ApprovalCard[] {
  const cards: ApprovalCard[] = []
  for (const ticket of input.pendingConfirmations.filter((item) => item.status === 'pending' || RESOLVED_TICKET.has(item.status))) {
    cards.push(sideEffectCard(ticket))
  }
  for (const approval of input.extensionApprovals ?? []) {
    if (!HISTORY_EXTENSION.has(approval.decision)) continue
    cards.push(selfExtensionCard(approval))
  }
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
  return items
}

export function acknowledgementOf(resolution: ApprovalResolution): { readonly text: string } {
  const target = resolution.capability && resolution.operation ? `${resolution.capability}.${resolution.operation}` : 'action'
  if (resolution.outcome === 'completed') return { text: `Approved. ${target} completed.` }
  if (resolution.outcome === 'denied') return { text: `Rejected. ${target} was denied.` }
  if (resolution.outcome === 'cancelled') return { text: `Cancelled. ${target} was not executed.` }
  return { text: `Failed. ${target} did not complete.` }
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
  return {
    id: ticket.id,
    kind: 'other-side-effect',
    title: `${ticket.capability}.${ticket.operation}`.toUpperCase(),
    target: ticket.capability,
    sideEffect: 'yes',
    authorityChange: 'none',
    fingerprint: ticket.fingerprint,
    status: ticket.status,
    details: Object.entries(payload).map(([key, value]) => `${key}: ${stringify(value)}`),
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
