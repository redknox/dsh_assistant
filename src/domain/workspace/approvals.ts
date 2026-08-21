import type { ApprovalCard, WorkspaceSnapshotInput } from './types.js'

export function projectApprovalCards(input: WorkspaceSnapshotInput): readonly ApprovalCard[] {
  const cards: ApprovalCard[] = []
  for (const ticket of input.pendingConfirmations.filter((item) => item.status === 'pending' || item.status === 'denied' || item.status === 'cancelled' || item.status === 'consumed')) {
    cards.push(sideEffectCard(ticket))
  }
  for (const approval of input.extensionApprovals ?? []) {
    if (approval.decision !== 'approval-requested' && approval.decision !== 'unreviewed') continue
    cards.push(selfExtensionCard(approval))
  }
  return cards
}

function sideEffectCard(ticket: WorkspaceSnapshotInput['pendingConfirmations'][number]): ApprovalCard {
  if (ticket.capability === 'calendar' && ticket.operation === 'create_event') {
    return {
      id: ticket.id,
      kind: 'calendar-create',
      title: 'CREATE CALENDAR EVENT',
      target: String(ticket.payload.calendarId ?? 'Personal'),
      sideEffect: 'yes',
      authorityChange: 'none',
      fingerprint: ticket.fingerprint,
      status: ticket.status,
      details: [
        `Title       ${String(ticket.payload.title ?? '(untitled)')}`,
        `When        ${formatWhen(ticket.payload)}`,
        `Attendees   ${formatAttendees(ticket.payload.attendees)}`,
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
    details: Object.entries(ticket.payload).map(([key, value]) => `${key}: ${stringify(value)}`),
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
    details: [
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
