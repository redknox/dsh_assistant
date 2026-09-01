import type {
  CapabilityCandidateSummaryView,
  CapabilityPlanSummaryView,
  CapabilitySpecificationSummaryView,
  WorkbenchSnapshotView,
} from '../../src/product/web-ui-workbench-types'
import type { SkillProjection } from '../../src/domain/workspace/types'

export const CAPABILITY_DELIVERY_STEPS = ['DEFINE', 'RESOLVE', 'BUILD', 'VALIDATE', 'REVIEW', 'APPROVE', 'ACTIVATE', 'LIVE'] as const

export type CapabilityDeliveryStage = 'clarify' | 'resolve' | 'build' | 'validate' | 'review' | 'repair' | 'approve' | 'activate' | 'live' | 'failed' | 'blocked' | 'stopped'

export interface CapabilityDeliveryAction {
  readonly kind: 'conversation' | 'today'
  readonly label: string
  readonly prompt?: string
  readonly sessionId?: string
}

export interface CapabilityDeliveryContinuation {
  readonly currentSessionId?: string
  readonly switchSession: (id: string) => void
  readonly setDraft: (value: string) => void
  readonly openToday: () => void
}

export function continueCapabilityDelivery(
  action: CapabilityDeliveryAction | undefined,
  continuation: CapabilityDeliveryContinuation,
): void {
  if (action?.kind === 'conversation') {
    if (action.sessionId && action.sessionId !== continuation.currentSessionId) {
      continuation.switchSession(action.sessionId)
    }
    if (action.prompt) continuation.setDraft(action.prompt)
  }
  continuation.openToday()
}

export interface CapabilityDeliveryProgress {
  readonly id: string
  readonly stage: CapabilityDeliveryStage
  readonly completedSteps: number
  readonly stateLabel: string
  readonly nextAction: string
  readonly needsUser: boolean
  readonly historical: boolean
  readonly action?: CapabilityDeliveryAction
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
    historical: state.stage === 'live'
      || state.stage === 'stopped'
      || candidate?.states.includes('superseded') === true
      || (specification.source === 'legacy' && candidate === undefined && plan?.kind !== 'host-product-change-required'),
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

function skillDeliveryState(skill: SkillProjection): Pick<SkillDeliveryItem, 'stage' | 'completedSteps' | 'stateLabel' | 'nextAction' | 'needsUser' | 'action'> {
  const capability = `Skill ${skill.name}@${skill.version}`
  if (skill.lastFailure) return { stage: 'failed', completedSteps: 3, stateLabel: 'SKILL FAILED', nextAction: `TARS-NG must repair the ${skill.lastFailure.phase} failure before delivery can continue.`, needsUser: false, action: conversation('DIAGNOSE & REPAIR', capability, '请检查失败证据，修复 Skill 并重新运行相应生命周期步骤。') }
  if (skill.resolutionHandoff) return { stage: 'resolve', completedSteps: 1, stateLabel: 'NEEDS SUPPORTING TOOLS', nextAction: 'Resolve the missing Tool capabilities before this Skill can continue.', needsUser: false, action: conversation('RESOLVE TOOLS', capability, '请先解决 Skill 缺少的 Tool 能力，再继续安装流程。') }
  if (skill.lifecycle === 'drafted' || skill.lifecycle === 'imported') return { stage: 'build', completedSteps: 2, stateLabel: 'PREPARING SKILL', nextAction: 'Validate the Skill instructions, resources, and invocation policy.', needsUser: false, action: conversation('CONTINUE SKILL', capability, '请继续验证 Skill 的指令、资源和调用策略。') }
  if (skill.lifecycle === 'validated') return { stage: 'validate', completedSteps: 3, stateLabel: 'VALIDATED', nextAction: 'Seal the validated Skill so Independent Review can inspect exact bytes.', needsUser: false, action: conversation('SEAL SKILL', capability, '请密封已验证的 Skill，并进入 Independent Review。') }
  if (skill.lifecycle === 'sealed') return { stage: 'review', completedSteps: 4, stateLabel: 'IN REVIEW', nextAction: 'Independent Review must complete before approval can be requested.', needsUser: false, action: conversation('CONTINUE REVIEW', capability, '请继续完成 Skill 的 Independent Review。') }
  if (skill.lifecycle === 'review-complete') return { stage: 'approve', completedSteps: 5, stateLabel: 'READY FOR APPROVAL', nextAction: 'TARS-NG can request approval for this exact Skill revision.', needsUser: false, action: conversation('REQUEST APPROVAL', capability, '请为这个通过评审的精确 Skill 修订请求用户审批。') }
  if (skill.lifecycle === 'approval-requested') return { stage: 'approve', completedSteps: 5, stateLabel: 'WAITING FOR APPROVAL', nextAction: 'Review the Skill approval card in Today.', needsUser: true, action: { kind: 'today', label: 'OPEN APPROVAL' } }
  if (skill.lifecycle === 'approved') return { stage: 'activate', completedSteps: 6, stateLabel: 'READY TO ACTIVATE', nextAction: 'Approval is complete. Activate this exact Skill revision from Today.', needsUser: true, action: { kind: 'today', label: 'OPEN ACTIVATION' } }
  if (skill.lifecycle === 'active') return { stage: 'live', completedSteps: 8, stateLabel: 'LIVE', nextAction: 'This Skill is online and appears in Capability Center.', needsUser: false }
  if (skill.lifecycle === 'disabled') return { stage: 'live', completedSteps: 8, stateLabel: 'DISABLED', nextAction: 'This Skill is retained in history and can be reactivated.', needsUser: false }
  return { stage: 'live', completedSteps: 8, stateLabel: 'UNINSTALLED', nextAction: 'This Skill revision remains only as governance history.', needsUser: false }
}

function deliveryState(
  specification: CapabilitySpecificationSummaryView,
  plan: CapabilityPlanSummaryView | undefined,
  candidate: CapabilityCandidateSummaryView | undefined,
): Pick<CapabilityDeliveryItem, 'stage' | 'completedSteps' | 'stateLabel' | 'nextAction' | 'needsUser' | 'action'> {
  if (specification.deliveryStatus === 'stopped') {
    return {
      stage: 'stopped',
      completedSteps: candidate ? stepNumber(candidate.step) : plan ? 2 : 1,
      stateLabel: 'STOPPED',
      nextAction: 'Development was stopped by the user. The specification and governance evidence remain available in History.',
      needsUser: false,
    }
  }
  if (specification.status !== 'ready') return { stage: 'clarify', completedSteps: 0, stateLabel: 'NEEDS CLARIFICATION', nextAction: 'Answer the unresolved questions before implementation can be selected.', needsUser: true, action: conversation('ANSWER IN CHAT', specification, '请继续澄清这项能力的未决问题，并在信息足够后更新能力规格。') }
  if (candidate?.states.includes('active') || candidate?.step === 'active') return { stage: 'live', completedSteps: 8, stateLabel: 'LIVE', nextAction: 'This capability is online and appears in Capability Center.', needsUser: false }
  if (candidate && productChangeBlocked(candidate)) return { stage: 'blocked', completedSteps: 6, stateLabel: 'TARS-NG UPDATE REQUIRED', nextAction: 'This implementation cannot replace a host-owned product surface from the isolated extension runtime.', needsUser: true, action: conversation('CONTINUE AS PRODUCT UPDATE', specification, '这项能力无法通过隔离扩展上线。请基于现有候选证据，提出宿主产品代码修改方案。') }
  if (candidate?.states.includes('failed')) return { stage: 'failed', completedSteps: stepNumber(candidate.step), stateLabel: 'BUILD FAILED', nextAction: 'TARS-NG must repair the failed validation or activation evidence.', needsUser: false, action: conversation('DIAGNOSE & REPAIR', specification, '请检查失败证据，修复候选并重新运行相应验证。') }
  if (!plan) return { stage: 'resolve', completedSteps: 1, stateLabel: 'CHOOSING IMPLEMENTATION', nextAction: 'TARS-NG needs to decide whether to reuse, configure, adopt, or develop an implementation.', needsUser: false, action: conversation('CONTINUE RESOLUTION', specification, '请继续执行 Capability Resolution，选择满足需求的最小实现路径。') }
  if (!candidate && plan.kind === 'host-product-change-required') return { stage: 'blocked', completedSteps: 2, stateLabel: 'TARS-NG UPDATE REQUIRED', nextAction: 'Resolution determined that this capability must be implemented in the TARS-NG product rather than as an isolated extension.', needsUser: true, action: conversation('CONTINUE AS PRODUCT UPDATE', specification, 'Capability Resolution 已判断需要修改宿主产品。请提出代码修改方案并等待我确认。') }
  if (!candidate) return plan.canCreate
    ? { stage: 'build', completedSteps: 2, stateLabel: 'PLAN READY FOR DECISION', nextAction: 'Review the proposed implementation path. Candidate authoring starts only after you accept it in the originating conversation.', needsUser: true, action: conversation('ACCEPT PLAN IN CHAT', specification, '我已审阅并同意当前 Resolution Plan。请按照该方案开始构建候选实现。') }
    : { stage: 'live', completedSteps: 8, stateLabel: 'FULFILLED BY EXISTING CAPABILITY', nextAction: 'Resolution selected an existing implementation; no governed build is required.', needsUser: false }
  if (candidate.step === 'author') return { stage: 'build', completedSteps: 2, stateLabel: 'BUILDING', nextAction: 'TARS-NG is authoring the governed implementation.', needsUser: false, action: conversation('CONTINUE BUILD', specification, '请继续完成候选实现，并在完成后进入验证。') }
  if (candidate.step === 'validate') return { stage: 'validate', completedSteps: 3, stateLabel: 'VALIDATING', nextAction: 'Deterministic checks and acceptance examples must pass.', needsUser: false, action: conversation('CONTINUE VALIDATION', specification, '请继续运行候选验证，并根据验证证据处理失败或未决项。') }
  if (candidate.step === 'repair' || candidate.states.includes('changes-required')) return { stage: 'repair', completedSteps: 4, stateLabel: 'CHANGES REQUIRED', nextAction: 'Independent Review found issues that TARS-NG must repair.', needsUser: false, action: conversation('REPAIR CANDIDATE', specification, '请根据 Independent Review 的发现修复候选，并重新验证与评审。') }
  if (candidate.step === 'review') return { stage: 'review', completedSteps: 4, stateLabel: 'IN REVIEW', nextAction: 'Independent Review is checking the sealed implementation.', needsUser: false, action: conversation('CONTINUE REVIEW', specification, '请继续完成 Independent Review，并报告阻塞发现。') }
  if (candidate.step === 'request') return candidate.states.includes('approval-requested')
    ? { stage: 'approve', completedSteps: 5, stateLabel: 'WAITING FOR APPROVAL', nextAction: 'Review the approval card in Today.', needsUser: true, action: { kind: 'today', label: 'OPEN APPROVAL' } }
    : { stage: 'approve', completedSteps: 5, stateLabel: 'READY FOR APPROVAL', nextAction: 'TARS-NG can request exact-artifact approval.', needsUser: false, action: conversation('REQUEST APPROVAL', specification, '请为通过验证与评审的精确候选请求用户审批。') }
  return { stage: 'activate', completedSteps: 6, stateLabel: 'READY TO ACTIVATE', nextAction: 'Approval is complete. Use the Activation card in Today to put it online.', needsUser: true, action: { kind: 'today', label: 'OPEN ACTIVATION' } }
}

function productChangeBlocked(candidate: CapabilityCandidateSummaryView): boolean {
  if (candidate.governanceApproval !== 'approved-for-exact-diff' && candidate.step !== 'approved') return false
  return (candidate.eligibilityDenials ?? []).some((reason) => [
    'isolated-runtime-forbids-services-or-providers',
    'host-owned-owner-not-replaceable',
    'host-product-change-required',
  ].includes(reason))
}

function conversation(label: string, source: CapabilitySpecificationSummaryView | string, instruction: string): CapabilityDeliveryAction {
  const capability = typeof source === 'string' ? source : source.capability
  const sessionId = typeof source === 'string' ? undefined : source.originSessionId
  return {
    kind: 'conversation',
    label,
    prompt: `继续推进能力 ${capability}：${instruction}`,
    ...(sessionId ? { sessionId } : {}),
  }
}

function stepNumber(step: CapabilityCandidateSummaryView['step']): number {
  return ({ author: 2, validate: 3, review: 4, repair: 4, request: 5, approved: 6, active: 8 })[step]
}
