import type { CandidateLifecycle, CandidateRecord } from '../candidate/types.js'
import type { ApprovalDecision } from '../governance/types.js'
import type { ReviewState } from '../review/types.js'

export const WORKBENCH_LIST_DEFAULT = 20
export const WORKBENCH_LIST_MAX = 50

export const WORKBENCH_CANDIDATE_STATES = [
  'mutable',
  'sealed',
  'review-required',
  'changes-required',
  'approval-requested',
  'active',
  'failed',
  'superseded',
] as const
export type WorkbenchCandidateState = (typeof WORKBENCH_CANDIDATE_STATES)[number]

export type WorkbenchStep =
  | 'author'
  | 'validate'
  | 'review'
  | 'repair'
  | 'request'
  | 'approved'
  | 'active'

export interface WorkbenchListPlanItem {
  readonly planId: string
  readonly kind: string
  readonly capability: string
  readonly need: string
  readonly canCreate: boolean
}

export interface WorkbenchListCandidateItem {
  readonly id: string
  readonly owner: string
  readonly version: string
  readonly states: readonly WorkbenchCandidateState[]
  readonly step: WorkbenchStep
  readonly planId?: string
  readonly parentId?: string
  readonly leftover: boolean
}

export interface WorkbenchListView {
  readonly plans: readonly WorkbenchListPlanItem[]
  readonly candidates: readonly WorkbenchListCandidateItem[]
  readonly nextCursor?: string
}

export function boundListLimit(limit?: number): number {
  if (limit === undefined) return WORKBENCH_LIST_DEFAULT
  if (!Number.isInteger(limit) || limit < 1) return WORKBENCH_LIST_DEFAULT
  return Math.min(limit, WORKBENCH_LIST_MAX)
}

export function parseListCursor(cursor?: string): number {
  if (cursor === undefined || cursor === '') return 0
  const offset = Number(cursor)
  if (!Number.isInteger(offset) || offset < 0) return 0
  return offset
}

export function candidateStates(input: {
  readonly lifecycle: CandidateLifecycle
  readonly sealed: boolean
  readonly reviewState?: ReviewState
  readonly approval?: ApprovalDecision
  readonly registryStatus?: string
}): WorkbenchCandidateState[] {
  const states: WorkbenchCandidateState[] = []
  if (!input.sealed) states.push('mutable')
  if (input.sealed) states.push('sealed')
  if (input.lifecycle === 'validation-failed') states.push('failed')
  if (input.sealed && (input.reviewState === undefined || input.reviewState === 'not-reviewed')) {
    states.push('review-required')
  }
  if (input.reviewState === 'changes-required') states.push('changes-required')
  if (input.approval === 'approval-requested') states.push('approval-requested')
  if (input.approval === 'superseded' || input.registryStatus === 'retired') states.push('superseded')
  if (input.registryStatus === 'active') states.push('active')
  return states
}

export function candidateStep(input: {
  readonly lifecycle: CandidateLifecycle
  readonly sealed: boolean
  readonly reviewState?: ReviewState
  readonly canRequest: boolean
  readonly approval?: ApprovalDecision
  readonly registryStatus?: string
}): WorkbenchStep {
  if (input.registryStatus === 'active') return 'active'
  if (input.approval === 'approved-for-exact-diff') return 'approved'
  if (input.canRequest || input.approval === 'approval-requested') return 'request'
  if (input.reviewState === 'changes-required') return 'repair'
  if (input.sealed && input.reviewState !== 'review-complete') return 'review'
  if (input.lifecycle === 'validation-failed' || input.lifecycle === 'validation-incomplete') return 'validate'
  if (!input.sealed) return 'author'
  return 'review'
}

export function isLeftoverRepair(record: CandidateRecord, parentId?: string, files: readonly string[] = []): boolean {
  if (!parentId) return false
  if (record.lifecycle === 'planned') return true
  return !files.some((file) => file === 'src/plugin.js' || file === 'src/plugin.ts')
}
