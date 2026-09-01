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
  for (const skill of input.skills ?? []) {
    if (!skill.system && skill.lifecycle === 'approval-requested' && skill.approvalFingerprint) cards.push(skillApprovalCard(skill))
  }
  for (const approval of input.dshApprovals ?? []) cards.push(dshToolCard(approval))
  return cards
}

export function hasPendingApproval(input: WorkspaceSnapshotInput): boolean {
  return projectApprovalCards(input).some((card) => ['pending', 'approval-requested', 'unreviewed'].includes(card.status))
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
  const argumentsForReview = argumentDetails(approval.arguments)
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
    decision: {
      request: `Allow ${approval.toolName} to continue`,
      reason: approval.reason ?? 'This tool call crossed a governed execution boundary and is paused for your decision.',
      outcome: 'The exact paused call will resume once. TARS-NG will not execute a second copy of it.',
      scope: 'One tool call · fingerprint bound · no standing permission',
      risk: 'tool-execution',
      facts: [
        { label: 'TOOL', value: approval.toolName },
        ...(approval.callId ? [{ label: 'CALL', value: approval.callId }] : []),
        ...argumentsForReview.map((line) => splitDetail(line)),
      ],
      approveLabel: 'ALLOW ONCE',
      rejectLabel: 'DENY',
    },
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
    const title = String(payload.title ?? '(untitled)')
    const when = formatWhen(payload)
    const attendees = formatAttendees(payload.attendees)
    return {
      id: ticket.id,
      kind: 'calendar-create',
      title: 'CREATE CALENDAR EVENT',
      target: String(payload.calendarId ?? 'Personal'),
      sideEffect: 'create one event in an external calendar',
      authorityChange: 'none',
      fingerprint: ticket.fingerprint,
      status: ticket.status,
      details: [
        `Title       ${title}`,
        `When        ${when}`,
        `Attendees   ${attendees}`,
      ],
      decision: {
        request: `Create “${title}”`,
        reason: 'Creating an event changes an external calendar, so TARS-NG needs your confirmation immediately before the write.',
        outcome: 'One calendar event will be created with the details below.',
        scope: 'One external write · no recurring permission',
        risk: 'external-change',
        facts: [
          { label: 'CALENDAR', value: String(payload.calendarId ?? 'Personal') },
          { label: 'WHEN', value: when || 'Not specified' },
          { label: 'ATTENDEES', value: attendees },
        ],
        approveLabel: 'CREATE EVENT',
        rejectLabel: 'CANCEL',
      },
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
      decision: {
        request: ticket.operation === 'create_note' ? 'Create this Obsidian note' : 'Append to this Obsidian note',
        reason: 'This changes the assistant knowledge vault and requires confirmation immediately before writing.',
        outcome: ticket.operation === 'create_note' ? 'One new Markdown note will be created.' : 'The reviewed content will be appended to the current note version.',
        scope: 'One local write · confined to the configured vault',
        risk: 'local-write',
        facts: [
          { label: 'NOTE', value: String(payload.path ?? '(unknown)') },
          { label: 'CONTENT', value: `${content.slice(0, 800)}${content.length > 800 ? `\n… (${content.length} characters total)` : ''}` },
          ...(payload.expectedDigest ? [{ label: 'CURRENT VERSION', value: String(payload.expectedDigest) }] : []),
        ],
        approveLabel: ticket.operation === 'create_note' ? 'CREATE NOTE' : 'APPEND NOTE',
        rejectLabel: 'CANCEL',
      },
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
    decision: {
      request: `Allow ${ticket.capability}.${ticket.operation}`,
      reason: 'This operation has a governed side effect and is paused for your decision.',
      outcome: 'The exact pending operation will execute once.',
      scope: 'One exact action · fingerprint bound',
      risk: 'external-change',
      facts: Object.entries(payload).map(([key, value]) => ({ label: key.toUpperCase(), value: stringify(value) })),
      approveLabel: 'ALLOW ONCE',
      rejectLabel: 'DENY',
    },
  }
}

function selfExtensionCard(approval: NonNullable<WorkspaceSnapshotInput['extensionApprovals']>[number]): ApprovalCard {
  const capabilityDiff = formatDiff(approval.capabilitiesAdded, approval.capabilitiesRemoved, approval.capabilitiesChanged)
  const permissionDiff = formatDiff(approval.permissionsAdded, approval.permissionsRemoved, approval.permissionsChanged)
  const toolDiff = formatDiff(approval.toolsAdded ?? [], approval.toolsRemoved ?? [], approval.toolsChanged)
  const workflowDiff = formatDiff(approval.workflowsAdded ?? [], approval.workflowsRemoved ?? [], approval.workflowsChanged)
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
      `Capabilities ${capabilityDiff}`,
      `Permissions ${permissionDiff}`,
      `Tools       ${toolDiff}`,
      `Workflows   ${workflowDiff}`,
      `Effects     ${approval.effects.join('; ') || 'none'}`,
      'This is not self-authorization. Model/tools cannot mint approval.',
    ],
    decision: {
      request: approvalTitle(approval),
      reason: 'This revision changes the capabilities or authority available to TARS-NG. Only you can approve the exact reviewed artifact.',
      outcome: 'The exact revision becomes eligible for a separate activation decision. Approval alone does not put it live.',
      scope: 'Exact digest and diff · no future revisions · activation remains separate',
      risk: 'capability-authority',
      facts: [
        { label: 'CAPABILITY CHANGE', value: capabilityDiff },
        ...(toolDiff !== 'none' ? [{ label: 'TOOL CHANGE', value: toolDiff }] : []),
        ...(workflowDiff !== 'none' ? [{ label: 'WORKFLOW CHANGE', value: workflowDiff }] : []),
        { label: 'PERMISSION CHANGE', value: permissionDiff },
        { label: 'SIDE EFFECTS', value: approval.effects.join('; ') || 'None declared' },
      ],
      approveLabel: 'APPROVE REVISION',
      rejectLabel: 'REJECT',
    },
  }
}

function skillApprovalCard(skill: NonNullable<WorkspaceSnapshotInput['skills']>[number]): ApprovalCard {
  return {
    id: `skill-approval:${skill.id}`,
    kind: 'skill',
    title: 'SKILL APPROVAL',
    target: `${skill.name}@${skill.version}`,
    sideEffect: 'changes the reusable instructions available to the Agent',
    authorityChange: 'yes — exact Skill revision only',
    fingerprint: skill.approvalFingerprint!,
    status: skill.lifecycle,
    digest: skill.digest,
    skill: {
      id: skill.id,
      name: skill.name,
      version: skill.version,
      digest: skill.digest,
      approvalFingerprint: skill.approvalFingerprint,
      generation: skill.generation,
    },
    details: [
      `Skill       ${skill.name}@${skill.version}`,
      `Digest      ${skill.digest}`,
      `Invocable   ${skill.modelInvocable ? 'model' : 'not model'} / ${skill.userInvocable ? 'user' : 'not user'}`,
      `Resources   ${skill.resources.join(', ') || 'none'}`,
      `Depends on  ${skill.dependsOn.join(', ') || 'none'}`,
    ],
    decision: {
      request: `Approve Skill “${friendlyName(skill.name)}”`,
      reason: 'This Skill can influence how the Agent handles matching requests. Only you can approve this exact reviewed instruction revision.',
      outcome: 'The Skill becomes eligible for a separate activation decision. Approval alone does not make it available to the Agent.',
      scope: `Exact Skill revision · ${skill.profile} Profile · activation remains separate`,
      risk: 'agent-instructions',
      facts: [
        { label: 'PURPOSE', value: skill.description || skill.whenToUse || 'Reusable Agent instructions' },
        { label: 'WHO CAN INVOKE IT', value: [skill.modelInvocable ? 'Agent' : '', skill.userInvocable ? 'User' : ''].filter(Boolean).join(' and ') || 'Neither' },
        { label: 'RESOURCES', value: skill.resources.join(', ') || 'No bundled resources' },
        { label: 'DEPENDENCIES', value: skill.dependsOn.join(', ') || 'No Skill dependencies' },
      ],
      approveLabel: 'APPROVE SKILL',
      rejectLabel: 'REJECT',
    },
  }
}

function approvalTitle(approval: NonNullable<WorkspaceSnapshotInput['extensionApprovals']>[number]): string {
  if (approval.capabilitiesAdded.length === 1 && (approval.capabilitiesChanged?.length ?? 0) === 0 && approval.capabilitiesRemoved.length === 0) {
    return `Approve capability “${friendlyName(approval.capabilitiesAdded[0]!)}”`
  }
  return `Approve capability update “${friendlyName(approval.owner.split('/').at(-1) ?? approval.owner)}”`
}

function friendlyName(value: string): string {
  return value.split(/[._-]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ')
}

function formatDiff(added: readonly string[], removed: readonly string[], changed: readonly string[] = []): string {
  const values = [
    ...added.map((item) => `+${item}`),
    ...removed.map((item) => `−${item}`),
    ...changed.map((item) => `~${item}`),
  ]
  return values.join(' · ') || 'none'
}

function splitDetail(line: string): { readonly label: string; readonly value: string } {
  const match = /^(\S+)\s+(.*)$/s.exec(line.trim())
  return match ? { label: match[1]!.toUpperCase(), value: match[2]! } : { label: 'DETAIL', value: line }
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
