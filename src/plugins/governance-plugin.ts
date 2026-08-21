import { Service, type Context } from '@deepseek-ai/cordis'
import { GovernanceService } from '../domain/governance/index.js'
import type {
  ExtensionActivation,
  ExtensionGovernance,
  ExtensionRecovery,
} from '../domain/governance/index.js'
import { registerGovernanceTools } from './governance-tools.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    extensionGovernance: ExtensionGovernance
    extensionActivation: ExtensionActivation
    extensionRecovery: ExtensionRecovery
  }
}

export class ExtensionGovernanceService extends Service implements ExtensionGovernance {
  constructor(ctx: Context, private readonly store: ExtensionGovernance) {
    super(ctx, 'extensionGovernance')
  }

  requestApproval(candidateId: string) { return this.store.requestApproval(candidateId) }
  inspectApproval(candidateId: string) { return this.store.inspectApproval(candidateId) }
  inspectSummary(candidateId: string) { return this.store.inspectSummary(candidateId) }
  eligibility(candidateId: string) { return this.store.eligibility(candidateId) }
  recordUntrustedApproval(input: { approved?: boolean; authority?: string }): never {
    return this.store.recordUntrustedApproval(input)
  }
  rewriteRecoveryRoot(): never { return this.store.rewriteRecoveryRoot() }
}

export class ExtensionActivationService extends Service implements ExtensionActivation {
  constructor(ctx: Context, private readonly store: ExtensionActivation) {
    super(ctx, 'extensionActivation')
  }

  status() { return this.store.status() }
  activate(...args: Parameters<ExtensionActivation['activate']>) { return this.store.activate(...args) }
}

export class ExtensionRecoveryService extends Service implements ExtensionRecovery {
  constructor(ctx: Context, private readonly store: ExtensionRecovery) {
    super(ctx, 'extensionRecovery')
  }

  issueAuthority(...args: Parameters<ExtensionRecovery['issueAuthority']>) { return this.store.issueAuthority(...args) }
  inspect() { return this.store.inspect() }
  recordApproval(...args: Parameters<ExtensionRecovery['recordApproval']>) { return this.store.recordApproval(...args) }
  rollback(...args: Parameters<ExtensionRecovery['rollback']>) { return this.store.rollback(...args) }
  enterSafeMode(...args: Parameters<ExtensionRecovery['enterSafeMode']>) { return this.store.enterSafeMode(...args) }
  disable(...args: Parameters<ExtensionRecovery['disable']>) { return this.store.disable(...args) }
}

export const name = 'dsh-assistant-governance'
export const inject = ['capabilityRegistry', 'candidateWorkspace', 'tools']

/** Governance, activation, and recovery. Approval/activation require the recovery-root credential. */
export async function apply(ctx: Context) {
  const store = new GovernanceService(ctx.capabilityRegistry, ctx.candidateWorkspace)
  const governance: ExtensionGovernance = {
    requestApproval: (id) => store.requestApproval(id),
    inspectApproval: (id) => store.inspectApproval(id),
    inspectSummary: (id) => store.inspectSummary(id),
    eligibility: (id) => store.eligibility(id),
    recordUntrustedApproval: (input) => store.recordUntrustedApproval(input),
    rewriteRecoveryRoot: () => store.rewriteRecoveryRoot(),
  }
  await ctx.plugin(class extends ExtensionGovernanceService {
    constructor(scope: Context) { super(scope, store) }
  })
  await ctx.plugin(class extends ExtensionActivationService {
    constructor(scope: Context) { super(scope, store) }
  })
  await ctx.plugin(class extends ExtensionRecoveryService {
    constructor(scope: Context) { super(scope, store) }
  })
  ctx.effect(() => registerGovernanceTools(ctx.tools, governance))
}
