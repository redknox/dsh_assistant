import type { CandidateDiff, CandidateLifecycle, CandidateManifestInput } from '../candidate/types.js'
import type { EligibilityResult } from '../governance/types.js'
import type { ResolutionKind, ResolutionReview } from '../resolution/types.js'
import type { ReviewReport, ReviewState } from '../review/types.js'

export const WORKBENCH_CHANGE_KINDS = [
  'configure',
  'evolve-owner',
  'adopt-existing',
  'implement-provider',
  'new-plugin',
] as const
export type WorkbenchChangeKind = (typeof WORKBENCH_CHANGE_KINDS)[number]

export const WORKBENCH_MAX_FILE_BYTES = 256 * 1024
export const WORKBENCH_MAX_WORKSPACE_BYTES = 2 * 1024 * 1024
export const WORKBENCH_MAX_FILE_COUNT = 80
export const WORKBENCH_MAX_TRAVERSAL_ENTRIES = 200
export const WORKBENCH_MAX_LIST_DEPTH = 8

export interface WorkbenchPlan {
  readonly id: string
  readonly review: ResolutionReview
}

export interface WorkbenchPlanView {
  readonly planId: string
  readonly kind: ResolutionKind
  readonly capability: string
  readonly need: string
  readonly recommendation: string
  readonly rationale: string
  readonly target?: ResolutionReview['target']
  readonly canCreate: boolean
  readonly unresolved: readonly string[]
}

export interface WorkbenchCandidateView {
  readonly id: string
  readonly owner: string
  readonly version: string
  readonly baseVersion?: string
  readonly provenance: { readonly kind: string; readonly origin: string }
  readonly lifecycle: CandidateLifecycle
  readonly sealed: boolean
  readonly digest?: string
  readonly resolutionKind: ResolutionKind
  readonly resolutionCapability: string
  readonly planId?: string
  readonly parentId?: string
  readonly validation?: {
    readonly passed: boolean
    readonly lifecycle: CandidateLifecycle
    readonly failed: readonly string[]
    readonly unresolved: readonly string[]
  }
  readonly review?: {
    readonly state: ReviewState
    readonly blockingFindings: number
    readonly approvalStatus: 'NOT APPROVED'
  }
  readonly diff?: CandidateDiff
  readonly requestEligibility: EligibilityResult
}

export interface WorkbenchCreateInput {
  readonly planId: string
  readonly manifest?: CandidateManifestInput
  readonly owner?: string
  readonly version?: string
  readonly provenance?: { readonly kind?: string; readonly origin?: string }
}

export interface CandidateWorkbench {
  plan(input: { capability: string; need: string; behavior?: string }): WorkbenchPlanView
  rememberPlan(review: ResolutionReview): WorkbenchPlanView
  getPlan(planId: string): WorkbenchPlan
  create(input: WorkbenchCreateInput): WorkbenchCandidateView
  inspect(candidateId: string): WorkbenchCandidateView
  listFiles(candidateId: string): readonly string[]
  readFile(candidateId: string, relativePath: string): string
  writeFile(candidateId: string, relativePath: string, content: string): WorkbenchCandidateView
  setManifest(candidateId: string, manifest: CandidateManifestInput): WorkbenchCandidateView
  validate(candidateId: string): WorkbenchCandidateView
  seal(candidateId: string): WorkbenchCandidateView
  review(candidateId: string): ReviewReport
  inspectReview(candidateId: string): { readonly state: ReviewState; readonly report?: ReviewReport }
  repair(candidateId: string): WorkbenchCandidateView
  requestApproval(candidateId: string): ReturnType<import('../governance/types.js').ExtensionGovernance['requestApproval']>
}
