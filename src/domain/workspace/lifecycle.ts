export const EXTENSION_LIFECYCLE_STATES = [
  'APPROVAL_REQUIRED',
  'APPROVED_NOT_ACTIVE',
  'ACTIVATING',
  'ACTIVE',
  'ACTIVATION_FAILED',
  'DISABLED_REACTIVATABLE',
  'DISABLED_BLOCKED',
  'SUPERSEDED',
] as const
export type ExtensionLifecycleState = (typeof EXTENSION_LIFECYCLE_STATES)[number]

export const ACTIVATION_VIEW_STATES = ['inactive', 'activating', 'active', 'failed'] as const
export type ActivationViewState = (typeof ACTIVATION_VIEW_STATES)[number]

export const TERMINAL_STALE_DENIALS = [
  'digest-mismatch',
  'approval-stale',
  'review-stale',
  'base-changed',
  'review-required',
  'review-changes-required',
  'not-sealed',
  'not-validated',
  'unknown-candidate',
  'approval-rejected',
] as const

const BLOCKED_REACTIVATION_DENIALS = [
  ...TERMINAL_STALE_DENIALS,
  'recovery-required',
  'safe-mode',
  'ownership-conflict',
] as const

export function isTerminalStaleDenial(reason: string): boolean {
  return (TERMINAL_STALE_DENIALS as readonly string[]).includes(reason)
}

export function compareOwnerVersion(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta > 0) return 1
    if (delta < 0) return -1
  }
  return 0
}

export function extensionLifecycleOf(input: {
  readonly registryStatus?: string
  readonly decision?: string
  readonly activationState?: string
  readonly pendingCandidateId?: string
  readonly candidateId?: string
  readonly lastFailureCandidateId?: string
  readonly eligibilityDenials?: readonly string[]
  readonly newerAuthoritative?: boolean
}): ExtensionLifecycleState {
  if (input.registryStatus === 'active') return 'ACTIVE'
  if (input.decision === 'superseded' || input.registryStatus === 'retired' || input.newerAuthoritative === true) {
    return 'SUPERSEDED'
  }
  if (input.registryStatus === 'disabled') {
    const blocked = input.eligibilityDenials?.some((reason) => (BLOCKED_REACTIVATION_DENIALS as readonly string[]).includes(reason)) === true
    if (blocked || input.decision !== 'approved-for-exact-diff') return 'DISABLED_BLOCKED'
    return 'DISABLED_REACTIVATABLE'
  }
  if (input.decision === 'approved-for-exact-diff' && input.eligibilityDenials?.some(isTerminalStaleDenial)) {
    return 'SUPERSEDED'
  }
  const activating = input.activationState === 'activating' || input.activationState === 'activation-pending'
  if (activating && input.candidateId !== undefined && input.pendingCandidateId === input.candidateId) return 'ACTIVATING'
  if (input.candidateId !== undefined && input.activationState === 'activation-failed' && input.lastFailureCandidateId === input.candidateId) {
    return 'ACTIVATION_FAILED'
  }
  if (input.decision === 'approved-for-exact-diff') return 'APPROVED_NOT_ACTIVE'
  return 'APPROVAL_REQUIRED'
}

export function activationViewOf(lifecycle: ExtensionLifecycleState): ActivationViewState {
  if (lifecycle === 'ACTIVE') return 'active'
  if (lifecycle === 'ACTIVATING') return 'activating'
  if (lifecycle === 'ACTIVATION_FAILED') return 'failed'
  return 'inactive'
}

export function approvalStateOf(lifecycle: ExtensionLifecycleState): 'not-ready' | 'ready-for-approval' | 'approval-requested' | 'approved' | 'active' {
  if (lifecycle === 'ACTIVE') return 'active'
  if (
    lifecycle === 'APPROVED_NOT_ACTIVE'
    || lifecycle === 'ACTIVATING'
    || lifecycle === 'ACTIVATION_FAILED'
    || lifecycle === 'DISABLED_REACTIVATABLE'
    || lifecycle === 'DISABLED_BLOCKED'
  ) {
    return 'approved'
  }
  if (lifecycle === 'APPROVAL_REQUIRED') return 'not-ready'
  return 'not-ready'
}
