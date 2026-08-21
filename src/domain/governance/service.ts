import type { CapabilityRegistry, RegistryRegisterInput } from '../registry/types.js'
import type { CandidateRecord, CandidateWorkspace } from '../candidate/types.js'
import { ActivationDeniedError, GovernanceAuthorityError, GovernanceContractError } from './errors.js'
import { approvalSummary, fingerprintFromCandidate } from './fingerprint.js'
import { InMemoryActivationRuntime, type ActivationRuntime } from './runtime.js'
import type {
  ActivationFailure,
  ActivationPhase,
  ActivationSnapshot,
  ActivationState,
  ActivationStatus,
  ApprovalRecord,
  ApprovalSummary,
  EligibilityDenial,
  EligibilityResult,
  ExtensionActivation,
  ExtensionGovernance,
  ExtensionRecovery,
  TrustedApprovalInput,
  TrustedAuthorityCredential,
} from './types.js'
import { TrustedAuthorityCredential as AuthorityCredential } from './types.js'

function ownersFromRegistry(registry: CapabilityRegistry): ActivationSnapshot['owners'] {
  return registry.list({ status: 'active' }).map((record) => ({
    owner: record.owner,
    version: record.version,
    status: record.status,
    capabilities: record.capabilities.map((item) => item.id),
  }))
}

export class GovernanceService implements ExtensionGovernance, ExtensionActivation, ExtensionRecovery {
  private readonly approvals = new Map<string, ApprovalRecord>()
  private nextApproval = 1
  private generation = 0
  private state: ActivationState = 'idle'
  private current?: ActivationSnapshot
  private lastKnownGood?: ActivationSnapshot
  private rollbackTarget?: ActivationSnapshot
  private lastFailure?: ActivationFailure
  private safeMode = false

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly workspace: CandidateWorkspace,
    readonly runtime: ActivationRuntime = new InMemoryActivationRuntime(),
    private readonly rootId: symbol = Symbol('unbound-governance'),
  ) {
    this.current = this.captureSnapshot()
    this.lastKnownGood = this.current
  }

  requestApproval(candidateId: string): ApprovalRecord {
    const { record, diff, fingerprint } = this.facts(candidateId)
    const existing = this.approvals.get(candidateId)
    if (existing?.decision === 'approved-for-exact-diff' && existing.fingerprint === fingerprint) {
      return existing
    }
    if (existing?.decision === 'approved-for-exact-diff' && existing.fingerprint !== fingerprint) {
      this.approvals.set(candidateId, { ...existing, decision: 'superseded' })
    }
    const created: ApprovalRecord = {
      id: `apr-${this.nextApproval++}`,
      candidateId,
      fingerprint,
      decision: 'approval-requested',
      createdAt: new Date().toISOString(),
      summary: approvalSummary(record, diff),
    }
    this.approvals.set(candidateId, created)
    return created
  }

  inspectApproval(candidateId: string): ApprovalRecord | undefined {
    return this.approvals.get(candidateId)
  }

  inspectSummary(candidateId: string): ApprovalSummary {
    const { record, diff } = this.facts(candidateId)
    return approvalSummary(record, diff)
  }

  eligibility(candidateId: string): EligibilityResult {
    const denials = this.denials(candidateId)
    const fingerprint = denials.some((item) => item.reason === 'unknown-candidate')
      ? undefined
      : this.facts(candidateId).fingerprint
    return { ok: denials.length === 0, candidateId, fingerprint, denials }
  }

  recordUntrustedApproval(_input: { approved?: boolean; authority?: string }): never {
    throw new GovernanceAuthorityError('model/untrusted input cannot manufacture trusted approval')
  }

  rewriteRecoveryRoot(): never {
    throw new GovernanceAuthorityError('Self-Extension cannot rewrite the approval/recovery root')
  }

  status(): ActivationStatus {
    return {
      state: this.safeMode ? 'safe-mode' : this.state,
      current: this.current,
      lastKnownGood: this.lastKnownGood,
      rollbackTarget: this.rollbackTarget,
      lastFailure: this.lastFailure,
      safeMode: this.safeMode,
    }
  }

  inspect(): ActivationStatus {
    return this.status()
  }

  recordApproval(credential: TrustedAuthorityCredential, input: TrustedApprovalInput): ApprovalRecord {
    this.assertCredential(credential)
    const { fingerprint, record, diff } = this.facts(input.candidateId)
    if (input.fingerprint !== fingerprint) {
      throw new GovernanceContractError('approval fingerprint does not match the current sealed candidate')
    }
    const existing = this.approvals.get(input.candidateId)
    if (existing?.decision === 'approved-for-exact-diff' && existing.fingerprint !== fingerprint) {
      this.approvals.set(input.candidateId, { ...existing, decision: 'superseded' })
    }
    const created: ApprovalRecord = {
      id: `apr-${this.nextApproval++}`,
      candidateId: input.candidateId,
      fingerprint,
      decision: input.decision,
      authority: credential.authority,
      createdAt: new Date().toISOString(),
      summary: approvalSummary(record, diff),
    }
    this.approvals.set(input.candidateId, created)
    return created
  }

  async activate(candidateId: string, credential: TrustedAuthorityCredential): Promise<ActivationStatus> {
    this.assertCredential(credential)
    const gate = this.eligibility(candidateId)
    if (!gate.ok) throw new ActivationDeniedError(gate.denials)
    const { record } = this.facts(candidateId)
    this.state = 'activation-pending'
    const previousGood = this.lastKnownGood ?? this.captureSnapshot()
    this.rollbackTarget = previousGood
    let phase: ActivationPhase = 'capture-lkg'
    try {
      this.state = 'activating'
      phase = 'prepare'
      const prepared = await this.runtime.prepare(candidateId, {
        workspaceRoot: record.workspaceRoot,
        entryPoints: record.manifest.entryPoints,
        owner: record.owner,
        resolutionKind: record.manifest.resolutionKind,
        baseVersion: record.baseVersion,
        tools: record.manifest.tools,
        services: record.manifest.services,
        providers: record.manifest.providers,
        runtimeSeams: record.manifest.runtimeSeams,
      })
      if (!prepared.ok) throw new Error(prepared.diagnostics ?? 'prepare failed')
      phase = 'health'
      const health = await this.runtime.verifyHealth(candidateId, [
        ...record.manifest.runtimeSeams,
        ...record.manifest.tools,
        ...record.manifest.services,
      ])
      if (!health.ok) throw new Error(health.diagnostics ?? 'health failed')
      phase = 'commit'
      this.commitRegistry(record)
      await this.runtime.commit(candidateId)
      this.current = this.captureSnapshot()
      this.lastKnownGood = this.current
      this.state = 'active'
      this.lastFailure = undefined
      return this.status()
    } catch (error) {
      const restored = await this.restoreSnapshot(previousGood)
      this.current = this.captureSnapshot()
      this.lastKnownGood = previousGood
      this.state = 'activation-failed'
      this.lastFailure = {
        candidateId,
        version: record.version,
        digest: record.digest ?? '',
        phase,
        diagnostics: error instanceof Error ? error.message : String(error),
        rollbackAttempted: true,
        rollbackSucceeded: restored,
        restoredLkgGeneration: previousGood.generation,
        safeModeRequired: !restored,
      }
      if (!restored) this.safeMode = true
      return this.status()
    }
  }

  async rollback(credential: TrustedAuthorityCredential): Promise<ActivationStatus> {
    this.assertCredential(credential)
    const target = this.rollbackTarget ?? this.lastKnownGood
    if (target === undefined) throw new GovernanceContractError('no last-known-good snapshot to restore')
    const restored = await this.restoreSnapshot(target)
    this.current = this.captureSnapshot()
    this.lastKnownGood = target
    this.state = restored ? 'rolled-back' : 'activation-failed'
    this.safeMode = this.safeMode || !restored
    return this.status()
  }

  enterSafeMode(credential: TrustedAuthorityCredential): ActivationStatus {
    this.assertCredential(credential)
    for (const record of this.registry.list({ status: 'active' })) {
      if (record.owner.startsWith('generated/')) {
        this.registry.transitionStatus(record.owner, record.version, 'disabled')
      }
    }
    this.safeMode = true
    this.state = 'safe-mode'
    this.current = this.captureSnapshot()
    return this.status()
  }

  disable(credential: TrustedAuthorityCredential, owner: string, version: string): void {
    this.assertCredential(credential)
    this.registry.transitionStatus(owner, version, 'disabled')
    this.current = this.captureSnapshot()
  }

  private assertCredential(credential: TrustedAuthorityCredential): void {
    if (!(credential instanceof AuthorityCredential) || !credential.issuedBy(this.rootId)) {
      throw new GovernanceAuthorityError('approval/recovery action requires a credential issued by the recovery root')
    }
  }

  private facts(candidateId: string) {
    const record = this.workspace.get(candidateId)
    const diff = this.workspace.diff(candidateId)
    const fingerprint = fingerprintFromCandidate(record, diff)
    return { record, diff, fingerprint }
  }

  private denials(candidateId: string): EligibilityDenial[] {
    let record: CandidateRecord
    try {
      record = this.workspace.get(candidateId)
    } catch {
      return [{ reason: 'unknown-candidate', detail: candidateId }]
    }
    const denials: EligibilityDenial[] = []
    if (!record.sealed) denials.push({ reason: 'not-sealed', detail: 'candidate must be sealed before activation' })
    if (record.lifecycle !== 'validated' || record.validation?.passed !== true) {
      denials.push({ reason: 'not-validated', detail: `lifecycle is ${record.lifecycle}` })
    }
    if (record.digest === undefined || record.validation?.digest !== record.digest) {
      denials.push({ reason: 'digest-mismatch', detail: 'validation digest does not match the sealed artifact' })
    }
    const approval = this.approvals.get(candidateId)
    if (approval === undefined || approval.decision === 'unreviewed' || approval.decision === 'approval-requested') {
      denials.push({ reason: 'approval-required', detail: 'trusted approval for the exact digest/diff is required' })
    } else if (approval.decision === 'rejected') {
      denials.push({ reason: 'approval-rejected', detail: approval.id })
    } else if (approval.decision === 'superseded') {
      denials.push({ reason: 'approval-stale', detail: 'prior approval was superseded' })
    } else if (approval.decision === 'approved-for-exact-diff') {
      try {
        const { fingerprint } = this.facts(candidateId)
        if (approval.fingerprint !== fingerprint) {
          denials.push({ reason: 'approval-stale', detail: 'approval fingerprint no longer matches the candidate' })
        }
      } catch {
        denials.push({ reason: 'approval-stale', detail: 'cannot recompute fingerprint' })
      }
    }
    if (record.baseVersion !== undefined) {
      const active = this.registry.list({ owner: record.owner, status: 'active' })[0]
      if (active !== undefined && active.version !== record.baseVersion) {
        denials.push({ reason: 'base-changed', detail: `active base is ${active.version}, proposal assumed ${record.baseVersion}` })
      }
    }
    const conflicts = this.registry.conflicts()
    if (conflicts.length > 0) {
      denials.push({ reason: 'ownership-conflict', detail: conflicts.map((item) => item.capability).join(', ') })
    }
    if (this.safeMode && record.owner.startsWith('generated/')) {
      denials.push({ reason: 'safe-mode', detail: 'generated extensions are excluded in Safe Mode' })
    }
    return denials
  }

  private captureSnapshot(): ActivationSnapshot {
    this.generation += 1
    return this.runtime.snapshot(this.generation, ownersFromRegistry(this.registry))
  }

  private commitRegistry(record: CandidateRecord): void {
    const previous = this.registry.list({ owner: record.owner, status: 'active' })[0]
    if (previous !== undefined && previous.version !== record.version) {
      this.registry.transitionStatus(previous.owner, previous.version, 'disabled')
    }
    const existing = this.registry.get(record.owner, record.version)
    if (existing === undefined) {
      this.registry.register(this.toRegisterInput(record))
    } else if (existing.status !== 'active') {
      this.registry.transitionStatus(record.owner, record.version, 'active')
    }
  }

  private toRegisterInput(record: CandidateRecord): RegistryRegisterInput {
    return {
      owner: record.owner,
      version: record.version,
      provenance: record.provenance,
      status: 'active',
      evidence: 'Verified',
      capabilities: record.manifest.capabilities.map((id) => ({ id, permissions: [] })),
      permissions: record.manifest.permissions,
      runtimeSeams: record.manifest.runtimeSeams,
      tools: record.manifest.tools,
      services: record.manifest.services,
      providers: record.manifest.providers,
      provider: record.manifest.providers[0],
    }
  }

  private async restoreSnapshot(snapshot: ActivationSnapshot): Promise<boolean> {
    try {
      await this.runtime.restore(snapshot)
      for (const current of this.registry.list({ status: 'active' })) {
        const wanted = snapshot.owners.some((item) => item.owner === current.owner && item.version === current.version)
        if (!wanted) this.registry.transitionStatus(current.owner, current.version, 'disabled')
      }
      for (const owner of snapshot.owners) {
        const record = this.registry.get(owner.owner, owner.version)
        if (record !== undefined && record.status !== 'active') {
          this.registry.transitionStatus(owner.owner, owner.version, 'active')
        }
      }
      return true
    } catch {
      return false
    }
  }
}
