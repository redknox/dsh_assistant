import type { CandidateDiff, NamedDiff, OperationalEffects } from '../candidate/types.js'

export const APPROVAL_DECISIONS = [
  'unreviewed',
  'approval-requested',
  'approved-for-exact-diff',
  'rejected',
  'superseded',
] as const
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number]

export const ACTIVATION_PHASES = [
  'verify-eligibility',
  'capture-lkg',
  'prepare',
  'health',
  'commit',
] as const
export type ActivationPhase = (typeof ACTIVATION_PHASES)[number]

export const ACTIVATION_STATES = [
  'idle',
  'activation-pending',
  'activating',
  'active',
  'activation-failed',
  'rollback-pending',
  'rolled-back',
  'safe-mode',
] as const
export type ActivationState = (typeof ACTIVATION_STATES)[number]

export interface ApprovalAuthority {
  readonly kind: 'human-control'
  readonly source: 'application-ui' | 'recovery-root' | 'operator-cli'
}

export interface ApprovalFingerprintInput {
  readonly candidateId: string
  readonly owner: string
  readonly version: string
  readonly digest: string
  readonly baseVersion?: string
  readonly diff: CandidateDiff
}

export interface ApprovalRecord {
  readonly id: string
  readonly candidateId: string
  readonly fingerprint: string
  readonly decision: ApprovalDecision
  readonly authority?: ApprovalAuthority
  readonly createdAt: string
  readonly summary: ApprovalSummary
}

export interface ApprovalSummary {
  readonly owner: string
  readonly currentVersion?: string
  readonly candidateVersion: string
  readonly digest: string
  readonly capabilities: NamedDiff
  readonly permissions: NamedDiff
  readonly tools: NamedDiff
  readonly services: NamedDiff
  readonly providers: NamedDiff
  readonly runtimeSeams: NamedDiff
  readonly effects: OperationalEffects
  readonly secrets: readonly string[]
  readonly configRequired: readonly string[]
  readonly validationPassed: boolean
}

export interface EligibilityDenial {
  readonly reason: string
  readonly detail: string
}

export interface EligibilityResult {
  readonly ok: boolean
  readonly candidateId: string
  readonly fingerprint?: string
  readonly denials: readonly EligibilityDenial[]
}

export interface ActivationSnapshot {
  readonly generation: number
  readonly capturedAt: string
  readonly owners: readonly { owner: string; version: string; status: string; capabilities: readonly string[] }[]
  readonly profileIdentity: string
  readonly mounted: readonly string[]
}

export interface ActivationFailure {
  readonly candidateId: string
  readonly version: string
  readonly digest: string
  readonly phase: ActivationPhase
  readonly diagnostics: string
  readonly rollbackAttempted: boolean
  readonly rollbackSucceeded: boolean
  readonly restoredLkgGeneration?: number
  readonly safeModeRequired: boolean
}

export interface ActivationStatus {
  readonly state: ActivationState
  readonly current?: ActivationSnapshot
  readonly lastKnownGood?: ActivationSnapshot
  readonly rollbackTarget?: ActivationSnapshot
  readonly lastFailure?: ActivationFailure
  readonly safeMode: boolean
}

export interface TrustedApprovalInput {
  readonly candidateId: string
  readonly fingerprint: string
  readonly decision: 'approved-for-exact-diff' | 'rejected'
}

export interface ExtensionGovernance {
  requestApproval(candidateId: string): ApprovalRecord
  inspectApproval(candidateId: string): ApprovalRecord | undefined
  inspectSummary(candidateId: string): ApprovalSummary
  eligibility(candidateId: string): EligibilityResult
  recordUntrustedApproval(input: { approved?: boolean; authority?: string }): never
  rewriteRecoveryRoot(): never
}

export interface ExtensionActivation {
  status(): ActivationStatus
}

export interface ExtensionRecovery {
  inspect(): ActivationStatus
}

export class TrustedAuthorityCredential {
  readonly authority: ApprovalAuthority

  constructor(
    private readonly rootId: symbol,
    authority: ApprovalAuthority,
  ) {
    this.authority = authority
  }

  issuedBy(rootId: symbol): boolean {
    return this.rootId === rootId
  }
}
