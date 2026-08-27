import { isolatedRuntimeOwner } from '../generated-runtime/trust.js'
import type { CandidateRecord } from '../candidate/types.js'
import { ACTIVATION_STATES, type ActivationStatus } from '../governance/types.js'
import type { RegistryRecord } from '../registry/types.js'

export const OPERATOR_STATUS_SCHEMA_VERSION = 1

export interface OperatorStatus {
  readonly schemaVersion: typeof OPERATOR_STATUS_SCHEMA_VERSION
  readonly mode: 'normal' | 'safe-mode'
  readonly registryGeneration: number
  readonly active: readonly string[]
  readonly pendingCandidates: readonly string[]
  readonly validation: readonly string[]
  readonly approval: readonly string[]
  readonly activationState: ActivationStatus['state']
  readonly currentDigest?: string
  readonly currentFingerprint?: string
  readonly lkgGeneration?: number
  readonly lkgOwners: readonly string[]
  readonly lastFailure?: string
  readonly restartRecoveryRequired: boolean
  readonly persistence?: string
  readonly reasons: readonly string[]
  readonly thirdPartyImported: number
  readonly thirdPartyActive: number
  readonly thirdPartyFailed: number
  readonly skills?: {
    readonly profile: string
    readonly candidates: number
    readonly active: readonly string[]
    readonly disabled: readonly string[]
    readonly failed: readonly string[]
    readonly catalog: 'ok' | 'empty' | 'degraded' | 'withheld'
    readonly recoveryRequired?: boolean
    readonly catalogDetail?: string
  }
}

type OperatorSkills = NonNullable<OperatorStatus['skills']>

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function boundedString(value: unknown, maxLength = 4_096): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value)
    && value.length <= 1_000
    && value.every((item) => boundedString(item) !== undefined)
    ? [...value]
    : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function optionalString(row: Record<string, unknown>, key: string): string | undefined | null {
  const value = row[key]
  if (value === undefined) return undefined
  return boundedString(value) ?? null
}

/** Parse the independently persisted Skill health projection without trusting its source. */
export function parseOperatorSkills(value: unknown): OperatorSkills | undefined {
  const row = recordOf(value)
  if (!row) return undefined
  const candidates = count(row.candidates)
  const active = stringArray(row.active)
  const disabled = stringArray(row.disabled)
  const failed = stringArray(row.failed)
  const catalogDetail = optionalString(row, 'catalogDetail')
  if (
    boundedString(row.profile, 256) === undefined
    || candidates === undefined
    || active === undefined
    || disabled === undefined
    || failed === undefined
    || (row.catalog !== 'ok' && row.catalog !== 'empty' && row.catalog !== 'degraded' && row.catalog !== 'withheld')
    || (row.recoveryRequired !== undefined && typeof row.recoveryRequired !== 'boolean')
    || catalogDetail === null
  ) return undefined
  return {
    profile: row.profile as string,
    candidates,
    active,
    disabled,
    failed,
    catalog: row.catalog,
    ...(typeof row.recoveryRequired === 'boolean' ? { recoveryRequired: row.recoveryRequired } : {}),
    ...(catalogDetail !== undefined ? { catalogDetail } : {}),
  }
}

/** Fail-closed parser for Operator status crossing persistence or network seams. */
export function parseOperatorStatus(value: unknown): OperatorStatus | undefined {
  const row = recordOf(value)
  if (!row || row.schemaVersion !== OPERATOR_STATUS_SCHEMA_VERSION) return undefined
  const registryGeneration = count(row.registryGeneration)
  const active = stringArray(row.active)
  const pendingCandidates = stringArray(row.pendingCandidates)
  const validation = stringArray(row.validation)
  const approval = stringArray(row.approval)
  const lkgOwners = stringArray(row.lkgOwners)
  const reasons = stringArray(row.reasons)
  const thirdPartyImported = count(row.thirdPartyImported)
  const thirdPartyActive = count(row.thirdPartyActive)
  const thirdPartyFailed = count(row.thirdPartyFailed)
  const lkgGeneration = row.lkgGeneration === undefined ? undefined : count(row.lkgGeneration)
  const currentDigest = optionalString(row, 'currentDigest')
  const currentFingerprint = optionalString(row, 'currentFingerprint')
  const lastFailure = optionalString(row, 'lastFailure')
  const persistence = optionalString(row, 'persistence')
  const skills = row.skills === undefined ? undefined : parseOperatorSkills(row.skills)
  if (
    (row.mode !== 'normal' && row.mode !== 'safe-mode')
    || registryGeneration === undefined
    || active === undefined
    || pendingCandidates === undefined
    || validation === undefined
    || approval === undefined
    || !ACTIVATION_STATES.includes(row.activationState as ActivationStatus['state'])
    || lkgOwners === undefined
    || typeof row.restartRecoveryRequired !== 'boolean'
    || reasons === undefined
    || thirdPartyImported === undefined
    || thirdPartyActive === undefined
    || thirdPartyFailed === undefined
    || (row.lkgGeneration !== undefined && lkgGeneration === undefined)
    || currentDigest === null
    || currentFingerprint === null
    || lastFailure === null
    || persistence === null
    || (row.skills !== undefined && skills === undefined)
  ) return undefined
  return {
    schemaVersion: OPERATOR_STATUS_SCHEMA_VERSION,
    mode: row.mode,
    registryGeneration,
    active,
    pendingCandidates,
    validation,
    approval,
    activationState: row.activationState as ActivationStatus['state'],
    ...(currentDigest !== undefined ? { currentDigest } : {}),
    ...(currentFingerprint !== undefined ? { currentFingerprint } : {}),
    ...(lkgGeneration !== undefined ? { lkgGeneration } : {}),
    lkgOwners,
    ...(lastFailure !== undefined ? { lastFailure } : {}),
    restartRecoveryRequired: row.restartRecoveryRequired,
    ...(persistence !== undefined ? { persistence } : {}),
    reasons,
    thirdPartyImported,
    thirdPartyActive,
    thirdPartyFailed,
    ...(skills !== undefined ? { skills } : {}),
  }
}

function generatedActive(input: {
  readonly registry: readonly RegistryRecord[]
  readonly candidates: readonly CandidateRecord[]
}): CandidateRecord | undefined {
  return input.candidates.find((candidate) => input.registry.some((record) => (
    record.owner === candidate.owner
    && record.version === candidate.version
    && record.status === 'active'
    && isolatedRuntimeOwner(record)
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
  readonly skills?: OperatorStatus['skills']
}): OperatorStatus {
  const pending = input.activation.state === 'activation-pending' || input.activation.state === 'activating' || input.activation.state === 'rollback-pending'
  const reasons = input.reasons ?? []
  const activeGenerated = generatedActive(input)
  const thirdPartyCandidates = input.candidates.filter((item) => (
    item.provenance.kind === 'third-party' || item.owner.startsWith('third-party/')
  ))
  const thirdPartyActive = input.registry.filter((record) => (
    record.status === 'active'
    && (record.provenance.kind === 'third-party' || record.owner.startsWith('third-party/'))
  )).length
  const thirdPartyFailed = thirdPartyCandidates.filter((item) => (
    item.lifecycle === 'validation-failed' || item.lifecycle === 'validation-incomplete'
  )).length
  return {
    schemaVersion: OPERATOR_STATUS_SCHEMA_VERSION,
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
    restartRecoveryRequired: pending || input.activation.recoveryRequired || input.activation.safeMode || reasons.some((item) => (
      item.includes('missing-active-artifact')
      || item.includes('digest-mismatch')
      || item.includes('inconsistent-active-owner')
      || item.includes('unsupported')
    )),
    persistence: input.persistence,
    reasons,
    thirdPartyImported: thirdPartyCandidates.length,
    thirdPartyActive,
    thirdPartyFailed,
    ...(input.skills ? { skills: input.skills } : {}),
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
    `third-party-imported: ${status.thirdPartyImported}`,
    `third-party-active: ${status.thirdPartyActive}`,
    `third-party-failed: ${status.thirdPartyFailed}`,
    status.skills
      ? `skills: profile=${status.skills.profile} catalog=${status.skills.catalog} candidates=${status.skills.candidates} active=${status.skills.active.join(',') || '(none)'} disabled=${status.skills.disabled.join(',') || '(none)'} failed=${status.skills.failed.join(',') || '(none)'}${status.skills.recoveryRequired ? ' recovery-required=true' : ''}`
      : undefined,
  ].filter((item): item is string => item !== undefined).join('\n')
}
