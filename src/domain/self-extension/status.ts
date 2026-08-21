import type { CandidateRecord } from '../candidate/types.js'
import type { ActivationStatus } from '../governance/types.js'
import type { RegistryRecord } from '../registry/types.js'

export interface OperatorStatus {
  readonly mode: 'normal' | 'safe-mode'
  readonly registryGeneration: number
  readonly active: readonly string[]
  readonly pendingCandidates: readonly string[]
  readonly validation: readonly string[]
  readonly approval: readonly string[]
  readonly activationState: string
  readonly currentDigest?: string
  readonly lkgGeneration?: number
  readonly lkgOwners: readonly string[]
  readonly lastFailure?: string
  readonly restartRecoveryRequired: boolean
}

export function operatorStatus(input: {
  readonly activation: ActivationStatus
  readonly registry: readonly RegistryRecord[]
  readonly candidates: readonly CandidateRecord[]
  readonly approvals?: ReadonlyMap<string, string>
}): OperatorStatus {
  const pending = input.activation.state === 'activation-pending' || input.activation.state === 'activating' || input.activation.state === 'rollback-pending'
  return {
    mode: input.activation.safeMode ? 'safe-mode' : 'normal',
    registryGeneration: input.activation.current?.generation ?? 0,
    active: input.registry.filter((record) => record.status === 'active').map((record) => `${record.owner}@${record.version}`),
    pendingCandidates: input.candidates.filter((record) => !record.sealed || record.lifecycle !== 'validated').map((record) => record.id),
    validation: input.candidates.map((record) => `${record.id}:${record.lifecycle}`),
    approval: input.candidates.map((record) => `${record.id}:${input.approvals?.get(record.id) ?? 'unreviewed'}`),
    activationState: input.activation.state,
    currentDigest: undefined,
    lkgGeneration: input.activation.lastKnownGood?.generation,
    lkgOwners: input.activation.lastKnownGood?.owners.map((item) => `${item.owner}@${item.version}`) ?? [],
    lastFailure: input.activation.lastFailure?.diagnostics,
    restartRecoveryRequired: pending || Boolean(input.activation.lastFailure?.safeModeRequired),
  }
}

export function formatOperatorStatus(status: OperatorStatus): string {
  return [
    `mode: ${status.mode}`,
    `registry-generation: ${status.registryGeneration}`,
    `activation: ${status.activationState}`,
    `active: ${status.active.join(', ') || '(none)'}`,
    `pending-candidates: ${status.pendingCandidates.join(', ') || '(none)'}`,
    `validation: ${status.validation.join(', ') || '(none)'}`,
    `lkg-generation: ${status.lkgGeneration ?? '(none)'}`,
    `lkg: ${status.lkgOwners.join(', ') || '(none)'}`,
    `last-failure: ${status.lastFailure ?? '(none)'}`,
    `restart-recovery-required: ${status.restartRecoveryRequired}`,
  ].join('\n')
}
