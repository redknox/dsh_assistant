import type { RiskModel } from '../reliability/types.js'

export const REVIEW_POLICY_VERSION = 'm4.1'

export const REVIEW_STATES = [
  'not-reviewed',
  'reviewing',
  'changes-required',
  'review-complete',
  'stale',
] as const
export type ReviewState = (typeof REVIEW_STATES)[number]

export const FINDING_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR', 'NOTE'] as const
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

export const FINDING_STATUSES = ['open', 'resolved'] as const
export type FindingStatus = (typeof FINDING_STATUSES)[number]

export const FINDING_CATEGORIES = [
  'acceptance-contract',
  'architecture-ownership',
  'public-seam',
  'trust-boundary',
  'permission-effect',
  'risk-class',
  'risk-model',
  'provider-contract',
  'retry-idempotency',
  'failure-mode',
  'secret-authority',
  'unsafe-fallback',
  'rollback-recovery',
  'unverified-claim',
  'protected-invariant',
  'self-certification',
  'lineage',
  'deterministic-gate',
] as const
export type FindingCategory = (typeof FINDING_CATEGORIES)[number]

export const REVIEW_PACKAGE_KEYS = [
  'policyVersion',
  'candidate',
  'resolutionKind',
  'resolutionCapability',
  'riskClass',
  'riskModel',
  'reliabilityPassed',
  'reliabilityDerivedClass',
  'validationPassed',
  'validationStages',
  'permissionDiff',
  'effectDiff',
  'contractKind',
  'idempotencyStrategy',
  'cancelledContextReuse',
  'independentReconciliation',
  'generated',
  'priorFindings',
  'builderClaims',
] as const

export interface ReviewFinding {
  readonly id: string
  readonly reviewedDigest: string
  readonly severity: FindingSeverity
  readonly category: FindingCategory
  readonly claim: string
  readonly location: string
  readonly evidence: string
  readonly whyItMatters: string
  readonly requiredRemediation: string
  readonly blocking: boolean
  readonly status: FindingStatus
}

export interface ReviewCandidateRef {
  readonly id: string
  readonly owner: string
  readonly version: string
  readonly digest: string
  readonly sealed: boolean
  readonly parentRevision?: string
}

export interface ReviewPackage {
  readonly policyVersion: string
  readonly candidate: ReviewCandidateRef
  readonly resolutionKind?: string
  readonly resolutionCapability?: string
  readonly riskClass: string
  readonly riskModel?: RiskModel
  readonly reliabilityPassed?: boolean
  readonly reliabilityDerivedClass?: string
  readonly validationPassed: boolean
  readonly validationStages: readonly { readonly name: string; readonly status: string }[]
  readonly permissionDiff?: { readonly added: readonly string[] }
  readonly effectDiff?: unknown
  readonly contractKind?: string
  readonly idempotencyStrategy?: string
  readonly cancelledContextReuse?: boolean
  readonly independentReconciliation?: boolean
  readonly generated: boolean
  readonly priorFindings: readonly ReviewFinding[]
  /** Builder claims to inspect, never authority. */
  readonly builderClaims?: Readonly<Record<string, unknown>>
}

export interface ReviewPolicy {
  readonly version: string
  readonly riskClass: string
}

export interface ReviewerProvider {
  semanticReview(pkg: ReviewPackage, policy: ReviewPolicy): readonly ReviewFinding[]
}

export interface ReviewReport {
  readonly candidateId: string
  readonly digest: string
  readonly policyVersion: string
  readonly riskClass: string
  readonly state: Exclude<ReviewState, 'not-reviewed' | 'reviewing' | 'stale'>
  readonly findings: readonly ReviewFinding[]
  readonly approvalStatus: 'NOT APPROVED'
  readonly summary: string
}

export interface IndependentReview {
  review(pkg: ReviewPackage): ReviewReport
  reviewCandidate(id: string, extras?: ReviewPackageExtras): ReviewReport
  status(candidate: { readonly id: string; readonly digest?: string }): ReviewState
  lastReport(candidateId: string): ReviewReport | undefined
}

export type ReviewPackageExtras = Omit<Partial<ReviewPackage>, 'candidate'> & {
  readonly parentRevision?: string
}
