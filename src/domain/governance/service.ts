import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { contractDigestExtras, digestFiles } from '../candidate/digest.js'
import { listSourceFiles } from '../candidate/files.js'
import { evaluateActivationCompatibility } from '../activation-compatibility/index.js'
import { isolatedRuntimeOwner, requiresIsolatedGeneratedRuntime } from '../generated-runtime/trust.js'
import type { CapabilityRegistry, RegistryRegisterInput } from '../registry/types.js'
import { REVIEW_POLICY_VERSION, type IndependentReview } from '../review/index.js'
import type { CandidateManifestInput, CandidateRecord, CandidateValidation, CandidateWorkspace } from '../candidate/types.js'
import { AUTHORING_CONTRACT_STAMP, GENERATED_EXTENSION_API_V1 } from '../workbench/authoring-contract.js'
import { boundActivationDiagnostics } from '../workspace/failure.js'
import { analyzePluginDependents } from './dependents.js'
import { ActivationDeniedError, GovernanceAuthorityError, GovernanceContractError, RollbackDeniedError, UninstallDeniedError } from './errors.js'
import { approvalSummary, fingerprintFromCandidate } from './fingerprint.js'
import { InMemoryActivationRuntime, type ActivationPrepareContext, type ActivationRuntime } from './runtime.js'
import type {
  ActivationFailure,
  ActivationPhase,
  ActivationSnapshot,
  ActivationState,
  ActivationStatus,
  RollbackPlan,
  ApprovalRecord,
  ApprovalSummary,
  InspectSummary,
  EligibilityDenial,
  EligibilityResult,
  ExtensionActivation,
  ExtensionGovernance,
  ExtensionRecovery,
  TrustedApprovalInput,
  TrustedAuthorityCredential,
} from './types.js'
import { TrustedAuthorityCredential as AuthorityCredential } from './types.js'

export type ActivationInterrupt = 'activation-pending' | 'prepare' | 'registry-commit' | 'commit' | 'rollback-pending' | 'rollback-registry-commit' | 'uninstall-registry-commit' | 'uninstall-commit'
export type LifecycleMutation = 'activation' | 'uninstall' | 'recovery'

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
  failActivation?: { phase: ActivationPhase; diagnostics: string }
  failUninstall?: { phase: 'after-unload' | 'after-registry' | 'after-persist'; diagnostics: string }
  failUninstallRestore = false
  failRollback?: { phase: 'after-restore' | 'after-registry' | 'after-remount'; diagnostics: string }
  failRollbackRestore = false
  holdActivation?: Promise<void>
  holdUninstall?: Promise<void>
  holdSafeMode?: Promise<void>
  holdRollback?: Promise<void>
  private mutation: 'idle' | LifecycleMutation = 'idle'
  private readonly persistHook?: () => void
  private readonly beginAuthorityCommit?: () => void
  private readonly finishAuthorityCommit?: () => void
  private readonly independentReview?: IndependentReview
  private readonly validation?: CandidateValidation
  private readonly onActivationDiagnostic?: (line: string) => void

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
      validation?: CandidateValidation
      onActivationDiagnostic?: (line: string) => void
    } = {},
  ) {
    this.persistHook = options.persist
    this.beginAuthorityCommit = options.beginAuthorityCommit
    this.finishAuthorityCommit = options.finishAuthorityCommit
    this.independentReview = options.independentReview
    this.validation = options.validation
    this.onActivationDiagnostic = options.onActivationDiagnostic
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

  inspectSummary(candidateId: string): InspectSummary {
    const { record, diff } = this.candidateView(candidateId)
    return {
      ...approvalSummary(record, diff),
      lifecycle: record.lifecycle,
      sealed: record.sealed,
    }
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
      pendingCandidateId: this.pendingCandidateId,
      current: this.current,
      lastKnownGood: this.lastKnownGood,
      rollbackTarget: this.rollbackTarget,
      lastFailure: this.lastFailure,
      safeMode: this.safeMode,
      recoveryRequired: this.isRecoveryRequired(),
      integrityVerified: this.integrityVerified,
      ...(this.lifecycleBusy() === undefined ? {} : { lifecycleBusy: this.lifecycleBusy() }),
      rollbackPlan: this.rollbackPlan(),
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
    this.assertMutationIdle('activation')
    const gate = this.eligibility(candidateId)
    if (!gate.ok) {
      this.emitActivationDiagnostic(
        `activation-denied candidate=${candidateId} ${gate.denials.map((item) => item.reason).join(',')}`,
      )
      throw new ActivationDeniedError(gate.denials)
    }
    const { record } = this.facts(candidateId)
    this.mutation = 'activation'
    this.state = 'activation-pending'
    this.pendingCandidateId = candidateId
    this.phase = 'verify-eligibility'
    const previousGood = this.lastKnownGood ?? this.captureSnapshot()
    this.rollbackTarget = previousGood
    this.flush()
    if (this.holdActivation) await this.holdActivation
    await this.maybeInterrupt('activation-pending')
    let phase: ActivationPhase = 'capture-lkg'
    try {
      this.state = 'activating'
      phase = 'prepare'
      const prepared = await this.runtime.prepare(candidateId, this.prepareContext(record))
      if (!prepared.ok) throw new Error(prepared.diagnostics ?? 'prepare failed')
      if (this.failActivation?.phase === 'prepare') throw new Error(this.failActivation.diagnostics)
      this.flush()
      await this.maybeInterrupt('prepare')
      phase = 'health'
      const health = await this.runtime.verifyHealth(candidateId, [
        ...record.manifest.runtimeSeams,
        ...record.manifest.tools,
        ...record.manifest.services,
      ])
      if (!health.ok) throw new Error(health.diagnostics ?? 'health failed')
      if (this.failActivation?.phase === 'health') throw new Error(this.failActivation.diagnostics)
      phase = 'commit'
      this.beginAuthorityCommit?.()
      this.commitRegistry(record)
      await this.maybeInterrupt('registry-commit')
      await this.runtime.commit(candidateId)
      if (this.failActivation?.phase === 'commit') throw new Error(this.failActivation.diagnostics)
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
      this.recordLastFailure({
        candidateId,
        version: record.version,
        digest: record.digest ?? '',
        phase,
        diagnostics: error instanceof Error ? error.message : String(error),
        rollbackAttempted: true,
        rollbackSucceeded: restored,
        restoredLkgGeneration: previousGood.generation,
        safeModeRequired: !restored,
      })
      if (!restored) this.safeMode = true
      this.flush()
      this.finishAuthorityCommit?.()
      return this.status()
    } finally {
      if (this.state !== 'activation-pending' && this.state !== 'activating') this.mutation = 'idle'
    }
  }

  async rollback(credential: TrustedAuthorityCredential): Promise<ActivationStatus> {
    this.assertCredential(credential)
    this.assertMutationIdle('recovery')
    const target = this.rollbackTarget ?? this.lastKnownGood
    if (target === undefined) throw new GovernanceContractError('no last-known-good snapshot to restore')
    const denials = this.rollbackDenials(target)
    if (denials.length > 0) throw new RollbackDeniedError(denials)
    this.mutation = 'recovery'
    const priorState = this.state
    try {
      if (this.holdRollback) await this.holdRollback
      this.state = 'rollback-pending'
      this.flush()
      await this.maybeInterrupt('rollback-pending')
      return await this.finishRollback(target, priorState)
    } finally {
      this.mutation = 'idle'
    }
  }

  async enterSafeMode(credential: TrustedAuthorityCredential): Promise<ActivationStatus> {
    this.assertCredential(credential)
    this.assertMutationIdle('recovery')
    this.mutation = 'recovery'
    try {
      for (const record of this.registry.list({ status: 'active' })) {
        if (isolatedRuntimeOwner(record)) {
          this.registry.transitionStatus(record.owner, record.version, 'disabled')
        }
      }
      this.safeMode = true
      this.state = 'safe-mode'
      this.current = this.captureSnapshot()
      if (this.holdSafeMode) await this.holdSafeMode
      await this.runtime.unloadGenerated()
      this.flush()
      return this.status()
    } finally {
      this.mutation = 'idle'
    }
  }

  exitSafeMode(credential: TrustedAuthorityCredential): ActivationStatus {
    this.assertCredential(credential)
    this.assertMutationIdle('recovery')
    if (this.isRecoveryRequired()) {
      throw new GovernanceContractError('cannot exit Safe Mode while recovery is still required')
    }
    this.mutation = 'recovery'
    try {
      this.safeMode = false
      this.state = this.lastKnownGood === undefined ? 'idle' : 'active'
      this.current = this.captureSnapshot()
      this.flush()
      return this.status()
    } finally {
      this.mutation = 'idle'
    }
  }

  disable(credential: TrustedAuthorityCredential, owner: string, version: string): void {
    this.assertCredential(credential)
    this.assertMutationIdle('recovery')
    this.mutation = 'recovery'
    try {
      this.registry.transitionStatus(owner, version, 'disabled')
      this.current = this.captureSnapshot()
      this.flush()
    } finally {
      this.mutation = 'idle'
    }
  }

  async uninstall(
    credential: TrustedAuthorityCredential,
    owner: string,
    version: string,
    options: { readonly acknowledgeDependents?: boolean } = {},
  ): Promise<ActivationStatus> {
    this.assertCredential(credential)
    this.assertMutationIdle('uninstall')
    const denials = this.uninstallDenials(owner, version, options)
    if (denials.length > 0) throw new UninstallDeniedError(denials)
    const record = this.registry.get(owner, version)
    if (record === undefined) throw new UninstallDeniedError([{ reason: 'unknown-plugin', detail: `${owner}@${version}` }])
    const candidate = this.workspace.list().find((item) => item.owner === owner && item.version === version)
    if (candidate === undefined) {
      throw new UninstallDeniedError([{ reason: 'unknown-artifact', detail: `${owner}@${version}` }])
    }
    this.mutation = 'uninstall'
    const prior = this.current
    const priorLkg = this.lastKnownGood
    if (this.holdUninstall) await this.holdUninstall
    try {
      await this.runtime.unloadGenerated(candidate.id)
      if (this.failUninstall?.phase === 'after-unload') throw new Error(this.failUninstall.diagnostics)
      this.beginAuthorityCommit?.()
      this.registry.transitionStatus(owner, version, 'disabled')
      await this.maybeInterrupt('uninstall-registry-commit')
      if (this.failUninstall?.phase === 'after-registry') throw new Error(this.failUninstall.diagnostics)
      this.current = this.captureSnapshot()
      this.lastKnownGood = this.current
      if (this.failUninstall?.phase === 'after-persist') throw new Error(this.failUninstall.diagnostics)
      this.flush()
      this.finishAuthorityCommit?.()
      await this.maybeInterrupt('uninstall-commit')
      return this.status()
    } catch (error) {
      if (error instanceof SimulatedCrashError) throw error
      if (this.registry.get(owner, version)?.status !== 'active') {
        try {
          this.registry.transitionStatus(owner, version, 'active')
        } catch {
          this.safeMode = true
          this.state = 'safe-mode'
        }
      }
      if (prior !== undefined) {
        try {
          if (this.failUninstallRestore) throw new Error('uninstall restore failed')
          await this.runtime.restore(prior)
        } catch {
          this.safeMode = true
          this.state = 'safe-mode'
        }
      }
      this.current = prior
      this.lastKnownGood = priorLkg
      this.flush()
      this.finishAuthorityCommit?.()
      throw error
    } finally {
      this.mutation = 'idle'
    }
  }

  pluginDependents(owner: string, version: string) {
    const record = this.registry.get(owner, version)
    return analyzePluginDependents({
      owner,
      version,
      capabilities: record?.capabilities.map((item) => item.id) ?? [],
      registry: this.registry.list().map((item) => ({
        owner: item.owner,
        version: item.version,
        status: item.status,
        pluginDependencies: item.pluginDependencies,
      })),
    })
  }

  private lifecycleBusy(): LifecycleMutation | undefined {
    if (this.mutation !== 'idle') return this.mutation
    if (this.state === 'activating' || this.state === 'activation-pending') return 'activation'
    if (this.state === 'rollback-pending') return 'recovery'
    return undefined
  }

  private assertMutationIdle(kind: LifecycleMutation): void {
    const busy = this.lifecycleBusy()
    if (busy === undefined) return
    const denial = { reason: `${busy}-in-flight`, detail: 'another trusted lifecycle mutation is in progress' }
    if (kind === 'activation') throw new ActivationDeniedError([denial])
    if (kind === 'uninstall') throw new UninstallDeniedError([denial])
    throw new GovernanceContractError(denial.reason)
  }

  private rollbackPlan(): RollbackPlan | undefined {
    const current = this.current
    const target = this.rollbackTarget ?? this.lastKnownGood
    if (current === undefined || target === undefined) return undefined
    const denials = this.rollbackDenials(target)
    const available = denials.length === 0
      && !this.safeMode
      && !this.isRecoveryRequired()
      && this.lifecycleBusy() === undefined
      && this.state !== 'activating'
      && this.state !== 'activation-pending'
      && this.state !== 'rollback-pending'
    return {
      id: `rollback-${current.generation}-${target.generation}`,
      currentGeneration: current.generation,
      targetGeneration: target.generation,
      fingerprint: this.rollbackFingerprint(current, target),
      available,
      denials,
    }
  }

  private rollbackFingerprint(current: ActivationSnapshot, target: ActivationSnapshot): string {
    return createHash('sha256').update(JSON.stringify({
      current: this.snapshotIdentity(current),
      target: this.snapshotIdentity(target),
      liveMounted: [...this.runtime.mounted()].sort(),
    })).digest('hex')
  }

  private snapshotIdentity(snapshot: ActivationSnapshot) {
    return {
      generation: snapshot.generation,
      profileIdentity: snapshot.profileIdentity,
      mounted: [...snapshot.mounted].sort(),
      owners: [...snapshot.owners]
        .map((item) => {
          const record = this.registry.get(item.owner, item.version)
          const candidate = this.workspace.list().find((row) => row.owner === item.owner && row.version === item.version)
          return {
            owner: item.owner,
            version: item.version,
            status: item.status,
            capabilities: [...item.capabilities].sort(),
            registryCapabilities: [...(record?.capabilities.map((claim) => claim.id) ?? [])].sort(),
            tools: [...(record?.tools ?? [])].sort(),
            digest: candidate?.digest ?? '',
          }
        })
        .sort((left, right) => `${left.owner}@${left.version}`.localeCompare(`${right.owner}@${right.version}`)),
    }
  }

  private rollbackDenials(target: ActivationSnapshot): { reason: string; detail: string }[] {
    const currentOwners = (this.current?.owners ?? ownersFromRegistry(this.registry)).map((item) => `${item.owner}@${item.version}`).sort()
    const targetOwners = target.owners.map((item) => `${item.owner}@${item.version}`).sort()
    if (currentOwners.join('\n') === targetOwners.join('\n') && !this.isRecoveryRequired()) {
      return [{ reason: 'already-restored', detail: 'current owner set already matches the rollback target' }]
    }
    for (const owner of target.owners) {
      const record = this.registry.get(owner.owner, owner.version)
      if (record === undefined) {
        return [{ reason: 'missing-target-artifact', detail: `${owner.owner}@${owner.version}` }]
      }
      if (!isolatedRuntimeOwner(record)) continue
      const candidate = this.workspace.list().find((item) => item.owner === owner.owner && item.version === owner.version)
      if (candidate === undefined) {
        return [{ reason: 'missing-target-artifact', detail: `${owner.owner}@${owner.version}` }]
      }
      const integrity = this.verifySealedArtifact(candidate)
      if (integrity !== undefined) {
        return [{
          reason: integrity.startsWith('digest-mismatch') ? 'digest-mismatch' : 'missing-target-artifact',
          detail: integrity,
        }]
      }
    }
    return []
  }

  private uninstallDenials(
    owner: string,
    version: string,
    options: { readonly acknowledgeDependents?: boolean } = {},
  ): { reason: string; detail: string }[] {
    const record = this.registry.get(owner, version)
    if (record === undefined) return [{ reason: 'unknown-plugin', detail: `${owner}@${version}` }]
    if (!isolatedRuntimeOwner(record)) {
      return [{ reason: 'managed-plugin', detail: `${owner}@${version} is not a user plugin` }]
    }
    if (record.status !== 'active') return [{ reason: 'already-uninstalled', detail: `${owner}@${version}` }]
    const graph = this.pluginDependents(owner, version)
    if (graph.severity === 'unresolved') {
      return [{ reason: 'dependency-unresolved', detail: 'dependency graph could not be verified' }]
    }
    if (graph.severity === 'hard') {
      const first = graph.dependents.find((item) => item.kind === 'hard')
      return [{
        reason: 'dependency-blocked',
        detail: first
          ? `${first.owner}@${first.version} requires ${first.requiredCapability}`
          : 'active hard dependents remain',
      }]
    }
    if (graph.severity === 'optional' && options.acknowledgeDependents !== true) {
      const named = graph.dependents.filter((item) => item.kind === 'optional').map((item) => `${item.owner}@${item.version}`)
      return [{ reason: 'optional-dependents', detail: named.join(', ') || 'optional dependents require acknowledgement' }]
    }
    return []
  }

  migrateAuthoringContract(credential: TrustedAuthorityCredential, candidateId: string): CandidateRecord {
    this.assertCredential(credential)
    const parent = this.workspace.get(candidateId)
    if (!isolatedRuntimeOwner(parent)) {
      throw new GovernanceContractError(`authoring-contract migration applies only to isolated generated candidates: ${candidateId}`)
    }
    if (parent.manifest.runtimeContractVersion === GENERATED_EXTENSION_API_V1) {
      throw new GovernanceContractError(`candidate ${candidateId} already has host authoring contract ${GENERATED_EXTENSION_API_V1}`)
    }
    const version = nextUnusedPatch(this.workspace, parent.owner, parent.version)
    const created = this.workspace.create({
      review: reviewFromRecord(parent),
      owner: parent.owner,
      version,
      baseVersion: undefined,
      provenance: { kind: parent.provenance.kind, origin: parent.provenance.origin },
      manifest: manifestInputFrom(parent, GENERATED_EXTENSION_API_V1),
    })
    for (const relative of this.workspace.listFiles(parent.id)) {
      if (relative === 'candidate.manifest.json') continue
      this.workspace.writeFile(created.id, relative, this.workspace.readFile(parent.id, relative))
    }
    this.workspace.writeFile(created.id, AUTHORING_CONTRACT_STAMP, `${JSON.stringify({
      version: GENERATED_EXTENSION_API_V1,
      hostOwned: true,
    }, null, 2)}\n`)
    this.workspace.setManifest(created.id, manifestInputFrom(parent, GENERATED_EXTENSION_API_V1))
    const validation = this.validation ?? asValidation(this.workspace)
    if (validation === undefined) {
      throw new GovernanceContractError('authoring-contract migration requires host candidate validation')
    }
    const report = validation.validate(created.id)
    if (!report.passed) {
      throw new GovernanceContractError(`authoring-contract migration failed validation: ${report.stages.filter((item) => item.status === 'failed' || item.status === 'blocked').map((item) => item.name).join(', ') || created.id}`)
    }
    return this.workspace.seal(created.id)
  }

  async remountCommittedGenerated(): Promise<string[]> {
    const fatal: string[] = []
    const withheld: string[] = []
    if (this.safeMode) return []
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
      if (!committed.has(key)) fatal.push(`inconsistent-active-owner:${key}`)
    }
    const verified: CandidateRecord[] = []
    for (const target of targets) {
      const candidate = this.workspace.list().find((item) => item.owner === target.owner && item.version === target.version)
      if (candidate === undefined) {
        fatal.push(`missing-active-artifact:${target.owner}@${target.version}`)
        continue
      }
      const integrity = this.verifySealedArtifact(candidate)
      if (integrity !== undefined) {
        fatal.push(integrity)
        continue
      }
      if (missingHostAuthoringContract(candidate)) {
        this.registry.transitionStatus(target.owner, target.version, 'disabled')
        withheld.push(`legacy-authoring-contract:${candidate.id}`)
        continue
      }
      verified.push(candidate)
    }
    if (fatal.length > 0) {
      await this.failClosedSafeMode([...fatal, ...withheld])
      return [...fatal, ...withheld]
    }
    if (withheld.length > 0) this.noteLegacyContractWithhold(withheld)
    for (const candidate of verified) {
      const prepared = await this.runtime.prepare(candidate.id, this.prepareContext(candidate))
      if (!prepared.ok) {
        const diagnostics = [...withheld, prepared.diagnostics ?? `prepare-failed:${candidate.id}`]
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
    if (withheld.length > 0) this.adoptVerifiedOperationalSnapshot()
    return withheld
  }

  private committedActivationSnapshot(): ActivationSnapshot | undefined {
    if (this.state === 'active' || this.state === 'rolled-back') return this.current ?? this.lastKnownGood
    return this.lastKnownGood
  }

  private noteLegacyContractWithhold(diagnostics: readonly string[]): void {
    this.lastFailure = {
      candidateId: this.pendingCandidateId ?? 'restart',
      version: '',
      digest: '',
      phase: 'prepare',
      diagnostics: `${diagnostics.join('; ')}; migrate with tars-ng self-extension migrate-authoring-contract <id>`,
      rollbackAttempted: false,
      rollbackSucceeded: false,
      safeModeRequired: false,
    }
  }

  /** Verified reduced snapshot after withholding unremountable legacy owners. Not a silent v1 stamp. */
  private adoptVerifiedOperationalSnapshot(): void {
    this.current = this.captureSnapshot()
    this.lastKnownGood = this.current
    this.rollbackTarget = this.current
    this.integrityVerified = true
    this.flush()
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
    await this.runtime.unloadGenerated()
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
    this.mutation = 'idle'
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
    await this.finishRollback(target, this.state === 'rollback-pending' ? 'active' : this.state)
  }

  private async finishRollback(target: ActivationSnapshot, priorState: ActivationState = 'active'): Promise<ActivationStatus> {
    const prior = this.current
    const priorLkg = this.lastKnownGood
    const priorTarget = this.rollbackTarget
    const priorSafe = this.safeMode
    const priorIntegrity = this.integrityVerified
    const priorFailure = this.lastFailure
    this.beginAuthorityCommit?.()
    try {
      const restored = await this.restoreSnapshot(target)
      if (!restored || this.failRollback?.phase === 'after-restore') {
        throw new Error(this.failRollback?.diagnostics ?? 'rollback restore failed')
      }
      await this.maybeInterrupt('rollback-registry-commit')
      if (this.failRollback?.phase === 'after-registry') throw new Error(this.failRollback.diagnostics)
      this.lastKnownGood = target
      this.current = target
      this.state = 'rolled-back'
      this.pendingCandidateId = undefined
      this.phase = undefined
      await this.remountCommittedGenerated()
      if (this.failRollback?.phase === 'after-remount') throw new Error(this.failRollback.diagnostics)
      this.current = this.captureSnapshot()
      this.integrityVerified = this.verifyRestoredIntegrity(target)
      if (!this.integrityVerified) throw new Error('rollback integrity failed')
      this.flush()
      this.finishAuthorityCommit?.()
      return this.status()
    } catch (error) {
      if (error instanceof SimulatedCrashError) throw error
      const recovered = await this.recoverPriorSnapshot(prior, {
        lastKnownGood: priorLkg,
        rollbackTarget: priorTarget,
        state: priorState,
        safeMode: priorSafe,
        integrityVerified: priorIntegrity,
        lastFailure: priorFailure,
      })
      this.flush()
      this.finishAuthorityCommit?.()
      if (recovered) throw error
      const diagnostics = error instanceof Error ? error.message : String(error)
      await this.failClosedSafeMode([diagnostics])
      this.lastFailure = {
        candidateId: this.pendingCandidateId ?? 'rollback',
        version: '',
        digest: '',
        phase: 'commit',
        diagnostics,
        rollbackAttempted: true,
        rollbackSucceeded: false,
        restoredLkgGeneration: target.generation,
        safeModeRequired: true,
      }
      this.flush()
      return this.status()
    }
  }

  private async recoverPriorSnapshot(
    prior: ActivationSnapshot | undefined,
    restore: {
      readonly lastKnownGood?: ActivationSnapshot
      readonly rollbackTarget?: ActivationSnapshot
      readonly state: ActivationState
      readonly safeMode: boolean
      readonly integrityVerified: boolean
      readonly lastFailure?: ActivationFailure
    },
  ): Promise<boolean> {
    if (prior === undefined) return false
    try {
      if (this.failRollbackRestore) throw new Error('rollback restore of prior snapshot failed')
      if (!await this.restoreSnapshot(prior)) return false
      this.current = prior
      this.lastKnownGood = restore.lastKnownGood
      this.rollbackTarget = restore.rollbackTarget
      this.state = restore.state
      this.safeMode = restore.safeMode
      this.integrityVerified = restore.integrityVerified
      this.lastFailure = restore.lastFailure
      return true
    } catch {
      return false
    }
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

  private compatibilityDenials(record: CandidateRecord): EligibilityDenial[] {
    const active = this.registry.list({ owner: record.owner, status: 'active' })[0]
    return [...evaluateActivationCompatibility({
      owner: record.owner,
      provenanceKind: record.provenance.kind,
      origin: record.provenance.origin,
      resolutionKind: record.manifest.resolutionKind,
      resolutionCapability: record.manifest.resolutionCapability,
      capabilities: record.manifest.capabilities,
      services: record.manifest.services,
      providers: record.manifest.providers,
      runtimeContractVersion: record.manifest.runtimeContractVersion,
      activeOwner: active === undefined
        ? undefined
        : {
          owner: active.owner,
          provenanceKind: active.provenance.kind,
          origin: active.provenance.origin,
          services: active.services,
          providers: active.providers,
        },
    }).denials]
  }

  private recordLastFailure(failure: ActivationFailure): void {
    this.lastFailure = failure
    this.emitActivationDiagnostic(
      `activation-failed candidate=${failure.candidateId} phase=${failure.phase} ${failure.diagnostics}`,
    )
  }

  private emitActivationDiagnostic(line: string): void {
    this.onActivationDiagnostic?.(boundActivationDiagnostics(line))
  }

  private async maybeInterrupt(point: ActivationInterrupt): Promise<void> {
    if (this.interruptAfter === point) throw new SimulatedCrashError(point)
  }

  private assertCredential(credential: TrustedAuthorityCredential): void {
    if (!(credential instanceof AuthorityCredential) || !credential.issuedBy(this.rootId)) {
      throw new GovernanceAuthorityError('approval/recovery action requires a credential issued by the recovery root')
    }
  }

  private candidateView(candidateId: string) {
    const record = this.workspace.get(candidateId)
    const diff = this.workspace.diff(candidateId)
    return { record, diff }
  }

  private facts(candidateId: string) {
    const { record, diff } = this.candidateView(candidateId)
    return { record, diff, fingerprint: fingerprintFromCandidate(record, diff) }
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
        const withheldBySafeMode = this.safeMode && this.registry.list({ owner: record.owner }).some((item) => (
          item.version === record.baseVersion
          && item.status === 'disabled'
          && isolatedRuntimeOwner(item)
        ))
        if (!withheldBySafeMode) {
          denials.push({
            reason: 'base-changed',
            detail: `no active owner for ${record.owner}; proposal assumed ${record.baseVersion}`,
          })
        }
      } else if (active.version !== record.baseVersion) {
        denials.push({ reason: 'base-changed', detail: `active base is ${active.version}, proposal assumed ${record.baseVersion}` })
      }
    }
    denials.push(...this.reviewDenials(record))
    denials.push(...this.compatibilityDenials(record))
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
    if (this.isRecoveryRequired()) {
      denials.push({ reason: 'recovery-required', detail: 'reactivation is blocked while recovery is required' })
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
    this.recordLastFailure({
      candidateId: failure.candidateId,
      version: record?.version ?? '',
      digest: record?.digest ?? '',
      phase: 'health',
      diagnostics: failure.diagnostics,
      rollbackAttempted: target !== undefined,
      rollbackSucceeded: false,
      restoredLkgGeneration: target?.generation,
      safeModeRequired: target === undefined,
    })
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
    if (restored) await this.remountCommittedGenerated()
    const recovered = restored && !this.safeMode
    this.recordLastFailure({
      candidateId: this.lastFailure?.candidateId ?? failure.candidateId,
      version: this.lastFailure?.version ?? record?.version ?? '',
      digest: this.lastFailure?.digest ?? record?.digest ?? '',
      phase: this.lastFailure?.phase ?? 'health',
      diagnostics: this.lastFailure?.diagnostics ?? failure.diagnostics,
      rollbackAttempted: true,
      rollbackSucceeded: recovered,
      restoredLkgGeneration: target.generation,
      safeModeRequired: !recovered,
    })
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
      pluginDependencies: [...(record.manifest.pluginDependencies ?? [])],
    }
  }

  private applyRegistryOwners(owners: ActivationSnapshot['owners']): void {
    for (const current of this.registry.list({ status: 'active' })) {
      const wanted = owners.some((item) => item.owner === current.owner && item.version === current.version)
      if (!wanted) this.registry.transitionStatus(current.owner, current.version, 'disabled')
    }
    for (const owner of owners) {
      const record = this.registry.get(owner.owner, owner.version)
      if (record !== undefined && record.status !== 'active') {
        this.registry.transitionStatus(owner.owner, owner.version, 'active')
      }
    }
  }

  private async restoreSnapshot(snapshot: ActivationSnapshot): Promise<boolean> {
    const priorOwners = ownersFromRegistry(this.registry)
    try {
      await this.runtime.restore(snapshot)
      this.applyRegistryOwners(snapshot.owners)
      return true
    } catch {
      try {
        this.applyRegistryOwners(priorOwners)
      } catch {
        return false
      }
      return false
    }
  }
}

function missingHostAuthoringContract(record: CandidateRecord): boolean {
  const generated = record.provenance.kind === 'generated'
    || record.provenance.kind === 'third-party'
    || record.owner.startsWith('generated/')
    || record.owner.startsWith('third-party/')
  return generated && record.manifest.runtimeContractVersion !== GENERATED_EXTENSION_API_V1
}

function asValidation(workspace: CandidateWorkspace): CandidateValidation | undefined {
  const candidate = workspace as CandidateWorkspace & Partial<CandidateValidation>
  return typeof candidate.validate === 'function' ? { validate: candidate.validate.bind(workspace) } : undefined
}

function manifestInputFrom(record: CandidateRecord, runtimeContractVersion: string): CandidateManifestInput {
  return {
    capabilities: [...record.manifest.capabilities],
    permissions: [...record.manifest.permissions],
    runtimeSeams: [...record.manifest.runtimeSeams],
    tools: [...record.manifest.tools],
    services: [...record.manifest.services],
    providers: [...record.manifest.providers],
    secrets: [...record.manifest.secrets],
    configRequired: [...record.manifest.configRequired],
    effects: record.manifest.effects,
    entryPoints: [...record.manifest.entryPoints],
    validationTasks: record.manifest.validationTasks,
    riskModel: record.manifest.riskModel,
    runtimeContractVersion,
    pluginDependencies: [...(record.manifest.pluginDependencies ?? [])],
  }
}

function reviewFromRecord(record: CandidateRecord) {
  return {
    kind: record.manifest.resolutionKind,
    capability: record.manifest.resolutionCapability,
    need: record.manifest.resolutionNeed,
    recommendation: 'Host migration revision for a missing authoring contract.',
    rationale: 'Pre-contract generated artifacts cannot remount until a human restamps and reapproves.',
    implications: [] as string[],
    assumptions: [] as string[],
    unresolved: [] as string[],
    steps: [] as never[],
    registryFacts: { exact: { kind: 'unknown' as const, capability: record.manifest.resolutionCapability }, domainOwners: [], conflicts: [] },
  }
}

function nextUnusedPatch(workspace: CandidateWorkspace, owner: string, version: string): string {
  let next = bumpPatch(version)
  const taken = new Set(workspace.list().filter((item) => item.owner === owner).map((item) => item.version))
  while (taken.has(next)) next = bumpPatch(next)
  return next
}

function bumpPatch(version: string): string {
  const parts = version.split('.')
  const last = Number(parts[parts.length - 1])
  if (!Number.isInteger(last)) throw new GovernanceContractError(`cannot bump version ${version}`)
  parts[parts.length - 1] = String(last + 1)
  return parts.join('.')
}
