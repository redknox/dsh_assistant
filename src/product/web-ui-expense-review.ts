import {
  ExpenseReviewError,
  type ExpenseReviewAvailability,
  type ExpenseReviewInput,
  type ExpenseReviewRecord,
} from '../domain/expense-review/index.js'

export interface WebUiExpenseReviewRequest {
  readonly method?: string
  readonly pathname: string
  readonly readJson: () => Promise<unknown>
}

export interface WebUiExpenseReviewContext {
  readonly inspect: () => ExpenseReviewAvailability
  readonly review: (input: ExpenseReviewInput) => Promise<ExpenseReviewRecord>
}

export async function handleWebUiExpenseReviewRequest(
  request: WebUiExpenseReviewRequest,
  context: WebUiExpenseReviewContext,
): Promise<{ readonly status: number; readonly body: unknown } | undefined> {
  if (request.pathname !== '/api/expense-review') return undefined
  if (request.method === 'GET') return { status: 200, body: context.inspect() }
  if (request.method !== 'POST') return { status: 405, body: { error: 'method-not-allowed' } }
  const body = await request.readJson()
  if (!isExpenseReviewInput(body)) return { status: 400, body: { error: 'invalid-input', detail: 'Malformed expense review input.' } }
  try {
    return { status: 200, body: await context.review(body) }
  } catch (error) {
    if (!(error instanceof ExpenseReviewError)) throw error
    const status = error.code === 'invalid-input'
      ? 400
      : error.code === 'capability-unavailable' ? 409 : 502
    return { status, body: { error: error.code, detail: error.message } }
  }
}

function isExpenseReviewInput(value: unknown): value is ExpenseReviewInput {
  return isRecord(value)
    && typeof value.claimId === 'string'
    && typeof value.entity === 'string'
    && typeof value.employee === 'string'
    && typeof value.category === 'string'
    && typeof value.amount === 'number'
    && typeof value.currency === 'string'
    && typeof value.receiptAttached === 'boolean'
    && (value.purpose === undefined || typeof value.purpose === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
