import { isolatedRuntimeOwner } from '../generated-runtime/trust.js'
import { compareOwnerVersion, extensionLifecycleOf, isActivationRetryEligible } from './lifecycle.js'
import type { ExtensionRecord, WorkspaceSnapshotInput } from './types.js'

export function projectExtensions(input: WorkspaceSnapshotInput): readonly ExtensionRecord[] {
  const rows = new Map<string, ExtensionRecord>()
  for (const candidate of input.candidates ?? []) {
    const record = input.registry.find((item) => item.owner === candidate.owner && item.version === candidate.version)
    if (!isolatedRuntimeOwner({
      owner: candidate.owner,
      provenance: candidate.provenance ?? (record ? { kind: record.provenance } : undefined),
    })) continue
    const key = `${candidate.owner}@${candidate.version}`
    rows.set(key, rowFromCandidate(input, candidate))
  }
  for (const record of input.registry) {
    if (!isolatedRuntimeOwner({ owner: record.owner, provenance: { kind: record.provenance } })) continue
    const key = `${record.owner}@${record.version}`
    if (rows.has(key)) continue
    rows.set(key, rowFromRegistry(input, record))
  }
  return [...rows.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function rowFromCandidate(
  input: WorkspaceSnapshotInput,
  candidate: NonNullable<WorkspaceSnapshotInput['candidates']>[number],
): ExtensionRecord {
  const record = input.registry.find((item) => item.owner === candidate.owner && item.version === candidate.version)
  const approval = input.extensionApprovals?.find((item) => item.candidateId === candidate.id)
  const newer = newerAuthoritative(input, candidate.owner, candidate.version)
  const lifecycle = candidate.extensionLifecycle ?? extensionLifecycleOf({
    registryStatus: record?.status,
    decision: approval?.decision ?? candidate.governanceApproval,
    activationState: input.activation?.state,
    pendingCandidateId: input.activation?.pendingCandidateId,
    candidateId: candidate.id,
    lastFailureCandidateId: input.activation?.lastFailureCandidateId,
    eligibilityDenials: approval?.eligibilityDenials ?? candidate.requestDenials,
    newerAuthoritative: newer,
  })
  return {
    id: `ext-${candidate.owner}@${candidate.version}`,
    owner: candidate.owner,
    version: candidate.version,
    candidateId: candidate.id,
    digest: candidate.digest,
    provenance: record?.provenance ?? candidate.provenance?.kind ?? 'generated',
    ...(candidate.provenance?.origin ? { provenanceOrigin: candidate.provenance.origin } : {}),
    capabilities: [...(record?.capabilities ?? candidate.diff?.capabilities.added ?? [])],
    tools: [...(record?.tools ?? [])],
    lifecycle,
    registryStatus: record?.status ?? 'absent',
    mounted: input.activation?.mounted?.includes(candidate.id) === true,
    eligibilityOk: (approval?.eligibilityOk !== false) && (
      lifecycle === 'DISABLED_REACTIVATABLE'
      || lifecycle === 'APPROVED_NOT_ACTIVE'
      || isActivationRetryEligible({
        lifecycle,
        eligibilityOk: approval?.eligibilityOk,
        eligibilityDenials: approval?.eligibilityDenials ?? candidate.requestDenials,
        recoveryRequired: input.recoveryRequired,
        safeMode: input.safeMode,
      })
    ),
    eligibilityDenials: approval?.eligibilityDenials ?? candidate.requestDenials ?? [],
    newerAuthoritative: newer,
    reviewState: candidate.reviewState,
    validationPassed: candidate.validationPassed,
    approvalDecision: approval?.decision ?? candidate.governanceApproval,
  }
}

function rowFromRegistry(
  input: WorkspaceSnapshotInput,
  record: WorkspaceSnapshotInput['registry'][number],
): ExtensionRecord {
  const newer = newerAuthoritative(input, record.owner, record.version)
  const lifecycle = extensionLifecycleOf({
    registryStatus: record.status,
    newerAuthoritative: newer,
  })
  return {
    id: `ext-${record.owner}@${record.version}`,
    owner: record.owner,
    version: record.version,
    provenance: record.provenance,
    capabilities: [...record.capabilities],
    tools: [...(record.tools ?? [])],
    lifecycle,
    registryStatus: record.status,
    mounted: false,
    eligibilityOk: false,
    eligibilityDenials: lifecycle === 'DISABLED_BLOCKED' ? ['unknown-candidate'] : [],
    newerAuthoritative: newer,
  }
}

function newerAuthoritative(input: WorkspaceSnapshotInput, owner: string, version: string): boolean {
  return input.registry.some((item) => (
    item.owner === owner
    && item.status === 'active'
    && compareOwnerVersion(item.version, version) > 0
  ))
}
