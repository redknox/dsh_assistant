import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WorkbenchSnapshotView } from '../src/product/web-ui-workbench-types.js'
import { projectCapabilityBuildQueue, projectSkillBuildQueue } from '../web/src/capabilityBuildQueue.js'

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
    const queue = projectSkillBuildQueue([{
      id: 'skill-1', name: 'review-style', version: '0.1.0', profile: 'assistant', provenance: 'third-party', origin: 'import', lifecycle: 'approval-requested',
      sealed: true, modelInvocable: true, userInvocable: true, description: 'Apply the preferred review style.', resources: [], validationPassed: true,
      reviewComplete: true, approvalDecision: 'approval-requested', digest: 'skill-digest', dependsOn: [], dependents: [], system: false, generation: 1,
    }])

    assert.equal(queue.open.length, 1)
    assert.equal(queue.summary.needsUser, 1)
    assert.equal(queue.open[0]?.stateLabel, 'WAITING FOR APPROVAL')
    assert.equal(queue.open[0]?.stage, 'approve')
  })
})

function specification(id: string, revision: number): WorkbenchSnapshotView['specifications'][number] {
  return { id, revision, capability: 'text.echo', goal: 'Echo text.', status: 'ready', digest: `digest-${revision}`, source: 'explicit' }
}

function snapshot(overrides: Partial<WorkbenchSnapshotView>): WorkbenchSnapshotView {
  return { mutable: true, specifications: [], plans: [], candidates: [], ...overrides }
}
