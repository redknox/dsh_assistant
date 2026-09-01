import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CapabilityPortfolioCard } from '../src/domain/capability-portfolio/index.js'
import type { WorkbenchSnapshotView } from '../src/product/web-ui-workbench-types.js'
import { projectCapabilityHistory } from '../web/src/capabilityHistory.js'

describe('Capability development history', () => {
  it('joins an installed capability to its existing conversation and delivery evidence', () => {
    const history = projectCapabilityHistory(card(), snapshot())

    assert.equal(history?.specificationId, 'spec-1')
    assert.equal(history?.originSessionId, 'conversation-1')
    assert.equal(history?.plan?.recommendation, 'Create a bounded text extension.')
    assert.deepEqual(history?.milestones, [
      'NEED RECORDED', 'IMPLEMENTATION SELECTED', 'CANDIDATE AUTHORED', 'VALIDATED', 'REVIEWED', 'APPROVED', 'ACTIVATED',
    ])
  })

  it('returns no invented history when an installed artifact is not workbench-bound', () => {
    assert.equal(projectCapabilityHistory(card(), { ...snapshot(), candidates: [] }), undefined)
  })
})

function card(): CapabilityPortfolioCard {
  return {
    id: 'extension:generated/text-echo@0.1.0', title: 'Text Echo', purpose: 'Echo text.', usage: 'Ask TARS-NG to echo text.',
    status: 'active', implementation: ['extension', 'tool'], owner: 'generated/text-echo', version: '0.1.0',
    capabilities: ['text.echo'], tools: ['text_echo'], workflows: [],
    assurance: { validation: 'passed', review: 'complete', approval: 'approved', activation: 'active', digest: 'digest-candidate' },
    dependency: { severity: 'none', dependents: [] },
  }
}

function snapshot(): WorkbenchSnapshotView {
  return {
    mutable: true,
    specifications: [{
      id: 'spec-1', revision: 1, capability: 'text.echo', goal: 'Echo text exactly.', status: 'ready', digest: 'digest-spec',
      source: 'explicit', originSessionId: 'conversation-1',
    }],
    plans: [{
      planId: 'plan-1', specificationId: 'spec-1', specificationDigest: 'digest-spec', kind: 'new-plugin', capability: 'text.echo',
      need: 'Echo text exactly.', canCreate: true, recommendation: 'Create a bounded text extension.',
    }],
    candidates: [{
      id: 'generated--text-echo@0.1.0', owner: 'generated/text-echo', version: '0.1.0', states: ['sealed', 'active'], step: 'active',
      planId: 'plan-1', specificationId: 'spec-1', leftover: false,
    }],
  }
}
