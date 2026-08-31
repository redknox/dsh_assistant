import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SkillProjection } from '../src/domain/workspace/types.js'
import {
  completeSkillInteraction,
  EMPTY_SKILL_INTERACTION,
  requestSkillInteraction,
  requireSkillDependents,
} from '../web/src/skillInteraction.js'

function skill(overrides: Partial<SkillProjection> = {}): SkillProjection {
  return {
    id: 'skill-1',
    name: 'weekly-review',
    version: '1.0.0',
    profile: 'assistant',
    provenance: 'third-party',
    origin: 'import',
    lifecycle: 'active',
    sealed: true,
    modelInvocable: true,
    userInvocable: true,
    description: 'Review the week.',
    resources: [],
    validationPassed: true,
    reviewComplete: true,
    digest: 'digest-1',
    dependsOn: [],
    dependents: [],
    system: false,
    generation: 4,
    ...overrides,
  }
}

describe('Skill interaction state', () => {
  it('arms uninstall before producing a destructive command and supports cancel', () => {
    const target = skill()
    const armed = requestSkillInteraction(EMPTY_SKILL_INTERACTION, 'uninstall', target)
    assert.deepEqual(armed, { state: { confirmingSkill: 'skill-1', dependents: undefined } })

    const confirmed = requestSkillInteraction(armed.state, 'uninstall', target)
    assert.equal(confirmed.command?.action, 'uninstall')
    assert.equal(confirmed.command?.skill, target)
    assert.equal(confirmed.command?.acknowledgeDependents, false)

    const cancelled = requestSkillInteraction(armed.state, 'uninstall')
    assert.deepEqual(cancelled.state, { confirmingSkill: undefined, dependents: undefined })
    assert.equal(cancelled.command, undefined)
  })

  it('requires two clicks before disable emits a command', () => {
    const target = skill()
    const armed = requestSkillInteraction(EMPTY_SKILL_INTERACTION, 'disable', target)
    assert.equal(armed.state.armedSkill, 'disable:skill-1')
    assert.equal(armed.command, undefined)

    const confirmed = requestSkillInteraction(armed.state, 'disable', target)
    assert.equal(confirmed.state.armedSkill, undefined)
    assert.deepEqual(confirmed.command, {
      action: 'disable',
      skill: target,
      acknowledgeDependents: false,
      dependents: [],
    })
  })

  it('re-arms a denied destructive action with the exact dependent set', () => {
    const target = skill()
    const armed = requestSkillInteraction(EMPTY_SKILL_INTERACTION, 'disable', target)
    const waiting = requireSkillDependents(armed.state, 'disable', target, ['skill-2', 'skill-3'])
    assert.equal(waiting.armedSkill, 'disable:skill-1')
    assert.deepEqual(waiting.dependents, { id: 'skill-1', values: ['skill-2', 'skill-3'] })

    const accepted = requestSkillInteraction(waiting, 'disable', target)
    assert.deepEqual(accepted.command, {
      action: 'disable',
      skill: target,
      acknowledgeDependents: true,
      dependents: ['skill-2', 'skill-3'],
    })
  })

  it('uses the same two-step arming rule for approval, activation, and rollback', () => {
    const target = skill({ lifecycle: 'approval-requested' })
    const approval = requestSkillInteraction(EMPTY_SKILL_INTERACTION, 'approve', target)
    assert.equal(approval.state.armedSkill, 'approve:skill-1')
    assert.equal(approval.command, undefined)
    assert.deepEqual(requestSkillInteraction(approval.state, 'approve', target).command, {
      action: 'approve',
      skill: target,
    })

    const rollback = requestSkillInteraction(EMPTY_SKILL_INTERACTION, 'rollback')
    assert.equal(rollback.state.armedSkill, 'rollback')
    assert.deepEqual(requestSkillInteraction(rollback.state, 'rollback').command, { action: 'rollback' })
  })

  it('clears destructive confirmation only after successful completion', () => {
    const state = {
      confirmingSkill: 'skill-1',
      armedSkill: 'disable:skill-1',
      dependents: { id: 'skill-1', values: ['skill-2'] },
    }
    assert.deepEqual(completeSkillInteraction(state), {
      confirmingSkill: undefined,
      armedSkill: 'disable:skill-1',
      dependents: undefined,
    })
  })
})
