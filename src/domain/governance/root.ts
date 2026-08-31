import type { CapabilityRegistry } from '../registry/types.js'
import type { CandidateWorkspace } from '../candidate/types.js'
import { ReviewService, type IndependentReview } from '../review/index.js'
import { backupSelfExtension, restoreSelfExtension, type SelfExtensionBackupManifest } from '../self-extension/backup.js'
import type { SkillInterrupt, SkillService } from '../skill/service.js'
import { GovernanceAuthorityError, GovernanceContractError } from './errors.js'
import { InMemoryActivationRuntime, type ActivationRuntime } from './runtime.js'
import { GovernanceService, type ActivationInterrupt, type GovernanceHydrate } from './service.js'
import type {
  ApprovalAuthority,
  ExtensionActivation,
  ExtensionGovernance,
  ExtensionRecovery,
  TrustedApprovalInput,
} from './types.js'
import { TrustedAuthorityCredential } from './types.js'

/**
 * Bootstrap/control-plane handle. Not a Cordis service and not placed on `ctx`.
 * Ordinary plugins share `ctx` and cannot mint trusted credentials from it.
 */
export class RecoveryRoot {
  readonly service: GovernanceService
  readonly independentReview: IndependentReview
  private readonly rootId = Symbol('recovery-root')
  private readonly durableHome?: string
  private skills?: SkillService

  constructor(
    registry: CapabilityRegistry,
    workspace: CandidateWorkspace,
    runtime: ActivationRuntime = new InMemoryActivationRuntime(),
    options: {
      persist?: () => void
      hydrate?: GovernanceHydrate
      beginAuthorityCommit?: () => void
      finishAuthorityCommit?: () => void
      durableHome?: string
      independentReview?: IndependentReview
      validation?: import('../candidate/types.js').CandidateValidation
      onActivationDiagnostic?: (line: string) => void
    } = {},
  ) {
    this.independentReview = options.independentReview ?? new ReviewService(undefined, (id) => workspace.get(id), { hostLineage: true })
    this.service = new GovernanceService(registry, workspace, runtime, this.rootId, {
      ...options,
      independentReview: this.independentReview,
    })
    this.durableHome = options.durableHome
  }

  bindSkills(skills: SkillService): void {
    this.skills = skills
    skills.bindRoot(this.rootId)
  }

  approveSkill(id: string, fingerprint: string, credential: TrustedAuthorityCredential) {
    this.assertCredential(credential)
    return this.requireSkills().approve(id, fingerprint, credential)
  }

  activateSkill(id: string, credential: TrustedAuthorityCredential) {
    this.assertCredential(credential)
    return this.requireSkills().activate(id, credential)
  }

  disableSkill(name: string, credential: TrustedAuthorityCredential, acknowledgedDependents: readonly string[] = []) {
    this.assertCredential(credential)
    return this.requireSkills().disable(name, credential, acknowledgedDependents)
  }

  uninstallSkill(id: string, credential: TrustedAuthorityCredential, acknowledgedDependents: readonly string[] = []) {
    this.assertCredential(credential)
    return this.requireSkills().uninstall(id, credential, acknowledgedDependents)
  }

  rejectSkill(id: string, fingerprint: string, credential: TrustedAuthorityCredential) {
    this.assertCredential(credential)
    return this.requireSkills().reject(id, fingerprint, credential)
  }

  reactivateSkill(name: string, version: string, credential: TrustedAuthorityCredential) {
    this.assertCredential(credential)
    return this.requireSkills().reactivate(name, version, credential)
  }

  rollbackSkill(credential: TrustedAuthorityCredential) {
    this.assertCredential(credential)
    return this.requireSkills().rollback(credential)
  }

  simulateSkillInterrupt(point: SkillInterrupt) {
    this.requireSkills().interruptAfter = point
  }

  issueAuthority(authority: ApprovalAuthority): TrustedAuthorityCredential {
    if (authority.kind !== 'human-control') {
      throw new GovernanceAuthorityError('only human-control authority may be issued by the recovery root')
    }
    return new TrustedAuthorityCredential(this.rootId, authority)
  }

  recordApproval(credential: TrustedAuthorityCredential, input: TrustedApprovalInput) {
    return this.service.recordApproval(credential, input)
  }

  activate(candidateId: string, credential: TrustedAuthorityCredential) {
    return this.service.activate(candidateId, credential)
  }

  abandonFailedActivation(candidateId: string, fingerprint: string, credential: TrustedAuthorityCredential) {
    return this.service.abandonFailedActivation(candidateId, fingerprint, credential)
  }

  rollback(credential: TrustedAuthorityCredential) {
    return this.service.rollback(credential)
  }

  enterSafeMode(credential: TrustedAuthorityCredential) {
    return this.service.enterSafeMode(credential)
  }

  exitSafeMode(credential: TrustedAuthorityCredential) {
    return this.service.exitSafeMode(credential)
  }

  simulateInterrupt(point: ActivationInterrupt) {
    this.service.interruptAfter = point
  }

  remountCommittedGenerated() {
    return this.service.remountCommittedGenerated()
  }

  completeInterruptedActivation() {
    return this.service.completeInterruptedActivation()
  }

  completeInterruptedRollback() {
    return this.service.completeInterruptedRollback()
  }

  disable(credential: TrustedAuthorityCredential, owner: string, version: string) {
    return this.service.disable(credential, owner, version)
  }

  uninstall(
    credential: TrustedAuthorityCredential,
    owner: string,
    version: string,
    options: { readonly acknowledgeDependents?: boolean } = {},
  ) {
    return this.service.uninstall(credential, owner, version, options)
  }

  migrateAuthoringContract(credential: TrustedAuthorityCredential, candidateId: string) {
    return this.service.migrateAuthoringContract(credential, candidateId)
  }

  backup(credential: TrustedAuthorityCredential, dest: string): SelfExtensionBackupManifest {
    this.assertCredential(credential)
    if (this.durableHome === undefined || this.durableHome === '') {
      throw new GovernanceContractError('backup requires a durable assistant home')
    }
    return backupSelfExtension(this.durableHome, dest)
  }

  restore(credential: TrustedAuthorityCredential, source: string): void {
    this.assertCredential(credential)
    if (this.durableHome === undefined || this.durableHome === '') {
      throw new GovernanceContractError('restore requires a durable assistant home')
    }
    restoreSelfExtension(source, this.durableHome)
  }

  private requireSkills(): SkillService {
    if (this.skills === undefined) {
      throw new GovernanceContractError('skill lifecycle is not bound to the recovery root')
    }
    return this.skills
  }

  private assertCredential(credential: TrustedAuthorityCredential): void {
    if (!(credential instanceof TrustedAuthorityCredential) || !credential.issuedBy(this.rootId)) {
      throw new GovernanceAuthorityError('trusted action requires a credential issued by the recovery root')
    }
  }

  inspect() {
    return this.service.inspect()
  }

  governance(): ExtensionGovernance {
    return this.service
  }

  activation(): ExtensionActivation {
    return this.service
  }

  recovery(): ExtensionRecovery {
    return this.service
  }
}
