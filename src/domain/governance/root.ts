import type { CapabilityRegistry } from '../registry/types.js'
import type { CandidateWorkspace } from '../candidate/types.js'
import { backupSelfExtension, restoreSelfExtension, type SelfExtensionBackupManifest } from '../self-extension/backup.js'
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
  private readonly rootId = Symbol('recovery-root')
  private readonly durableHome?: string

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
    } = {},
  ) {
    this.service = new GovernanceService(registry, workspace, runtime, this.rootId, options)
    this.durableHome = options.durableHome
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

  private assertCredential(credential: TrustedAuthorityCredential): void {
    if (!(credential instanceof TrustedAuthorityCredential) || !credential.issuedBy(this.rootId)) {
      throw new GovernanceAuthorityError('backup/restore requires a credential issued by the recovery root')
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
