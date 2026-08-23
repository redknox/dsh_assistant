import { Service, type Context } from '@deepseek-ai/cordis'
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

  plan(input: Parameters<CandidateWorkbench['plan']>[0]) { return this.store.plan(input) }
  rememberPlan(review: Parameters<CandidateWorkbench['rememberPlan']>[0]) { return this.store.rememberPlan(review) }
  getPlan(planId: string) { return this.store.getPlan(planId) }
  create(input: Parameters<CandidateWorkbench['create']>[0]) { return this.store.create(input) }
  inspect(candidateId: string) { return this.store.inspect(candidateId) }
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

export interface WorkbenchPluginConfig extends WorkbenchServiceOptions {}

export const name = 'dsh-assistant-workbench'
export const inject = [
  'capabilityResolution',
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
    { restore: config.restore, persist: config.persist },
  )
  await ctx.plugin(class extends CandidateWorkbenchService {
    constructor(scope: Context) {
      super(scope, workbench)
    }
  })
  ctx.systemPrompt.section({
    name: 'product:candidate-workbench',
    order: 45,
    text: 'Candidate Workbench tools author a governed extension candidate. Proposal/plan tools do not execute. Writing candidate files is development authority only, never install or approval authority. Independent Review review-complete is NOT APPROVED. Only a human through Recovery Root / Mission-Control can approve and activate. Execution of generated code uses the isolated runner. Do not use the operator sandbox as a build workspace.',
  })
  ctx.effect(() => registerWorkbenchTools(ctx.tools, workbench))
}
