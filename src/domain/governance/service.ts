import { existsSync } from 'node:fs'
import { contractDigestExtras, digestFiles } from '../candidate/digest.js'
import { listSourceFiles } from '../candidate/files.js'
import { isolatedRuntimeOwner, requiresIsolatedGeneratedRuntime } from '../generated-runtime/trust.js'
import type { CapabilityRegistry, RegistryRegisterInput } from '../registry/types.js'
import { REVIEW_POLICY_VERSION, type IndependentReview } from '../review/index.js'
import type { CandidateRecord, CandidateWorkspace } from '../candidate/types.js'
import { ActivationDeniedError, GovernanceAuthorityError, GovernanceContractError } from './errors.js'
import { approvalSummary, fingerprintFromCandidate } from './fingerprint.js'
import { InMemoryActivationRuntime, type ActivationPrepareContext, type ActivationRuntime } from './runtime.js'
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

export type ActivationInterrupt = 'activation-pending' | 'prepare' | 'registry-commit' | 'commit' | 'rollback-pending'

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
  readonly integrityVerified?: boolean
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
  private integrityVerified = false
  private phase?: ActivationPhase
  private pendingCandidateId?: string
  interruptAfter?: ActivationInterrupt
  private readonly persistHook?: () => void
  private readonly beginAuthorityCommit?: () => void
  private readonly finishAuthorityCommit?: () => void
  private readonly independentReview?: IndependentReview

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly workspace: CandidateWorkspace,
    readonly runtime: ActivationRuntime = new InMemoryActivationRuntime(),
    private readonly rootId: symbol = Symbol('unbound-governance'),
    options: {
      persist?: () => void
      hydrate?: GovernanceHydrate
      beginAuthorityCommit?: () => void
      finishAuthorityCommit?: () => void
      independentReview?: IndependentReview
    } = {},
  ) {
    this.persistHook = options.persist
    this.beginAuthorityCommit = options.beginAuthorityCommit
    this.finishAuthorityCommit = options.finishAuthorityCommit
    this.independentReview = options.independentReview
    if (options.hydrate && (options.hydrate.generation > 0 || options.hydrate.current !== undefined)) {
      this.applyHydrate(options.hydrate)
    } else {
      this.current = this.captureSnapshot()
      this.lastKnownGood = this.current
      if (options.hydrate?.approvals.length) this.applyHydrate({ ...options.hydrate, current: this.current, lastKnownGood: this.lastKnownGood, generation: this.generation })
    }
    this.runtime.bindIsolatedFailure((failure) => this.noteIsolatedRuntimeFailure(failure))
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
      integrityVerified: this.integrityVerified,
    }
  }

  requestApproval(candidateId: string): ApprovalRecord {
    const gate = this.requestEligibility(candidateId)
    if (!gate.ok) {
      const first = gate.denials[0]
      throw new GovernanceContractError(`${first?.reason ?? 'review-required'}: ${first?.detail ?? candidateId}`)
    }
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
    let fingerprint: string | undefined
    if (!denials.some((item) => item.reason === 'unknown-candidate')) {
      try {
        fingerprint = this.facts(candidateId).fingerprint
      } catch {
        fingerprint = undefined
      }
    }
    return { ok: denials.length === 0, candidateId, fingerprint, denials }
  }

  requestEligibility(candidateId: string): EligibilityResult {
    const denials = this.approvalRequestDenials(candidateId)
    let fingerprint: string | undefined
    if (!denials.some((item) => item.reason === 'unknown-candidate')) {
      try {
        fingerprint = this.facts(candidateId).fingerprint
      } catch {
        fingerprint = undefined
      }
    }
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
      recoveryRequired: this.isRecoveryRequired(),
      integrityVerified: this.integrityVerified,
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
      const prepared = await this.runtime.prepare(candidateId, this.prepareContext(record))
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
      this.beginAuthorityCommit?.()
      this.commitRegistry(record)
      await this.maybeInterrupt('registry-commit')
      await this.runtime.commit(candidateId)
      this.current = this.captureSnapshot()
      this.lastKnownGood = this.current
      this.state = 'active'
      this.pendingCandidateId = undefined
      this.phase = undefined
      this.lastFailure = undefined
      this.integrityVerified = true
      this.flush()
      this.finishAuthorityCommit?.()
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
      this.finishAuthorityCommit?.()
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
      if (isolatedRuntimeOwner(record)) {
        this.registry.transitionStatus(record.owner, record.version, 'disabled')
      }
    }
    this.safeMode = true
    this.state = 'safe-mode'
    this.current = this.captureSnapshot()
    void this.runtime.unloadGenerated()
    this.flush()
    return this.status()
  }

  exitSafeMode(credential: TrustedAuthorityCredential): ActivationStatus {
    this.assertCredential(credential)
    if (this.isRecoveryRequired()) {
      throw new GovernanceContractError('cannot exit Safe Mode while recovery is still required')
    }
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
    const snapshot = this.committedActivationSnapshot()
    const targets = (snapshot?.owners ?? []).filter((item) => {
      if (item.status !== 'active') return false
      const record = this.registry.get(item.owner, item.version)
      return isolatedRuntimeOwner(record ?? { owner: item.owner })
    })
    const committed = new Set(targets.map((item) => `${item.owner}@${item.version}`))
    for (const record of this.registry.list({ status: 'active' })) {
      if (!isolatedRuntimeOwner(record)) continue
      const key = `${record.owner}@${record.version}`
      if (!committed.has(key)) diagnostics.push(`inconsistent-active-owner:${key}`)
    }
    const verified: CandidateRecord[] = []
    for (const target of targets) {
      const candidate = this.workspace.list().find((item) => item.owner === target.owner && item.version === target.version)
      if (candidate === undefined) {
        diagnostics.push(`missing-active-artifact:${target.owner}@${target.version}`)
        continue
      }
      const integrity = this.verifySealedArtifact(candidate)
      if (integrity !== undefined) {
        diagnostics.push(integrity)
        continue
      }
      verified.push(candidate)
    }
    if (diagnostics.length > 0) {
      await this.failClosedSafeMode(diagnostics)
      return diagnostics
    }
    for (const candidate of verified) {
      const prepared = await this.runtime.prepare(candidate.id, this.prepareContext(candidate))
      if (!prepared.ok) {
        diagnostics.push(prepared.diagnostics ?? `prepare-failed:${candidate.id}`)
        await this.runtime.restore({
          generation: snapshot?.generation ?? 0,
          capturedAt: new Date().toISOString(),
          owners: snapshot?.owners ?? [],
          profileIdentity: snapshot?.profileIdentity ?? 'assistant-core',
          mounted: [],
        })
        await this.failClosedSafeMode(diagnostics)
        return diagnostics
      }
      await this.runtime.commit(candidate.id)
    }
    return diagnostics
  }

  private committedActivationSnapshot(): ActivationSnapshot | undefined {
    if (this.state === 'active' || this.state === 'rolled-back') return this.current ?? this.lastKnownGood
    return this.lastKnownGood
  }

  private async failClosedSafeMode(diagnostics: readonly string[]): Promise<void> {
    for (const record of this.registry.list({ status: 'active' })) {
      if (isolatedRuntimeOwner(record)) {
        this.registry.transitionStatus(record.owner, record.version, 'disabled')
      }
    }
    this.safeMode = true
    this.state = 'safe-mode'
    this.integrityVerified = false
    this.current = this.captureSnapshot()
    void this.runtime.unloadGenerated()
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
    this.lastKnownGood = target
    this.current = target
    this.state = restored ? 'rolled-back' : 'activation-failed'
    this.safeMode = this.safeMode || !restored
    this.pendingCandidateId = undefined
    this.phase = undefined
    if (restored) {
      const remount = await this.remountCommittedGenerated()
      if (remount.length > 0) return this.status()
    }
    this.current = this.captureSnapshot()
    this.integrityVerified = restored && this.verifyRestoredIntegrity(target)
    this.flush()
    return this.status()
  }

  private isRecoveryRequired(): boolean {
    if (this.state === 'rollback-pending') return true
    if (this.safeMode && this.lastFailure?.safeModeRequired === true && !this.integrityVerified) return true
    if (this.state === 'activation-failed' && this.lastFailure?.rollbackSucceeded !== true && !this.integrityVerified) return true
    return false
  }

  private verifyRestoredIntegrity(snapshot: ActivationSnapshot): boolean {
    const wanted = new Set(snapshot.owners.map((item) => `${item.owner}@${item.version}`))
    const active = this.registry.list({ status: 'active' }).map((item) => `${item.owner}@${item.version}`)
    if (wanted.size !== active.length) return false
    for (const key of active) {
      if (!wanted.has(key)) return false
    }
    for (const owner of snapshot.owners) {
      const record = this.registry.get(owner.owner, owner.version)
      if (record === undefined || record.status !== 'active') return false
      if (!isolatedRuntimeOwner(record)) continue
      const candidate = this.workspace.list().find((item) => item.owner === owner.owner && item.version === owner.version)
      if (candidate === undefined) return false
      if (this.verifySealedArtifact(candidate) !== undefined) return false
    }
    return this.lastKnownGood !== undefined && this.current !== undefined
  }

  private verifySealedArtifact(record: CandidateRecord): string | undefined {
    if (!existsSync(record.workspaceRoot)) return `missing-active-artifact:${record.id}`
    if (record.digest === undefined) return `digest-mismatch:${record.id}`
    const digest = digestFiles(
      record.workspaceRoot,
      listSourceFiles(record.workspaceRoot),
      contractDigestExtras(record.manifest.runtimeContractVersion),
    )
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
    this.integrityVerified = hydrate.integrityVerified === true
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

  private approvalRequestDenials(candidateId: string): EligibilityDenial[] {
    let record: CandidateRecord
    try {
      record = this.workspace.get(candidateId)
    } catch {
      return [{ reason: 'unknown-candidate', detail: candidateId }]
    }
    const denials: EligibilityDenial[] = []
    if (!record.sealed) denials.push({ reason: 'not-sealed', detail: 'candidate must be sealed before approval can be requested' })
    if (record.lifecycle !== 'validated' || record.validation?.passed !== true) {
      denials.push({ reason: 'not-validated', detail: `lifecycle is ${record.lifecycle}` })
    }
    if (record.digest === undefined || record.validation?.digest !== record.digest) {
      denials.push({ reason: 'digest-mismatch', detail: 'validation digest does not match the sealed artifact' })
    } else if (existsSync(record.workspaceRoot)) {
      const live = digestFiles(
        record.workspaceRoot,
        listSourceFiles(record.workspaceRoot),
        contractDigestExtras(record.manifest.runtimeContractVersion),
      )
      if (live !== record.digest) {
        denials.push({ reason: 'digest-mismatch', detail: 'sealed artifact no longer matches the approved digest' })
      }
    }
    if (record.baseVersion !== undefined) {
      const active = this.registry.list({ owner: record.owner, status: 'active' })[0]
      if (active === undefined) {
        denials.push({
          reason: 'base-changed',
          detail: `no active owner for ${record.owner}; proposal assumed ${record.baseVersion}`,
        })
      } else if (active.version !== record.baseVersion) {
        denials.push({ reason: 'base-changed', detail: `active base is ${active.version}, proposal assumed ${record.baseVersion}` })
      }
    }
    denials.push(...this.reviewDenials(record))
    return denials
  }

  private reviewDenials(record: CandidateRecord): EligibilityDenial[] {
    if (this.independentReview === undefined) {
      return [{ reason: 'review-required', detail: 'Independent Review is required before approval can be requested' }]
    }
    const state = this.independentReview.status({ id: record.id, digest: record.digest })
    if (state === 'not-reviewed') {
      return [{ reason: 'review-required', detail: 'Independent Review is required before approval can be requested' }]
    }
    if (state === 'stale') {
      return [{ reason: 'review-stale', detail: 'Independent Review does not bind the current sealed digest' }]
    }
    if (state === 'changes-required' || state === 'reviewing') {
      return [{ reason: 'review-changes-required', detail: 'blocking Independent Review findings remain open' }]
    }
    const last = this.independentReview.lastReport(record.id)
    if (last === undefined || last.digest !== record.digest || last.policyVersion !== REVIEW_POLICY_VERSION) {
      return [{ reason: 'review-stale', detail: 'Independent Review does not bind the current digest and pinned policy' }]
    }
    if (last.findings.some((item) => item.blocking && item.status === 'open')) {
      return [{ reason: 'review-changes-required', detail: 'inherited or open blocking findings remain' }]
    }
    return []
  }

  private denials(candidateId: string): EligibilityDenial[] {
    const denials = this.approvalRequestDenials(candidateId)
    if (denials.some((item) => item.reason === 'unknown-candidate')) return denials
    let record: CandidateRecord
    try {
      record = this.workspace.get(candidateId)
    } catch {
      return denials
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
    const conflicts = this.registry.conflicts()
    if (conflicts.length > 0) {
      denials.push({ reason: 'ownership-conflict', detail: conflicts.map((item) => item.capability).join(', ') })
    }
    if (this.safeMode && requiresIsolatedGeneratedRuntime({
      owner: record.owner,
      provenanceKind: record.provenance.kind,
      origin: record.provenance.origin,
    })) {
      denials.push({ reason: 'safe-mode', detail: 'generated extensions are excluded in Safe Mode' })
    }
    return denials
  }

  private async noteIsolatedRuntimeFailure(failure: { readonly candidateId: string; readonly diagnostics: string }): Promise<void> {
    const record = this.workspace.list().find((item) => item.id === failure.candidateId)
    if (record !== undefined) {
      const active = this.registry.get(record.owner, record.version)
      if (active?.status === 'active') {
        this.registry.transitionStatus(record.owner, record.version, 'disabled')
      }
    }
    const target = this.rollbackTarget ?? this.lastKnownGood
    this.state = 'activation-failed'
    this.lastFailure = {
      candidateId: failure.candidateId,
      version: record?.version ?? '',
      digest: record?.digest ?? '',
      phase: 'health',
      diagnostics: failure.diagnostics,
      rollbackAttempted: target !== undefined,
      rollbackSucceeded: false,
      restoredLkgGeneration: target?.generation,
      safeModeRequired: target === undefined,
    }
    if (target === undefined) {
      this.current = this.captureSnapshot()
      this.integrityVerified = false
      this.safeMode = true
      this.flush()
      return
    }
    this.lastKnownGood = target
    const restored = await this.restoreSnapshot(target)
    this.current = this.captureSnapshot()
    const remount = restored ? await this.remountCommittedGenerated() : ['restore-failed']
    const recovered = restored && remount.length === 0
    this.lastFailure = {
      ...this.lastFailure,
      rollbackAttempted: true,
      rollbackSucceeded: recovered,
      restoredLkgGeneration: target.generation,
      safeModeRequired: !recovered,
    }
    this.state = recovered ? 'rolled-back' : 'activation-failed'
    this.integrityVerified = recovered && this.verifyRestoredIntegrity(target)
    if (!recovered) this.safeMode = true
    this.flush()
  }

  private prepareContext(record: CandidateRecord): ActivationPrepareContext {
    return {
      workspaceRoot: record.workspaceRoot,
      entryPoints: record.manifest.entryPoints,
      owner: record.owner,
      resolutionKind: record.manifest.resolutionKind,
      baseVersion: record.baseVersion,
      digest: record.digest,
      tools: record.manifest.tools,
      services: record.manifest.services,
      providers: record.manifest.providers,
      runtimeSeams: record.manifest.runtimeSeams,
      permissions: record.manifest.permissions,
      provenanceKind: record.provenance.kind,
      origin: record.provenance.origin,
      runtimeContractVersion: record.manifest.runtimeContractVersion,
    }
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
