import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  EXPENSE_RISK_REVIEW_CAPABILITY,
  ExpenseReviewError,
  ExpenseRiskReviewModule,
  type ExpenseReviewInput,
} from '../src/domain/expense-review/index.js'
import type { ActiveOwnerResolution, RegistryRecord } from '../src/domain/registry/index.js'
import { handleWebUiExpenseReviewRequest } from '../src/product/web-ui-expense-review.js'

const INPUT: ExpenseReviewInput = {
  claimId: ' ER-42 ',
  entity: ' Shanghai Entity ',
  employee: ' K ',
  category: ' Travel ',
  amount: 1688,
  currency: 'cny',
  receiptAttached: true,
  purpose: ' Client visit ',
}

const FINDING = {
  decision: 'review' as const,
  summary: 'Amount exceeds the entity travel threshold.',
  triggeredRules: ['Travel above CNY 1,500 requires manager review.'],
  missingEvidence: [],
  recommendation: 'Route to the cost-center manager.',
}

describe('ExpenseRiskReviewModule', () => {
  it('fails closed until one active governed capability is mounted', () => {
    const module = createModule({ kind: 'unknown', capability: EXPENSE_RISK_REVIEW_CAPABILITY }).module
    assert.deepEqual(module.inspect(), {
      status: 'unavailable',
      capability: EXPENSE_RISK_REVIEW_CAPABILITY,
      reason: 'No active expense-risk capability is installed.',
    })
  })

  it('executes the active owner tool and returns host-bounded evidence', async () => {
    const { module, calls } = createModule({ kind: 'owner', capability: EXPENSE_RISK_REVIEW_CAPABILITY, record: activeRecord() })
    const record = await module.review(INPUT)
    assert.equal(module.inspect().status, 'ready')
    assert.deepEqual(calls, [{
      name: 'expense_risk_review',
      arguments: {
        claimId: 'ER-42', entity: 'Shanghai Entity', employee: 'K', category: 'Travel', amount: 1688,
        currency: 'CNY', receiptAttached: true, purpose: 'Client visit',
      },
    }])
    assert.deepEqual(record.finding, FINDING)
    assert.deepEqual(record.capability, {
      id: EXPENSE_RISK_REVIEW_CAPABILITY,
      owner: 'generated/expense-risk',
      version: '0.1.0',
      tool: 'expense_risk_review',
    })
    assert.equal(record.reviewedAt, '2026-08-31T08:00:00.000Z')
  })

  it('rejects unrenderable capability output instead of inventing a result', async () => {
    const { module } = createModule(
      { kind: 'owner', capability: EXPENSE_RISK_REVIEW_CAPABILITY, record: activeRecord() },
      { decision: 'approved', summary: 'unsafe loose result' },
    )
    await assert.rejects(() => module.review(INPUT), (error: unknown) => (
      error instanceof ExpenseReviewError && error.code === 'invalid-result'
    ))
  })
})

describe('expense review Web UI handler', () => {
  it('projects availability and maps governed review failures', async () => {
    const unavailable = createModule({ kind: 'unknown', capability: EXPENSE_RISK_REVIEW_CAPABILITY }).module
    const inspected = await handleWebUiExpenseReviewRequest({ method: 'GET', pathname: '/api/expense-review', readJson: async () => ({}) }, unavailable)
    assert.equal(inspected?.status, 200)
    assert.equal((inspected?.body as { status: string }).status, 'unavailable')

    const failed = await handleWebUiExpenseReviewRequest({ method: 'POST', pathname: '/api/expense-review', readJson: async () => INPUT }, unavailable)
    assert.deepEqual(failed, {
      status: 409,
      body: { error: 'capability-unavailable', detail: 'No active expense-risk capability is installed.' },
    })
  })

  it('rejects malformed input before invoking the domain module', async () => {
    const ready = createModule({ kind: 'owner', capability: EXPENSE_RISK_REVIEW_CAPABILITY, record: activeRecord() }).module
    const response = await handleWebUiExpenseReviewRequest({ method: 'POST', pathname: '/api/expense-review', readJson: async () => ({ amount: -1 }) }, ready)
    assert.deepEqual(response, { status: 400, body: { error: 'invalid-input', detail: 'Malformed expense review input.' } })
  })
})

function createModule(resolution: ActiveOwnerResolution, result: unknown = FINDING) {
  const calls: { name: string; arguments: unknown }[] = []
  return {
    calls,
    module: new ExpenseRiskReviewModule(
      { resolveActiveOwner: () => resolution },
      {
        get: (name) => name === 'expense_risk_review' ? {} : undefined,
        execute: async (input) => {
          calls.push({ name: input.name, arguments: input.arguments })
          return { isError: false, value: result }
        },
      },
      () => new Date('2026-08-31T08:00:00.000Z'),
    ),
  }
}

function activeRecord(): RegistryRecord {
  return {
    owner: 'generated/expense-risk',
    version: '0.1.0',
    provenance: { kind: 'generated', origin: 'assistant' },
    status: 'active',
    evidence: 'Verified',
    approval: 'approved-for-this-diff',
    capabilities: [{ id: EXPENSE_RISK_REVIEW_CAPABILITY, permissions: [] }],
    permissions: [], runtimeSeams: [], tools: ['expense_risk_review'], services: [], providers: [], pluginDependencies: [],
  }
}
