import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WorkbenchSnapshotView } from '../src/product/web-ui-workbench-types.js'
import { continueCapabilityDelivery, projectCapabilityBuildQueue, projectSkillBuildQueue } from '../web/src/capabilityBuildQueue.js'

describe('Capability Build Queue projection', () => {
  it('shows only the latest explicit revision as current delivery work', () => {
    const queue = projectCapabilityBuildQueue(snapshot({
      specifications: [
        specification('spec-1', 1),
        { ...specification('spec-2', 2), supersedesId: 'spec-1' },
      ],
    }))

    assert.deepEqual(queue.open.map((item) => item.specification.id), ['spec-2'])
    assert.deepEqual(queue.history.map((item) => item.specification.id), ['spec-1'])
    assert.equal(queue.open[0]?.stateLabel, 'CHOOSING IMPLEMENTATION')
  })

  it('makes a requested approval an explicit user decision', () => {
    const queue = projectCapabilityBuildQueue(snapshot({
      specifications: [specification('spec-1', 1)],
      plans: [{ planId: 'plan-1', specificationId: 'spec-1', specificationDigest: 'digest-1', kind: 'create', capability: 'text.echo', need: 'Echo text', canCreate: true }],
      candidates: [{ id: 'candidate-1', owner: 'generated/text-echo', version: '0.1.0', states: ['sealed', 'approval-requested'], step: 'request', planId: 'plan-1', specificationId: 'spec-1', leftover: false }],
    }))

    assert.equal(queue.summary.needsUser, 1)
    assert.equal(queue.open[0]?.stage, 'approve')
    assert.equal(queue.open[0]?.stateLabel, 'WAITING FOR APPROVAL')
    assert.match(queue.open[0]?.nextAction ?? '', /Today/)
  })

  it('requires a user decision before candidate authoring begins', () => {
    const queue = projectCapabilityBuildQueue(snapshot({
      specifications: [{ ...specification('spec-plan', 1), originSessionId: 'capability-chat' }],
      plans: [{
        planId: 'plan-ready', specificationId: 'spec-plan', specificationDigest: 'digest-1', kind: 'new-plugin',
        capability: 'text.echo', need: 'Echo text', canCreate: true,
        recommendation: 'Create a small text extension.', rationale: 'No existing owner provides the behavior.',
        implications: ['Candidate governance still applies.'],
      }],
    }))

    assert.equal(queue.summary.needsUser, 1)
    assert.equal(queue.open[0]?.stateLabel, 'PLAN READY FOR DECISION')
    assert.equal(queue.open[0]?.action?.label, 'ACCEPT PLAN IN CHAT')
    assert.equal(queue.open[0]?.action?.sessionId, 'capability-chat')
    assert.match(queue.open[0]?.action?.prompt ?? '', /我已审阅并同意/)
  })

  it('moves live and legacy records out of the active queue', () => {
    const queue = projectCapabilityBuildQueue(snapshot({
      specifications: [specification('spec-live', 1), { ...specification('legacy', 1), source: 'legacy' }],
      candidates: [{ id: 'candidate-live', owner: 'generated/live', version: '0.1.0', states: ['active'], step: 'active', specificationId: 'spec-live', leftover: false }],
    }))

    assert.equal(queue.open.length, 0)
    assert.deepEqual(new Set(queue.history.map((item) => item.specification.id)), new Set(['spec-live', 'legacy']))
    assert.equal(queue.summary.live, 1)
  })

  it('includes user Skills in the same delivery language', () => {
    const projected = {
      id: 'skill-1', name: 'review-style', version: '0.1.0', profile: 'assistant', provenance: 'third-party', origin: 'import', lifecycle: 'approval-requested',
      sealed: true, modelInvocable: true, userInvocable: true, description: 'Apply the preferred review style.', resources: [], validationPassed: true,
      reviewComplete: true, approvalDecision: 'approval-requested', digest: 'skill-digest', dependsOn: [], dependents: [], system: false, generation: 1,
    } as const
    const queue = projectSkillBuildQueue([projected])

    assert.equal(queue.open.length, 1)
    assert.equal(queue.summary.needsUser, 1)
    assert.equal(queue.open[0]?.stateLabel, 'WAITING FOR APPROVAL')
    assert.equal(queue.open[0]?.stage, 'approve')

    const live = projectSkillBuildQueue([{ ...projected, lifecycle: 'active', approvalDecision: 'approved-for-exact-diff' }])
    assert.equal(live.open.length, 0)
    assert.equal(live.history[0]?.stateLabel, 'LIVE')
    assert.equal(live.summary.live, 1)
  })

  it('keeps host product changes actionable instead of calling resolution complete', () => {
    const queue = projectCapabilityBuildQueue(snapshot({
      specifications: [specification('spec-ui', 1)],
      plans: [{ planId: 'plan-ui', specificationId: 'spec-ui', specificationDigest: 'digest-1', kind: 'host-product-change-required', capability: 'ui.syntax-highlight', need: 'Highlight code.', canCreate: false }],
    }))

    assert.equal(queue.open[0]?.stage, 'blocked')
    assert.equal(queue.open[0]?.stateLabel, 'TARS-NG UPDATE REQUIRED')
    assert.equal(queue.open[0]?.action?.kind, 'conversation')
  })

  it('routes continuation back to the conversation that originated the capability', () => {
    const queue = projectCapabilityBuildQueue(snapshot({
      specifications: [{ ...specification('spec-ui', 1), originSessionId: 'conversation-product-ui' }],
      plans: [{ planId: 'plan-ui', specificationId: 'spec-ui', specificationDigest: 'digest-1', kind: 'host-product-change-required', capability: 'ui.syntax-highlight', need: 'Highlight code.', canCreate: false }],
    }))

    assert.equal(queue.open[0]?.action?.sessionId, 'conversation-product-ui')
  })

  it('switches conversations before restoring the continuation prompt', () => {
    const events: string[] = []
    continueCapabilityDelivery({
      kind: 'conversation',
      label: 'CONTINUE',
      prompt: 'Continue the product update.',
      sessionId: 'conversation-product-ui',
    }, {
      currentSessionId: 'main',
      switchSession: (id) => events.push(`switch:${id}`),
      setDraft: (value) => events.push(`draft:${value}`),
      openToday: () => events.push('today'),
    })

    assert.deepEqual(events, [
      'switch:conversation-product-ui',
      'draft:Continue the product update.',
      'today',
    ])
  })

  it('does not offer activation when host eligibility says the approved candidate cannot replace the product owner', () => {
    const queue = projectCapabilityBuildQueue(snapshot({
      specifications: [specification('spec-ui', 1)],
      plans: [{ planId: 'plan-ui', specificationId: 'spec-ui', specificationDigest: 'digest-1', kind: 'evolve-owner', capability: 'ui.markdown', need: 'Render markdown.', canCreate: true }],
      candidates: [{
        id: 'candidate-ui', owner: 'managed/ui-control-surface', version: '0.1.1', states: ['sealed'], step: 'approved', planId: 'plan-ui', specificationId: 'spec-ui', leftover: false,
        governanceApproval: 'approved-for-exact-diff', eligibilityOk: false, eligibilityDenials: ['host-owned-owner-not-replaceable', 'host-product-change-required'], activationState: 'inactive',
      }],
    }))

    assert.equal(queue.open[0]?.stage, 'blocked')
    assert.equal(queue.open[0]?.stateLabel, 'TARS-NG UPDATE REQUIRED')
    assert.equal(queue.open[0]?.action?.label, 'CONTINUE AS PRODUCT UPDATE')
  })

  it('archives a non-creating resolution that is already fulfilled by an existing capability', () => {
    const queue = projectCapabilityBuildQueue(snapshot({
      specifications: [specification('spec-adopt', 1)],
      plans: [{ planId: 'plan-adopt', specificationId: 'spec-adopt', specificationDigest: 'digest-1', kind: 'adopt-existing', capability: 'text.slugify', need: 'Slugify text.', canCreate: false }],
    }))

    assert.equal(queue.open.length, 0)
    assert.equal(queue.history[0]?.stateLabel, 'FULFILLED BY EXISTING CAPABILITY')
  })

  it('moves a stopped delivery into history without a continuation action', () => {
    const queue = projectCapabilityBuildQueue(snapshot({
      specifications: [{ ...specification('spec-stopped', 1), deliveryStatus: 'stopped' }],
      plans: [{ planId: 'plan-stopped', specificationId: 'spec-stopped', specificationDigest: 'digest-1', kind: 'host-product-change-required', capability: 'ui.syntax-highlight', need: 'Highlight code.', canCreate: false }],
    }))

    assert.equal(queue.open.length, 0)
    assert.equal(queue.history[0]?.stateLabel, 'STOPPED')
    assert.equal(queue.history[0]?.action, undefined)
  })
})

function specification(id: string, revision: number): WorkbenchSnapshotView['specifications'][number] {
  return { id, revision, capability: 'text.echo', goal: 'Echo text.', status: 'ready', digest: `digest-${revision}`, source: 'explicit' }
}

function snapshot(overrides: Partial<WorkbenchSnapshotView>): WorkbenchSnapshotView {
  return { mutable: true, specifications: [], plans: [], candidates: [], ...overrides }
}
