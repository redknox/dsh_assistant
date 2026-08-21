import { existsSync } from 'node:fs'
import { digestFiles } from '../candidate/digest.js'
import { listSourceFiles } from '../candidate/files.js'
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

export type ActivationInterrupt = 'activation-pending' | 'prepare' | 'commit' | 'rollback-pending'

export interface GovernanceHydrate {
  readonly approvals: readonly ApprovalRecord[]
  readonly nextApproval: number
  readonly generation: number
  readonly state: ActivationState
  readonly phase?: ActivationPhase
  readonly pendingCandidateId?: string
  readonly current?: ActivationSnapshot
  readonly lastKnownGood?: ActivationSnapshot
  readonly rollbackTarget?: ActivationSnapshot
  readonly lastFailure?: ActivationFailure
  readonly safeMode: boolean
}

export class SimulatedCrashError extends Error {
  readonly retainDurableState = true
  constructor(point: ActivationInterrupt) {
    super(`simulated crash after ${point}`)
    this.name = 'SimulatedCrashError'
  }
}

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
  private phase?: ActivationPhase
  private pendingCandidateId?: string
  interruptAfter?: ActivationInterrupt
  private readonly persistHook?: () => void

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly workspace: CandidateWorkspace,
    readonly runtime: ActivationRuntime = new InMemoryActivationRuntime(),
    private readonly rootId: symbol = Symbol('unbound-governance'),
    options: { persist?: () => void; hydrate?: GovernanceHydrate } = {},
  ) {
    this.persistHook = options.persist
    if (options.hydrate && (options.hydrate.generation > 0 || options.hydrate.current !== undefined)) {
      this.applyHydrate(options.hydrate)
    } else {
      this.current = this.captureSnapshot()
      this.lastKnownGood = this.current
      if (options.hydrate?.approvals.length) this.applyHydrate({ ...options.hydrate, current: this.current, lastKnownGood: this.lastKnownGood, generation: this.generation })
    }
  }

  exportHydrate(): GovernanceHydrate {
    return {
      approvals: [...this.approvals.values()],
      nextApproval: this.nextApproval,
      generation: this.generation,
      state: this.state,
      phase: this.phase,
      pendingCandidateId: this.pendingCandidateId,
      current: this.current,
      lastKnownGood: this.lastKnownGood,
      rollbackTarget: this.rollbackTarget,
      lastFailure: this.lastFailure,
      safeMode: this.safeMode,
    }
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
    this.flush()
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
    this.flush()
    return created
  }

  async activate(candidateId: string, credential: TrustedAuthorityCredential): Promise<ActivationStatus> {
    this.assertCredential(credential)
    const gate = this.eligibility(candidateId)
    if (!gate.ok) throw new ActivationDeniedError(gate.denials)
    const { record } = this.facts(candidateId)
    this.state = 'activation-pending'
    this.pendingCandidateId = candidateId
    this.phase = 'verify-eligibility'
    const previousGood = this.lastKnownGood ?? this.captureSnapshot()
    this.rollbackTarget = previousGood
    this.flush()
    await this.maybeInterrupt('activation-pending')
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
      this.flush()
      await this.maybeInterrupt('prepare')
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
      this.pendingCandidateId = undefined
      this.phase = undefined
      this.lastFailure = undefined
      this.flush()
      await this.maybeInterrupt('commit')
      return this.status()
    } catch (error) {
      if (error instanceof SimulatedCrashError) throw error
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
      this.flush()
      return this.status()
    }
  }

  async rollback(credential: TrustedAuthorityCredential): Promise<ActivationStatus> {
    this.assertCredential(credential)
    const target = this.rollbackTarget ?? this.lastKnownGood
    if (target === undefined) throw new GovernanceContractError('no last-known-good snapshot to restore')
    this.state = 'rollback-pending'
    this.flush()
    await this.maybeInterrupt('rollback-pending')
    return this.finishRollback(target)
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
    this.flush()
    return this.status()
  }

  exitSafeMode(credential: TrustedAuthorityCredential): ActivationStatus {
    this.assertCredential(credential)
    this.safeMode = false
    this.state = this.lastKnownGood === undefined ? 'idle' : 'active'
    this.current = this.captureSnapshot()
    this.flush()
    return this.status()
  }

  disable(credential: TrustedAuthorityCredential, owner: string, version: string): void {
    this.assertCredential(credential)
    this.registry.transitionStatus(owner, version, 'disabled')
    this.current = this.captureSnapshot()
    this.flush()
  }

  async remountCommittedGenerated(): Promise<string[]> {
    const diagnostics: string[] = []
    if (this.safeMode) return diagnostics
    for (const record of this.registry.list({ status: 'active' })) {
      if (!record.owner.startsWith('generated/')) continue
      const candidate = this.workspace.list().find((item) => item.owner === record.owner && item.version === record.version)
      if (candidate === undefined) {
        diagnostics.push(`missing-active-artifact:${record.owner}@${record.version}`)
        continue
      }
      const integrity = this.verifySealedArtifact(candidate)
      if (integrity !== undefined) {
        diagnostics.push(integrity)
        continue
      }
      const prepared = await this.runtime.prepare(candidate.id, {
        workspaceRoot: candidate.workspaceRoot,
        entryPoints: candidate.manifest.entryPoints,
        owner: candidate.owner,
        resolutionKind: candidate.manifest.resolutionKind,
        baseVersion: candidate.baseVersion,
        tools: candidate.manifest.tools,
        services: candidate.manifest.services,
        providers: candidate.manifest.providers,
        runtimeSeams: candidate.manifest.runtimeSeams,
      })
      if (!prepared.ok) {
        diagnostics.push(prepared.diagnostics ?? `prepare-failed:${candidate.id}`)
        continue
      }
      await this.runtime.commit(candidate.id)
    }
    if (diagnostics.length > 0) {
      this.safeMode = true
      this.state = 'safe-mode'
      this.lastFailure = {
        candidateId: this.pendingCandidateId ?? 'restart',
        version: '',
        digest: '',
        phase: 'prepare',
        diagnostics: diagnostics.join('; '),
        rollbackAttempted: false,
        rollbackSucceeded: false,
        safeModeRequired: true,
      }
      this.flush()
    }
    return diagnostics
  }

  completeInterruptedActivation(): void {
    if (this.state !== 'activation-pending' && this.state !== 'activating') return
    this.lastFailure = {
      candidateId: this.pendingCandidateId ?? 'unknown',
      version: '',
      digest: '',
      phase: this.phase ?? 'prepare',
      diagnostics: 'activation interrupted before durable commit; prior LKG remains authoritative',
      rollbackAttempted: false,
      rollbackSucceeded: true,
      restoredLkgGeneration: this.lastKnownGood?.generation,
      safeModeRequired: false,
    }
    this.state = 'activation-failed'
    this.pendingCandidateId = undefined
    this.phase = undefined
    this.flush()
  }

  async completeInterruptedRollback(): Promise<void> {
    if (this.state !== 'rollback-pending') return
    const target = this.rollbackTarget ?? this.lastKnownGood
    if (target === undefined) {
      this.safeMode = true
      this.state = 'safe-mode'
      this.flush()
      return
    }
    await this.finishRollback(target)
  }

  private async finishRollback(target: ActivationSnapshot): Promise<ActivationStatus> {
    const restored = await this.restoreSnapshot(target)
    this.current = this.captureSnapshot()
    this.lastKnownGood = target
    this.state = restored ? 'rolled-back' : 'activation-failed'
    this.safeMode = this.safeMode || !restored
    this.pendingCandidateId = undefined
    this.phase = undefined
    this.flush()
    return this.status()
  }

  private verifySealedArtifact(record: CandidateRecord): string | undefined {
    if (!existsSync(record.workspaceRoot)) return `missing-active-artifact:${record.id}`
    if (record.digest === undefined) return `digest-mismatch:${record.id}`
    const digest = digestFiles(record.workspaceRoot, listSourceFiles(record.workspaceRoot))
    if (digest !== record.digest) return `digest-mismatch:${record.id}`
    return undefined
  }

  private applyHydrate(hydrate: GovernanceHydrate): void {
    this.approvals.clear()
    for (const approval of hydrate.approvals) this.approvals.set(approval.candidateId, approval)
    this.nextApproval = hydrate.nextApproval
    this.generation = hydrate.generation
    this.state = hydrate.state
    this.phase = hydrate.phase
    this.pendingCandidateId = hydrate.pendingCandidateId
    this.current = hydrate.current
    this.lastKnownGood = hydrate.lastKnownGood
    this.rollbackTarget = hydrate.rollbackTarget
    this.lastFailure = hydrate.lastFailure
    this.safeMode = hydrate.safeMode
  }

  private flush(): void {
    this.persistHook?.()
  }

  private async maybeInterrupt(point: ActivationInterrupt): Promise<void> {
    if (this.interruptAfter === point) throw new SimulatedCrashError(point)
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
