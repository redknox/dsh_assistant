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
  readonly currentFingerprint?: string
  readonly lkgGeneration?: number
  readonly lkgOwners: readonly string[]
  readonly lastFailure?: string
  readonly restartRecoveryRequired: boolean
  readonly persistence?: string
  readonly reasons: readonly string[]
}

function generatedActive(input: {
  readonly registry: readonly RegistryRecord[]
  readonly candidates: readonly CandidateRecord[]
}): CandidateRecord | undefined {
  return input.candidates.find((candidate) => input.registry.some((record) => (
    record.owner === candidate.owner
    && record.version === candidate.version
    && record.status === 'active'
    && record.owner.startsWith('generated/')
  )))
}

export function operatorStatus(input: {
  readonly activation: ActivationStatus
  readonly registry: readonly RegistryRecord[]
  readonly candidates: readonly CandidateRecord[]
  readonly approvals?: ReadonlyMap<string, string>
  readonly fingerprints?: ReadonlyMap<string, string>
  readonly persistence?: string
  readonly reasons?: readonly string[]
}): OperatorStatus {
  const pending = input.activation.state === 'activation-pending' || input.activation.state === 'activating' || input.activation.state === 'rollback-pending'
  const reasons = input.reasons ?? []
  const activeGenerated = generatedActive(input)
  return {
    mode: input.activation.safeMode ? 'safe-mode' : 'normal',
    registryGeneration: input.activation.current?.generation ?? 0,
    active: input.registry.filter((record) => record.status === 'active').map((record) => `${record.owner}@${record.version}`),
    pendingCandidates: input.candidates.filter((record) => !record.sealed || record.lifecycle !== 'validated').map((record) => record.id),
    validation: input.candidates.map((record) => `${record.id}:${record.lifecycle}`),
    approval: input.candidates.map((record) => `${record.id}:${input.approvals?.get(record.id) ?? 'unreviewed'}`),
    activationState: input.activation.state,
    currentDigest: activeGenerated?.digest,
    currentFingerprint: activeGenerated === undefined ? undefined : input.fingerprints?.get(activeGenerated.id),
    lkgGeneration: input.activation.lastKnownGood?.generation,
    lkgOwners: input.activation.lastKnownGood?.owners.map((item) => `${item.owner}@${item.version}`) ?? [],
    lastFailure: input.activation.lastFailure?.diagnostics,
    restartRecoveryRequired: pending || Boolean(input.activation.lastFailure?.safeModeRequired) || input.activation.safeMode || reasons.some((item) => (
      item.includes('missing-active-artifact')
      || item.includes('digest-mismatch')
      || item.includes('inconsistent-active-owner')
      || item.includes('unsupported')
    )),
    persistence: input.persistence,
    reasons,
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
    `current-digest: ${status.currentDigest ?? '(none)'}`,
    `current-fingerprint: ${status.currentFingerprint ?? '(none)'}`,
    `lkg-generation: ${status.lkgGeneration ?? '(none)'}`,
    `lkg: ${status.lkgOwners.join(', ') || '(none)'}`,
    `last-failure: ${status.lastFailure ?? '(none)'}`,
    `persistence: ${status.persistence ?? '(none)'}`,
    `reasons: ${status.reasons.join('; ') || '(none)'}`,
    `restart-recovery-required: ${status.restartRecoveryRequired}`,
  ].join('\n')
}
