import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { projectSessionWorkContext } from '../src/domain/workspace/work-context.js'
import { bootAssistantControl, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'

describe('Session work context', () => {
  it('projects a DSH Goal without inventing delivery state', () => {
    const context = projectSessionWorkContext({
      sessionId: 'research',
      taskControl: {
        maxAutonomousRounds: 8,
        driver: 'active',
        goal: {
          id: 'goal-1', revision: 1, objective: 'Research the market', phase: 'paused',
          roundsStarted: 2, maxGoalRounds: 8, activation: 'disarmed',
        },
        todos: [],
        plan: { active: true },
      },
    })

    assert.deepEqual(context, {
      kind: 'goal',
      sessionId: 'research',
      objective: 'Research the market',
      status: 'waiting',
      stage: 'paused',
      goalPhase: 'paused',
    })
  })

  it('keeps delivery lifecycle authoritative while surfacing a blocked Goal', () => {
    const context = projectSessionWorkContext({
      sessionId: 'delivery-1',
      delivery: {
        sessionId: 'delivery-1', capability: 'travel.records.read', objective: 'Read travel records',
        stage: 'validating', status: 'active', proposalId: 'proposal-1', candidateId: 'candidate-1',
      },
      taskControl: {
        maxAutonomousRounds: 8,
        driver: 'active',
        goal: {
          id: 'goal-1', revision: 3, objective: 'Connect the travel record source', phase: 'blocked',
          roundsStarted: 3, maxGoalRounds: 8, activation: 'disarmed', blockedReason: 'Credentials are missing.',
        },
        todos: [],
        plan: { active: false },
      },
    })

    assert.equal(context?.kind, 'capability-delivery')
    assert.equal(context?.stage, 'validating')
    assert.equal(context?.status, 'blocked')
    assert.equal(context?.objective, 'Connect the travel record source')
    assert.equal(context?.candidateId, 'candidate-1')
  })

  it('gathers persisted delivery context for the active Session', async () => {
    const control = await bootAssistantControl()
    const handle = await createAssistantAgent(control.ctx, 'delivery-context')
    try {
      const proposal = control.ctx.candidateWorkbench.proposeCapability({
        capability: 'travel.records.read',
        need: 'Read reusable travel records.',
        sessionId: 'main',
      })
      control.ctx.candidateWorkbench.decideCapabilityProposal(proposal.id, 'started', 'delivery-context')

      const view = new AssistantControlSurface(control.ctx, 'delivery-context').workspace()
      assert.deepEqual(view.workContext, {
        kind: 'capability-delivery',
        sessionId: 'delivery-context',
        objective: 'Read reusable travel records.',
        status: 'active',
        stage: 'defining',
        capability: 'travel.records.read',
        resolutionKind: proposal.review.kind,
        proposalId: proposal.id,
      })
      assert.equal(view.objective?.text, 'Read reusable travel records.')
    } finally {
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })
})
