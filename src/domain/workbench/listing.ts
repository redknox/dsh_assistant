import type { CandidateLifecycle } from '../candidate/types.js'
import type { ApprovalDecision } from '../governance/types.js'
import type { ReviewState } from '../review/types.js'
import { WorkbenchContractError } from './errors.js'

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
  readonly specificationId: string
  readonly specificationDigest: string
  readonly kind: string
  readonly capability: string
  readonly need: string
  readonly canCreate: boolean
}

export interface WorkbenchListSpecificationItem {
  readonly id: string
  readonly revision: number
  readonly supersedesId?: string
  readonly capability: string
  readonly goal: string
  readonly status: string
  readonly digest: string
}

export interface WorkbenchListCandidateItem {
  readonly id: string
  readonly owner: string
  readonly version: string
  readonly states: readonly WorkbenchCandidateState[]
  readonly step: WorkbenchStep
  readonly planId?: string
  readonly specificationId?: string
  readonly parentId?: string
  readonly leftover: boolean
}

export interface WorkbenchListView {
  readonly specifications: readonly WorkbenchListSpecificationItem[]
  readonly plans: readonly WorkbenchListPlanItem[]
  readonly candidates: readonly WorkbenchListCandidateItem[]
  readonly nextCursor?: string
}

export interface WorkbenchListCursor {
  readonly specifications: number
  readonly plans: number
  readonly candidates: number
}

export function boundListLimit(limit?: number): number {
  if (limit === undefined) return WORKBENCH_LIST_DEFAULT
  if (!Number.isInteger(limit) || limit < 1) {
    throw new WorkbenchContractError('list limit must be a positive integer')
  }
  return Math.min(limit, WORKBENCH_LIST_MAX)
}

export function parseListCursor(cursor?: string): WorkbenchListCursor {
  if (cursor === undefined || cursor === '') return { specifications: 0, plans: 0, candidates: 0 }
  try {
    const parsed = JSON.parse(cursor) as { specifications?: unknown; plans?: unknown; candidates?: unknown }
    const specifications = parsed.specifications ?? 0
    const plans = parsed.plans
    const candidates = parsed.candidates
    if (!Number.isInteger(specifications) || !Number.isInteger(plans) || !Number.isInteger(candidates)
      || Number(specifications) < 0 || Number(plans) < 0 || Number(candidates) < 0) {
      throw new Error('invalid')
    }
    return { specifications: Number(specifications), plans: Number(plans), candidates: Number(candidates) }
  } catch {
    throw new WorkbenchContractError('list cursor is invalid')
  }
}

export function encodeListCursor(cursor: WorkbenchListCursor): string {
  return JSON.stringify(cursor)
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
  if (input.approval === 'superseded' || input.registryStatus === 'retired' || input.registryStatus === 'disabled') {
    states.push('superseded')
  }
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
