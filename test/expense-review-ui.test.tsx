import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'
import { ExpenseReviewWorkspace } from '../web/src/ExpenseReviewWorkspace.js'

describe('Expense Risk Review workspace', () => {
  it('renders the active capability contract and evidence without approval authority', () => {
    const markup = renderToStaticMarkup(createElement(ExpenseReviewWorkspace, {
      locked: false,
      openSpecifications() {},
      control: {
        availability: {
          status: 'ready', capability: 'finance.expense-risk.review', reason: 'Ready.',
          owner: 'generated/expense-risk', version: '0.1.0', tool: 'expense_risk_review',
        },
        draft: {
          claimId: 'ER-42', entity: 'Shanghai', employee: 'K', category: 'Travel', amount: 1688,
          currency: 'CNY', receiptAttached: true, purpose: 'Client visit',
        },
        result: {
          input: {
            claimId: 'ER-42', entity: 'Shanghai', employee: 'K', category: 'Travel', amount: 1688,
            currency: 'CNY', receiptAttached: true, purpose: 'Client visit',
          },
          finding: {
            decision: 'review', summary: 'Manager review required.',
            triggeredRules: ['Travel above CNY 1,500.'], missingEvidence: [], recommendation: 'Route to manager.',
          },
          capability: { id: 'finance.expense-risk.review', owner: 'generated/expense-risk', version: '0.1.0', tool: 'expense_risk_review' },
          reviewedAt: '2026-08-31T08:00:00.000Z',
        },
        loading: false, running: false, load() {}, change() {}, submit() {},
      },
    }))
    assert.match(markup, /EXPENSE RISK REVIEW/)
    assert.match(markup, /CAPABILITY READY/)
    assert.match(markup, /REVIEW REQUIRED/)
    assert.match(markup, /Travel above CNY 1,500/)
    assert.match(markup, /Route to manager/)
    assert.doesNotMatch(markup, />APPROVE</)
    assert.doesNotMatch(markup, />POST</)
  })

  it('guides an unavailable runtime back to specifications', () => {
    const markup = renderToStaticMarkup(createElement(ExpenseReviewWorkspace, {
      locked: false,
      openSpecifications() {},
      control: {
        availability: { status: 'unavailable', capability: 'finance.expense-risk.review', reason: 'No active capability.' },
        draft: { claimId: '', entity: '', employee: '', category: 'Travel', amount: 0, currency: 'CNY', receiptAttached: false },
        loading: false, running: false, load() {}, change() {}, submit() {},
      },
    }))
    assert.match(markup, /CAPABILITY NOT READY/)
    assert.match(markup, /OPEN SPECIFICATIONS/)
    assert.match(markup, /RUN GOVERNED REVIEW/)
    assert.match(markup, /expense-submit" disabled="">RUN GOVERNED REVIEW/)
  })
})
