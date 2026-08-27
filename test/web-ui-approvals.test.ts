import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ApprovalCard, MissionControlView } from '../src/domain/workspace/types.js'
import {
  handleWebUiApprovalRequest,
  type WebUiApprovalContext,
} from '../src/product/web-ui-approvals.js'

const view = { identity: 'TARS-NG' } as MissionControlView

function request(pathname: string, body: unknown) {
  return { method: 'POST', pathname, readJson: async () => body }
}

function sideEffectCard(overrides: Partial<ApprovalCard> = {}): ApprovalCard {
  return {
    id: 'approval-1',
    kind: 'calendar-create',
    title: 'CREATE CALENDAR EVENT',
    target: 'Personal',
    sideEffect: 'yes',
    authorityChange: 'none',
    details: [],
    fingerprint: 'fingerprint-1',
    status: 'pending',
    ...overrides,
  }
}

function context(overrides: Partial<WebUiApprovalContext> = {}): WebUiApprovalContext {
  return {
    approvals: () => [sideEffectCard()],
    resolvePolicy: async () => {},
    recordSelfExtensionApproval: () => {},
    acknowledgementFor: () => ({ text: 'Approved.' }),
    project: (acknowledgement) => ({ view, webUi: 'http://127.0.0.1:8787', ...(acknowledgement ? { acknowledgement } : {}) }),
    ...overrides,
  }
}

describe('Web UI approvals', () => {
  it('resolves ordinary approvals through the policy path', async () => {
    const calls: unknown[][] = []
    const result = await handleWebUiApprovalRequest(request('/api/approve', {
      id: 'approval-1',
      fingerprint: 'fingerprint-1',
    }), context({
      resolvePolicy: async (...args) => { calls.push(args) },
    }))
    assert.deepEqual(calls, [['approval-1', 'approve']])
    assert.equal(result?.status, 200)
    assert.equal(result?.broadcast, true)
    assert.deepEqual((result?.body as { acknowledgement?: unknown }).acknowledgement, { text: 'Approved.' })
  })

  it('binds a self-extension decision to its candidate and exact fingerprint', async () => {
    const recorded: unknown[] = []
    const card = sideEffectCard({
      kind: 'self-extension',
      candidateId: 'candidate-1',
      status: 'approval-requested',
    })
    const approved = await handleWebUiApprovalRequest(request('/api/approve', {
      id: card.id,
      candidateId: card.candidateId,
      fingerprint: card.fingerprint,
    }), context({
      approvals: () => [card],
      recordSelfExtensionApproval: (input) => { recorded.push(input) },
    }))
    assert.equal(approved?.status, 200)
    assert.deepEqual(recorded, [{
      candidateId: 'candidate-1',
      fingerprint: 'fingerprint-1',
      decision: 'approved-for-exact-diff',
    }])

    const cancelled = await handleWebUiApprovalRequest(request('/api/cancel', {
      id: card.id,
      candidateId: card.candidateId,
      fingerprint: card.fingerprint,
    }), context({ approvals: () => [card] }))
    assert.deepEqual(cancelled, {
      status: 409,
      body: { error: 'unsupported', action: 'cancel-self-extension' },
    })
  })

  it('rejects malformed, unknown, stale, and already-resolved cards', async () => {
    const malformed = await handleWebUiApprovalRequest(request('/api/approve', {}), context())
    assert.deepEqual(malformed, { status: 400, body: { error: 'malformed' } })

    const unknown = await handleWebUiApprovalRequest(request('/api/approve', {
      id: 'missing',
      fingerprint: 'fingerprint-1',
    }), context())
    assert.deepEqual(unknown, { status: 409, body: { error: 'unknown-approval' } })

    const stale = await handleWebUiApprovalRequest(request('/api/approve', {
      id: 'approval-1',
      fingerprint: 'old',
    }), context())
    assert.deepEqual(stale, { status: 409, body: { error: 'stale-fingerprint' } })

    const resolved = await handleWebUiApprovalRequest(request('/api/approve', {
      id: 'approval-1',
      fingerprint: 'fingerprint-1',
    }), context({ approvals: () => [sideEffectCard({ status: 'consumed' })] }))
    assert.deepEqual(resolved, { status: 409, body: { error: 'stale-approval' } })
  })

  it('declines requests outside the approval routes', async () => {
    assert.equal(await handleWebUiApprovalRequest(request('/api/view', {}), context()), undefined)
    assert.equal(await handleWebUiApprovalRequest({
      method: 'GET',
      pathname: '/api/approve',
      readJson: async () => ({}),
    }, context()), undefined)
  })
})
