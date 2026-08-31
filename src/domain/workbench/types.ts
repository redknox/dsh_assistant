import type { CandidateDiff, CandidateLifecycle, CandidateManifestInput } from '../candidate/types.js'
import type { EligibilityResult } from '../governance/types.js'
import type { ResolutionKind, ResolutionReview } from '../resolution/types.js'
import type { ReviewReport, ReviewState } from '../review/types.js'
import type { AuthoringContractV1 } from './authoring-contract.js'
import type { CapabilitySpecification, CapabilitySpecificationInput } from './capability-specification.js'
import type { ValidationDiagnosticsView } from './diagnostics.js'
import type { WorkbenchListView, WorkbenchStep } from './listing.js'

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
  readonly specificationId: string
  readonly specificationDigest: string
}

export interface WorkbenchBinding {
  readonly candidateId: string
  readonly planId: string
  readonly parentId?: string
  readonly parentDigest?: string
  readonly leftover?: boolean
  readonly runtimeContractVersion?: string
  readonly specificationId?: string
  readonly specificationDigest?: string
}

export interface WorkbenchPersistState {
  readonly nextPlan: number
  readonly nextSpecification: number
  readonly specifications: readonly CapabilitySpecification[]
  readonly plans: readonly WorkbenchPlan[]
  readonly bindings: readonly WorkbenchBinding[]
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
  readonly specification: CapabilitySpecification
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
  readonly parentDigest?: string
  readonly validation?: {
    readonly passed: boolean
    readonly lifecycle: CandidateLifecycle
    readonly failed: readonly string[]
    readonly unresolved: readonly string[]
  }
  readonly review?: {
    readonly state: ReviewState
    readonly blockingFindings: number
  }
  readonly governanceApproval?: string
  readonly activationState?: 'inactive' | 'activating' | 'active' | 'failed'
  readonly activationFailureSummary?: string
  readonly diff?: CandidateDiff
  readonly requestEligibility: EligibilityResult
  readonly step: WorkbenchStep
  readonly leftover: boolean
  readonly contractVersion?: string
  readonly specification?: CapabilitySpecification
}

export interface WorkbenchCreateInput {
  readonly planId: string
  readonly manifest?: CandidateManifestInput
  readonly owner?: string
  readonly version?: string
  readonly provenance?: { readonly kind?: string; readonly origin?: string }
}

export interface WorkbenchScaffoldInput {
  readonly candidateId: string
  readonly toolName?: string
  readonly toolDescription?: string
  readonly capability?: string
}

export interface WorkbenchListInput {
  readonly limit?: number
  readonly cursor?: string
}

export interface WorkbenchServiceOptions {
  readonly restore?: WorkbenchPersistState
  readonly persist?: (state: WorkbenchPersistState) => void
  readonly inventory?: { snapshot(): import('../resolution/types.js').ArchitectureInventory }
  readonly registry?: {
    get(owner: string, version: string): { status: string } | undefined
    list(query?: { owner?: string; status?: string }): readonly { owner: string; version: string; status: string }[]
  }
  readonly activation?: {
    inspect(): {
      state?: string
      pendingCandidateId?: string
      lastFailure?: { candidateId?: string; diagnostics?: string }
    }
  }
}

export interface CandidateWorkbench {
  defineSpecification(input: CapabilitySpecificationInput): CapabilitySpecification
  inspectSpecification(specificationId: string): CapabilitySpecification
  plan(input: { capability: string; need: string; behavior?: string } | { specificationId: string }): WorkbenchPlanView
  rememberPlan(review: ResolutionReview): WorkbenchPlanView
  getPlan(planId: string): WorkbenchPlan
  create(input: WorkbenchCreateInput): WorkbenchCandidateView
  adoptImported(candidateId: string): WorkbenchCandidateView
  inspect(candidateId: string): WorkbenchCandidateView
  inspectAuthoringContract(version?: string): AuthoringContractV1
  scaffold(input: WorkbenchScaffoldInput): WorkbenchCandidateView
  inspectValidation(candidateId: string): ValidationDiagnosticsView
  list(input?: WorkbenchListInput): WorkbenchListView
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
