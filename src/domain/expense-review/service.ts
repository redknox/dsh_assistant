import { randomUUID } from 'node:crypto'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { CapabilityRegistry, RegistryRecord } from '../registry/index.js'
import {
  EXPENSE_REVIEW_DECISIONS,
  EXPENSE_RISK_REVIEW_CAPABILITY,
  ExpenseReviewError,
  type ExpenseReviewAvailability,
  type ExpenseReviewFinding,
  type ExpenseReviewInput,
  type ExpenseReviewRecord,
} from './types.js'

const MAX_TEXT = 500
const EXECUTION_TIMEOUT_MS = 8_000

interface ExpenseReviewToolRuntime {
  get(name: string): unknown
  execute(input: {
    readonly callId: CallId
    readonly name: string
    readonly arguments: unknown
    readonly signal: AbortSignal
  }): Promise<{ readonly isError: boolean; readonly value?: unknown; readonly content?: readonly unknown[] }>
}

/** Resolves and executes one active, governed expense-risk capability. */
export class ExpenseRiskReviewModule {
  constructor(
    private readonly registry: Pick<CapabilityRegistry, 'resolveActiveOwner'>,
    private readonly tools: ExpenseReviewToolRuntime,
    private readonly now: () => Date = () => new Date(),
  ) {}

  inspect(): ExpenseReviewAvailability {
    const resolution = this.registry.resolveActiveOwner(EXPENSE_RISK_REVIEW_CAPABILITY)
    if (resolution.kind === 'unknown') {
      return unavailable('No active expense-risk capability is installed.')
    }
    if (resolution.kind === 'inactive') {
      return unavailable('An expense-risk capability exists but is not active.')
    }
    if (resolution.kind === 'conflict') {
      return {
        status: 'conflict',
        capability: EXPENSE_RISK_REVIEW_CAPABILITY,
        reason: 'Multiple active owners claim the expense-risk capability. Resolve the registry conflict before review.',
      }
    }
    return this.availabilityFor(resolution.record)
  }

  async review(raw: ExpenseReviewInput): Promise<ExpenseReviewRecord> {
    const input = normalizeInput(raw)
    const availability = this.inspect()
    if (availability.status !== 'ready' || !availability.owner || !availability.version || !availability.tool) {
      throw new ExpenseReviewError('capability-unavailable', availability.reason)
    }
    const execution = await this.tools.execute({
      callId: CallId(`expense-review-${randomUUID()}`),
      name: availability.tool,
      arguments: input,
      signal: AbortSignal.timeout(EXECUTION_TIMEOUT_MS),
    })
    if (execution.isError) {
      throw new ExpenseReviewError('execution-failed', 'The active expense-risk capability failed to evaluate this claim.')
    }
    return {
      input,
      finding: normalizeFinding(execution.value),
      capability: {
        id: EXPENSE_RISK_REVIEW_CAPABILITY,
        owner: availability.owner,
        version: availability.version,
        tool: availability.tool,
      },
      reviewedAt: this.now().toISOString(),
    }
  }

  private availabilityFor(record: RegistryRecord): ExpenseReviewAvailability {
    if (record.tools.length !== 1) {
      return unavailable('The active expense-risk owner must expose exactly one tool.', record)
    }
    const tool = record.tools[0]!
    if (this.tools.get(tool) === undefined) {
      return unavailable('The active expense-risk tool is not mounted in this runtime.', record)
    }
    return {
      status: 'ready',
      capability: EXPENSE_RISK_REVIEW_CAPABILITY,
      reason: 'The approved expense-risk capability is active and ready.',
      owner: record.owner,
      version: record.version,
      tool,
    }
  }
}

function unavailable(reason: string, record?: RegistryRecord): ExpenseReviewAvailability {
  return {
    status: 'unavailable',
    capability: EXPENSE_RISK_REVIEW_CAPABILITY,
    reason,
    ...(record ? { owner: record.owner, version: record.version } : {}),
  }
}

function normalizeInput(value: ExpenseReviewInput): ExpenseReviewInput {
  if (!isRecord(value)) throw new ExpenseReviewError('invalid-input', 'Expense review input must be an object.')
  const currency = requiredText(value.currency, 'currency').toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new ExpenseReviewError('invalid-input', 'currency must be a three-letter code.')
  if (typeof value.amount !== 'number' || !Number.isFinite(value.amount) || value.amount <= 0) {
    throw new ExpenseReviewError('invalid-input', 'amount must be a positive finite number.')
  }
  if (typeof value.receiptAttached !== 'boolean') {
    throw new ExpenseReviewError('invalid-input', 'receiptAttached must be boolean.')
  }
  return {
    claimId: requiredText(value.claimId, 'claimId'),
    entity: requiredText(value.entity, 'entity'),
    employee: requiredText(value.employee, 'employee'),
    category: requiredText(value.category, 'category'),
    amount: value.amount,
    currency,
    receiptAttached: value.receiptAttached,
    ...(value.purpose === undefined || value.purpose.trim() === '' ? {} : { purpose: boundedText(value.purpose.trim(), 'purpose') }),
  }
}

function normalizeFinding(value: unknown): ExpenseReviewFinding {
  if (!isRecord(value) || !EXPENSE_REVIEW_DECISIONS.includes(value.decision as never)) {
    throw new ExpenseReviewError('invalid-result', 'Expense-risk result has an invalid decision.')
  }
  return {
    decision: value.decision as ExpenseReviewFinding['decision'],
    summary: requiredResultText(value.summary, 'summary'),
    triggeredRules: resultTextList(value.triggeredRules, 'triggeredRules'),
    missingEvidence: resultTextList(value.missingEvidence, 'missingEvidence'),
    recommendation: requiredResultText(value.recommendation, 'recommendation'),
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExpenseReviewError('invalid-input', `${field} is required.`)
  }
  return boundedText(value.trim(), field)
}

function boundedText(value: string, field: string): string {
  if (value.length > MAX_TEXT) throw new ExpenseReviewError('invalid-input', `${field} exceeds ${MAX_TEXT} characters.`)
  return value
}

function requiredResultText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT) {
    throw new ExpenseReviewError('invalid-result', `Expense-risk result has an invalid ${field}.`)
  }
  return value.trim()
}

function resultTextList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ExpenseReviewError('invalid-result', `Expense-risk result has an invalid ${field}.`)
  }
  return value.map((item) => requiredResultText(item, field))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
