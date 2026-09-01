import type {
  CapabilityCandidateSummaryView,
  CapabilityPlanSummaryView,
  CapabilitySpecificationSummaryView,
  WorkbenchSnapshotView,
} from '../../src/product/web-ui-workbench-types'
import type { SkillProjection } from '../../src/domain/workspace/types'

export const CAPABILITY_DELIVERY_STEPS = ['DEFINE', 'RESOLVE', 'BUILD', 'VALIDATE', 'REVIEW', 'APPROVE', 'ACTIVATE', 'LIVE'] as const

export type CapabilityDeliveryStage = 'clarify' | 'resolve' | 'build' | 'validate' | 'review' | 'repair' | 'approve' | 'activate' | 'live' | 'failed'

export interface CapabilityDeliveryProgress {
  readonly id: string
  readonly stage: CapabilityDeliveryStage
  readonly completedSteps: number
  readonly stateLabel: string
  readonly nextAction: string
  readonly needsUser: boolean
  readonly historical: boolean
}

export interface CapabilityDeliveryItem extends CapabilityDeliveryProgress {
  readonly specification: CapabilitySpecificationSummaryView
  readonly plan?: CapabilityPlanSummaryView
  readonly candidate?: CapabilityCandidateSummaryView
}

export interface SkillDeliveryItem extends CapabilityDeliveryProgress {
  readonly skill: SkillProjection
}

export interface CapabilityBuildQueueView {
  readonly open: readonly CapabilityDeliveryItem[]
  readonly history: readonly CapabilityDeliveryItem[]
  readonly summary: {
    readonly open: number
    readonly needsUser: number
    readonly inProgress: number
    readonly live: number
  }
}

export interface SkillBuildQueueView {
  readonly open: readonly SkillDeliveryItem[]
  readonly history: readonly SkillDeliveryItem[]
  readonly summary: CapabilityBuildQueueView['summary']
}

export function projectCapabilityBuildQueue(snapshot: WorkbenchSnapshotView | undefined): CapabilityBuildQueueView {
  if (!snapshot) return { open: [], history: [], summary: { open: 0, needsUser: 0, inProgress: 0, live: 0 } }
  const superseded = new Set(snapshot.specifications.map((item) => item.supersedesId).filter((id): id is string => id !== undefined))
  const current = snapshot.specifications.filter((item) => !superseded.has(item.id))
  const items = current.map((specification) => deliveryItem(specification, snapshot.plans, snapshot.candidates))
  const open = items.filter((item) => !item.historical)
    .sort((left, right) => Number(right.needsUser) - Number(left.needsUser) || right.specification.revision - left.specification.revision)
  const history = [
    ...items.filter((item) => item.historical),
    ...snapshot.specifications.filter((item) => superseded.has(item.id)).map((specification) => ({
      ...deliveryItem(specification, snapshot.plans, snapshot.candidates),
      historical: true,
    })),
  ].sort((left, right) => right.specification.revision - left.specification.revision)
  return {
    open,
    history,
    summary: {
      open: open.length,
      needsUser: open.filter((item) => item.needsUser).length,
      inProgress: open.filter((item) => !item.needsUser).length,
      live: history.filter((item) => item.stage === 'live').length,
    },
  }
}

export function projectSkillBuildQueue(skills: readonly SkillProjection[] | undefined): SkillBuildQueueView {
  const items = (skills ?? []).filter((skill) => !skill.system).map((skill) => skillDeliveryItem(skill))
  const open = items.filter((item) => !item.historical)
  const history = items.filter((item) => item.historical)
  return {
    open,
    history,
    summary: {
      open: open.length,
      needsUser: open.filter((item) => item.needsUser).length,
      inProgress: open.filter((item) => !item.needsUser).length,
      live: history.filter((item) => item.skill.lifecycle === 'active').length,
    },
  }
}

function deliveryItem(
  specification: CapabilitySpecificationSummaryView,
  plans: readonly CapabilityPlanSummaryView[],
  candidates: readonly CapabilityCandidateSummaryView[],
): CapabilityDeliveryItem {
  const plan = [...plans].reverse().find((item) => item.specificationId === specification.id)
  const candidate = [...candidates].reverse().find((item) => item.specificationId === specification.id || (plan && item.planId === plan.planId))
  const state = deliveryState(specification, plan, candidate)
  return {
    id: specification.id,
    specification,
    ...(plan ? { plan } : {}),
    ...(candidate ? { candidate } : {}),
    ...state,
    historical: (specification.source === 'legacy' && candidate === undefined) || state.stage === 'live' || candidate?.states.includes('superseded') === true,
  }
}

function skillDeliveryItem(skill: SkillProjection): SkillDeliveryItem {
  const progress = skillDeliveryState(skill)
  return {
    id: `skill:${skill.id}`,
    skill,
    ...progress,
    historical: ['active', 'disabled', 'uninstalled'].includes(skill.lifecycle),
  }
}

function skillDeliveryState(skill: SkillProjection): Pick<SkillDeliveryItem, 'stage' | 'completedSteps' | 'stateLabel' | 'nextAction' | 'needsUser'> {
  if (skill.lastFailure) return { stage: 'failed', completedSteps: 3, stateLabel: 'SKILL FAILED', nextAction: `TARS-NG must repair the ${skill.lastFailure.phase} failure before delivery can continue.`, needsUser: false }
  if (skill.resolutionHandoff) return { stage: 'resolve', completedSteps: 1, stateLabel: 'NEEDS SUPPORTING TOOLS', nextAction: 'Resolve the missing Tool capabilities before this Skill can continue.', needsUser: false }
  if (skill.lifecycle === 'drafted' || skill.lifecycle === 'imported') return { stage: 'build', completedSteps: 2, stateLabel: 'PREPARING SKILL', nextAction: 'Validate the Skill instructions, resources, and invocation policy.', needsUser: false }
  if (skill.lifecycle === 'validated') return { stage: 'validate', completedSteps: 3, stateLabel: 'VALIDATED', nextAction: 'Seal the validated Skill so Independent Review can inspect exact bytes.', needsUser: false }
  if (skill.lifecycle === 'sealed') return { stage: 'review', completedSteps: 4, stateLabel: 'IN REVIEW', nextAction: 'Independent Review must complete before approval can be requested.', needsUser: false }
  if (skill.lifecycle === 'review-complete') return { stage: 'approve', completedSteps: 5, stateLabel: 'READY FOR APPROVAL', nextAction: 'TARS-NG can request approval for this exact Skill revision.', needsUser: false }
  if (skill.lifecycle === 'approval-requested') return { stage: 'approve', completedSteps: 5, stateLabel: 'WAITING FOR APPROVAL', nextAction: 'Review the Skill approval card in Today.', needsUser: true }
  if (skill.lifecycle === 'approved') return { stage: 'activate', completedSteps: 6, stateLabel: 'READY TO ACTIVATE', nextAction: 'Approval is complete. Activate this exact Skill revision from Today.', needsUser: true }
  if (skill.lifecycle === 'active') return { stage: 'live', completedSteps: 8, stateLabel: 'LIVE', nextAction: 'This Skill is online and appears in Capability Center.', needsUser: false }
  if (skill.lifecycle === 'disabled') return { stage: 'live', completedSteps: 8, stateLabel: 'DISABLED', nextAction: 'This Skill is retained in history and can be reactivated.', needsUser: false }
  return { stage: 'live', completedSteps: 8, stateLabel: 'UNINSTALLED', nextAction: 'This Skill revision remains only as governance history.', needsUser: false }
}

function deliveryState(
  specification: CapabilitySpecificationSummaryView,
  plan: CapabilityPlanSummaryView | undefined,
  candidate: CapabilityCandidateSummaryView | undefined,
): Pick<CapabilityDeliveryItem, 'stage' | 'completedSteps' | 'stateLabel' | 'nextAction' | 'needsUser'> {
  if (specification.status !== 'ready') return { stage: 'clarify', completedSteps: 0, stateLabel: 'NEEDS CLARIFICATION', nextAction: 'Answer the unresolved questions before implementation can be selected.', needsUser: true }
  if (candidate?.states.includes('active') || candidate?.step === 'active') return { stage: 'live', completedSteps: 8, stateLabel: 'LIVE', nextAction: 'This capability is online and appears in Capability Center.', needsUser: false }
  if (candidate?.states.includes('failed')) return { stage: 'failed', completedSteps: stepNumber(candidate.step), stateLabel: 'BUILD FAILED', nextAction: 'TARS-NG must repair the failed validation or activation evidence.', needsUser: false }
  if (!plan) return { stage: 'resolve', completedSteps: 1, stateLabel: 'CHOOSING IMPLEMENTATION', nextAction: 'TARS-NG needs to decide whether to reuse, configure, adopt, or develop an implementation.', needsUser: false }
  if (!candidate) return { stage: 'build', completedSteps: 2, stateLabel: plan.canCreate ? 'READY TO BUILD' : 'RESOLUTION COMPLETE', nextAction: plan.canCreate ? 'The implementation plan is ready; authoring can begin.' : 'The selected solution does not require a new governed build.', needsUser: false }
  if (candidate.step === 'author') return { stage: 'build', completedSteps: 2, stateLabel: 'BUILDING', nextAction: 'TARS-NG is authoring the governed implementation.', needsUser: false }
  if (candidate.step === 'validate') return { stage: 'validate', completedSteps: 3, stateLabel: 'VALIDATING', nextAction: 'Deterministic checks and acceptance examples must pass.', needsUser: false }
  if (candidate.step === 'repair' || candidate.states.includes('changes-required')) return { stage: 'repair', completedSteps: 4, stateLabel: 'CHANGES REQUIRED', nextAction: 'Independent Review found issues that TARS-NG must repair.', needsUser: false }
  if (candidate.step === 'review') return { stage: 'review', completedSteps: 4, stateLabel: 'IN REVIEW', nextAction: 'Independent Review is checking the sealed implementation.', needsUser: false }
  if (candidate.step === 'request') return { stage: 'approve', completedSteps: 5, stateLabel: candidate.states.includes('approval-requested') ? 'WAITING FOR APPROVAL' : 'READY FOR APPROVAL', nextAction: candidate.states.includes('approval-requested') ? 'Review the approval card in Today.' : 'TARS-NG can request exact-artifact approval.', needsUser: candidate.states.includes('approval-requested') }
  return { stage: 'activate', completedSteps: 6, stateLabel: 'READY TO ACTIVATE', nextAction: 'Approval is complete. Use the Activation card in Today to put it online.', needsUser: true }
}

function stepNumber(step: CapabilityCandidateSummaryView['step']): number {
  return ({ author: 2, validate: 3, review: 4, repair: 4, request: 5, approved: 6, active: 8 })[step]
}
