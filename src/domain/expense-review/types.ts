export const EXPENSE_RISK_REVIEW_CAPABILITY = 'finance.expense-risk.review'

export const EXPENSE_REVIEW_DECISIONS = ['clear', 'review', 'missing-evidence'] as const
export type ExpenseReviewDecision = (typeof EXPENSE_REVIEW_DECISIONS)[number]

export interface ExpenseReviewInput {
  readonly claimId: string
  readonly entity: string
  readonly employee: string
  readonly category: string
  readonly amount: number
  readonly currency: string
  readonly receiptAttached: boolean
  readonly purpose?: string
}

export interface ExpenseReviewFinding {
  readonly decision: ExpenseReviewDecision
  readonly summary: string
  readonly triggeredRules: readonly string[]
  readonly missingEvidence: readonly string[]
  readonly recommendation: string
}

export interface ExpenseReviewAvailability {
  readonly status: 'ready' | 'unavailable' | 'conflict'
  readonly capability: typeof EXPENSE_RISK_REVIEW_CAPABILITY
  readonly reason: string
  readonly owner?: string
  readonly version?: string
  readonly tool?: string
}

export interface ExpenseReviewRecord {
  readonly input: ExpenseReviewInput
  readonly finding: ExpenseReviewFinding
  readonly capability: {
    readonly id: typeof EXPENSE_RISK_REVIEW_CAPABILITY
    readonly owner: string
    readonly version: string
    readonly tool: string
  }
  readonly reviewedAt: string
}

export type ExpenseReviewErrorCode = 'invalid-input' | 'capability-unavailable' | 'execution-failed' | 'invalid-result'

export class ExpenseReviewError extends Error {
  constructor(readonly code: ExpenseReviewErrorCode, message: string) {
    super(message)
    this.name = 'ExpenseReviewError'
  }
}
