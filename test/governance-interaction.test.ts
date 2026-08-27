import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ActivationCard, RollbackCard } from '../src/domain/workspace/types.js'
import {
  deferActivation,
  deferSystemRollback,
  EMPTY_GOVERNANCE_INTERACTION,
  requestAbandonment,
  requestActivation,
  requestRecovery,
  requestSystemRollback,
} from '../web/src/governanceInteraction.js'

function activationCard(id = 'activation-1'): ActivationCard {
  return {
    id,
    kind: 'self-extension-activate',
    title: 'ACTIVATE',
    owner: 'generated/example',
    version: '0.1.0',
    candidateId: 'candidate-1',
    digest: 'digest-1',
    fingerprint: 'fingerprint-1',
    isolatedRuntime: true,
    capabilitiesAdded: [],
    capabilitiesRemoved: [],
    capabilitiesChanged: [],
    permissionsAdded: [],
    permissionsRemoved: [],
    permissionsChanged: [],
    toolsAdded: [],
    toolsRemoved: [],
    toolsChanged: [],
    effects: [],
    eligibilityOk: true,
    eligibilityDenials: [],
    status: 'APPROVED_NOT_ACTIVE',
    details: [],
  }
}

function rollbackCard(): RollbackCard {
  return {
    id: 'rollback-3-2',
    kind: 'system-state-rollback',
    title: 'Rollback system state',
    currentGeneration: 3,
    targetGeneration: 2,
    fingerprint: 'rollback-fingerprint',
    reason: 'restore LKG',
    ownerChanges: [],
    capabilitiesAdded: [],
    capabilitiesRemoved: [],
    toolsAdded: [],
    toolsRemoved: [],
    mountsAdded: [],
    mountsRemoved: [],
    recoveryRequired: false,
    actionable: true,
  }
}

describe('Governance interaction state', () => {
  it('arms activation before emitting a command', () => {
    const card = activationCard()
    const armed = requestActivation(EMPTY_GOVERNANCE_INTERACTION, card)
    assert.equal(armed.state.armedActivation, card.id)
    assert.equal(armed.command, undefined)
    assert.deepEqual(requestActivation(armed.state, card).command, { action: 'activate', card })
  })

  it('keeps activation and abandonment arming mutually exclusive', () => {
    const card = activationCard()
    const activation = requestActivation(EMPTY_GOVERNANCE_INTERACTION, card)
    const abandonment = requestAbandonment(activation.state, card)
    assert.equal(abandonment.state.armedActivation, undefined)
    assert.equal(abandonment.state.armedAbandonment, card.id)
    assert.deepEqual(requestAbandonment(abandonment.state, card).command, {
      action: 'abandon-activation',
      card,
    })
  })

  it('defers each activation once without changing its arming state', () => {
    const first = activationCard('activation-1')
    const second = activationCard('activation-2')
    const armed = requestActivation(EMPTY_GOVERNANCE_INTERACTION, first).state
    const deferred = deferActivation(deferActivation(armed, first), first)
    const both = deferActivation(deferred, second)
    assert.deepEqual(both.deferredActivations, ['activation-1', 'activation-2'])
    assert.equal(both.armedActivation, first.id)
  })

  it('supports defer or two-step execution for system rollback', () => {
    const card = rollbackCard()
    const armed = requestSystemRollback(EMPTY_GOVERNANCE_INTERACTION, card)
    assert.equal(armed.state.armedRollback, true)
    assert.deepEqual(requestSystemRollback(armed.state, card).command, { action: 'rollback-system', card })

    const deferred = deferSystemRollback(armed.state)
    assert.equal(deferred.armedRollback, false)
    assert.equal(deferred.deferredRollback, true)
  })

  it('runs diagnostics immediately but arms destructive recovery by exact action', () => {
    assert.deepEqual(requestRecovery(EMPTY_GOVERNANCE_INTERACTION, 'diagnostics').command, {
      action: 'recover',
      recovery: 'diagnostics',
    })
    const rollback = requestRecovery(EMPTY_GOVERNANCE_INTERACTION, 'rollback')
    assert.equal(rollback.state.armedRecovery, 'rollback')
    assert.equal(rollback.command, undefined)

    const switched = requestRecovery(rollback.state, 'exit-safe-mode')
    assert.equal(switched.state.armedRecovery, 'exit-safe-mode')
    assert.equal(switched.command, undefined)
    assert.deepEqual(requestRecovery(switched.state, 'exit-safe-mode').command, {
      action: 'recover',
      recovery: 'exit-safe-mode',
    })
  })
})
