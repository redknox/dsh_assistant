import { Service, type Context } from '@deepseek-ai/cordis'
import { RecoveryRoot } from '../domain/governance/root.js'
import { CordisActivationRuntime } from '../adapters/activation/cordis-runtime.js'
import type { ExtensionActivation, ExtensionGovernance, ExtensionRecovery } from '../domain/governance/index.js'
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
}

export class ExtensionRecoveryService extends Service implements ExtensionRecovery {
  constructor(ctx: Context, private readonly store: ExtensionRecovery) {
    super(ctx, 'extensionRecovery')
  }

  inspect() { return this.store.inspect() }
}

export interface GovernancePluginConfig {
  /** Bootstrap-only callback. Ordinary plugins must not receive this. */
  readonly attachRecoveryRoot?: (root: RecoveryRoot) => void
  readonly persist?: () => void
  readonly hydrate?: import('../domain/governance/service.js').GovernanceHydrate
}

export const name = 'dsh-assistant-governance'
export const inject = ['capabilityRegistry', 'candidateWorkspace', 'tools']

/** Inspect/request only on ctx. Trusted minting stays on the bootstrap RecoveryRoot. */
export async function apply(ctx: Context, config: GovernancePluginConfig = {}) {
  const root = new RecoveryRoot(
    ctx.capabilityRegistry,
    ctx.candidateWorkspace,
    new CordisActivationRuntime(ctx),
    { persist: config.persist, hydrate: config.hydrate },
  )
  config.attachRecoveryRoot?.(root)
  await ctx.plugin(class extends ExtensionGovernanceService {
    constructor(scope: Context) { super(scope, root.governance()) }
  })
  await ctx.plugin(class extends ExtensionActivationService {
    constructor(scope: Context) { super(scope, root.activation()) }
  })
  await ctx.plugin(class extends ExtensionRecoveryService {
    constructor(scope: Context) { super(scope, root.recovery()) }
  })
  ctx.effect(() => registerGovernanceTools(ctx.tools, root.governance()))
}
