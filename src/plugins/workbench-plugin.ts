import { Service, type Context } from '@deepseek-ai/cordis'
import { CORE_KNOWN_SEAMS, type ArchitectureInventory } from '../domain/resolution/index.js'
import { WorkbenchService, type CandidateWorkbench, type WorkbenchServiceOptions } from '../domain/workbench/index.js'
import { registerWorkbenchTools } from './workbench-tools.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    candidateWorkbench: CandidateWorkbench
  }
}

export class CandidateWorkbenchService extends Service implements CandidateWorkbench {
  constructor(ctx: Context, private readonly store: CandidateWorkbench) {
    super(ctx, 'candidateWorkbench')
  }

  defineSpecification(input: Parameters<CandidateWorkbench['defineSpecification']>[0]) { return this.store.defineSpecification(input) }
  reviseSpecification(specificationId: string, patch: Parameters<CandidateWorkbench['reviseSpecification']>[1]) {
    return this.store.reviseSpecification(specificationId, patch)
  }
  compareSpecifications(fromSpecificationId: string, toSpecificationId: string) {
    return this.store.compareSpecifications(fromSpecificationId, toSpecificationId)
  }
  inspectSpecification(specificationId: string) { return this.store.inspectSpecification(specificationId) }
  plan(input: Parameters<CandidateWorkbench['plan']>[0]) { return this.store.plan(input) }
  rememberPlan(review: Parameters<CandidateWorkbench['rememberPlan']>[0]) { return this.store.rememberPlan(review) }
  getPlan(planId: string) { return this.store.getPlan(planId) }
  create(input: Parameters<CandidateWorkbench['create']>[0]) { return this.store.create(input) }
  adoptImported(candidateId: string) { return this.store.adoptImported(candidateId) }
  inspect(candidateId: string) { return this.store.inspect(candidateId) }
  inspectAuthoringContract(version?: string) { return this.store.inspectAuthoringContract(version) }
  scaffold(input: Parameters<CandidateWorkbench['scaffold']>[0]) { return this.store.scaffold(input) }
  inspectValidation(candidateId: string) { return this.store.inspectValidation(candidateId) }
  list(input?: Parameters<CandidateWorkbench['list']>[0]) { return this.store.list(input) }
  listFiles(candidateId: string) { return this.store.listFiles(candidateId) }
  readFile(candidateId: string, relativePath: string) { return this.store.readFile(candidateId, relativePath) }
  writeFile(candidateId: string, relativePath: string, content: string) {
    return this.store.writeFile(candidateId, relativePath, content)
  }
  setManifest(candidateId: string, manifest: Parameters<CandidateWorkbench['setManifest']>[1]) {
    return this.store.setManifest(candidateId, manifest)
  }
  validate(candidateId: string) { return this.store.validate(candidateId) }
  seal(candidateId: string) { return this.store.seal(candidateId) }
  review(candidateId: string) { return this.store.review(candidateId) }
  inspectReview(candidateId: string) { return this.store.inspectReview(candidateId) }
  repair(candidateId: string) { return this.store.repair(candidateId) }
  requestApproval(candidateId: string) { return this.store.requestApproval(candidateId) }
}

export interface WorkbenchPluginConfig extends WorkbenchServiceOptions {
  readonly inspectOnly?: boolean
}

export const WORKBENCH_CONVERSATION_GUIDANCE = [
  'When the user asks to add a missing capability: define_capability_specification first, clarify unresolved questions with immutable revisions, compare revisions when useful, then resolve first with plan_capability_change and the chosen specificationId.',
  'Prefer reuse, configure, or evolve an existing owner before new-plugin.',
  'Use Candidate Workbench tools. Read inspect_authoring_contract before scaffolding.',
  'Use scaffold_candidate, then bounded edits, then inspect_validation_diagnostics.',
  'Repair only by creating a new revision; never mutate a sealed parent.',
  'Request approval only after Independent Review is review-complete for the current digest.',
  'Tell the user Independent Review review-complete is not a governance approval.',
  'After exact-diff approval, point the user at the Mission-Control Activation Card. Conversation yes cannot activate.',
  'Never say you cannot create plugins when Workbench tools exist.',
  'Never treat "build this" as approve or activate. Writing code is not authorization.',
  'Generated code runs only after a human approves and activates, inside the isolated runner.',
].join(' ')

export const name = 'dsh-assistant-workbench'
export const inject = [
  'capabilityResolution',
  'capabilityRegistry',
  'candidateWorkspace',
  'candidateValidation',
  'independentReview',
  'extensionGovernance',
  'systemPrompt',
  'tools',
]

/** Host-owned Candidate Workbench. Development authority only; never approval or activation. */
export async function apply(ctx: Context, config: WorkbenchPluginConfig = {}) {
  const workbench = new WorkbenchService(
    ctx.capabilityResolution,
    ctx.candidateWorkspace,
    ctx.candidateValidation,
    ctx.independentReview,
    ctx.extensionGovernance,
    {
      restore: config.restore,
      persist: config.persist,
      inventory: config.inventory ?? { snapshot: () => hostOwnedArchitectureInventory(ctx.capabilityRegistry) },
      registry: ctx.capabilityRegistry,
      activation: ctx.get('extensionRecovery'),
    },
  )
  await ctx.plugin(class extends CandidateWorkbenchService {
    constructor(scope: Context) {
      super(scope, workbench)
    }
  })
  ctx.systemPrompt.section({
    name: 'product:candidate-workbench',
    order: 45,
    text: WORKBENCH_CONVERSATION_GUIDANCE,
  })
  ctx.effect(() => registerWorkbenchTools(ctx.tools, workbench, { inspectOnly: config.inspectOnly }))
}

function hostOwnedArchitectureInventory(registry: { list(): readonly { runtimeSeams: readonly string[] }[] }): ArchitectureInventory {
  return {
    complete: true,
    seams: [...new Set([...CORE_KNOWN_SEAMS, ...registry.list().flatMap((record) => record.runtimeSeams)])],
  }
}
