import type { CapabilityPortfolioCard } from '../../src/domain/capability-portfolio/index'
import type { WorkbenchSnapshotView } from '../../src/product/web-ui-workbench-types'

export interface CapabilityDeliveryHistory {
  readonly specificationId: string
  readonly capability: string
  readonly goal: string
  readonly revision: number
  readonly originSessionId?: string
  readonly plan?: {
    readonly kind: string
    readonly recommendation?: string
  }
  readonly candidateId: string
  readonly milestones: readonly string[]
}

/** Joins existing immutable delivery facts; it never creates a parallel history record. */
export function projectCapabilityHistory(
  card: CapabilityPortfolioCard,
  snapshot: WorkbenchSnapshotView | undefined,
): CapabilityDeliveryHistory | undefined {
  if (!snapshot || !card.owner || !card.version) return undefined
  const candidate = [...snapshot.candidates].reverse().find((item) => item.owner === card.owner && item.version === card.version)
  if (!candidate) return undefined
  const plan = [...snapshot.plans].reverse().find((item) => item.planId === candidate.planId || item.specificationId === candidate.specificationId)
  const specificationId = candidate.specificationId ?? plan?.specificationId
  if (!specificationId) return undefined
  const specification = snapshot.specifications.find((item) => item.id === specificationId)
  if (!specification) return undefined
  return {
    specificationId,
    capability: specification.capability,
    goal: specification.goal,
    revision: specification.revision,
    ...(specification.originSessionId ? { originSessionId: specification.originSessionId } : {}),
    ...(plan ? { plan: { kind: plan.kind, ...(plan.recommendation ? { recommendation: plan.recommendation } : {}) } } : {}),
    candidateId: candidate.id,
    milestones: milestonesOf(candidate.states, candidate.step, plan !== undefined),
  }
}

function milestonesOf(
  states: WorkbenchSnapshotView['candidates'][number]['states'],
  step: WorkbenchSnapshotView['candidates'][number]['step'],
  planned: boolean,
): readonly string[] {
  const out = ['NEED RECORDED']
  if (planned) out.push('IMPLEMENTATION SELECTED')
  out.push('CANDIDATE AUTHORED')
  if (['review', 'repair', 'request', 'approved', 'active'].includes(step)) out.push('VALIDATED')
  if (['repair', 'request', 'approved', 'active'].includes(step)) out.push('REVIEWED')
  if (['approved', 'active'].includes(step)) out.push('APPROVED')
  if (step === 'active' || states.includes('active')) out.push('ACTIVATED')
  return out
}
