import type { CapabilityDeliveryContext } from '../workbench/types.js'
import type { AgentTaskControlView, SessionWorkContextView } from './types.js'

/** Combine existing authorities into one user-facing, read-only Session context. */
export function projectSessionWorkContext(input: {
  readonly sessionId: string
  readonly taskControl?: AgentTaskControlView
  readonly delivery?: CapabilityDeliveryContext
}): SessionWorkContextView | undefined {
  const goal = input.taskControl?.goal
  const delivery = input.delivery
  if (!goal && !delivery) return undefined

  if (!delivery) {
    return {
      kind: 'goal',
      sessionId: input.sessionId,
      objective: goal!.objective,
      status: goalStatus(goal!.phase),
      stage: goal!.phase === 'active' ? 'working' : goal!.phase,
      goalPhase: goal!.phase,
    }
  }

  return {
    kind: 'capability-delivery',
    sessionId: input.sessionId,
    objective: goal?.objective ?? delivery.objective,
    status: combinedStatus(delivery.status, goal?.phase),
    stage: delivery.stage,
    capability: delivery.capability,
    ...(delivery.resolutionKind ? { resolutionKind: delivery.resolutionKind } : {}),
    ...(goal ? { goalPhase: goal.phase } : {}),
    ...(delivery.proposalId ? { proposalId: delivery.proposalId } : {}),
    ...(delivery.specificationId ? { specificationId: delivery.specificationId } : {}),
    ...(delivery.planId ? { planId: delivery.planId } : {}),
    ...(delivery.candidateId ? { candidateId: delivery.candidateId } : {}),
  }
}

function combinedStatus(
  delivery: CapabilityDeliveryContext['status'],
  goal: NonNullable<AgentTaskControlView['goal']>['phase'] | undefined,
): SessionWorkContextView['status'] {
  if (goal === 'blocked' || delivery === 'blocked') return 'blocked'
  if (goal === 'paused' || delivery === 'waiting') return 'waiting'
  if (goal === 'active' && delivery !== 'complete') return 'active'
  return delivery === 'complete' ? 'done' : delivery
}

function goalStatus(phase: NonNullable<AgentTaskControlView['goal']>['phase']): SessionWorkContextView['status'] {
  if (phase === 'active') return 'active'
  if (phase === 'paused') return 'waiting'
  if (phase === 'blocked') return 'blocked'
  return 'done'
}
