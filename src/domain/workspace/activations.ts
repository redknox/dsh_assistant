import type { ActivationCard, WorkspaceSnapshotInput } from './types.js'
import { activationCardId, compareOwnerVersion, extensionLifecycleOf, isActivationRetryEligible } from './lifecycle.js'

export function formatExactDiff(
  added: readonly string[],
  removed: readonly string[],
  changed: readonly string[] = [],
): string {
  const parts = [
    added.length > 0 ? `+${added.join(', ')}` : '',
    removed.length > 0 ? `−${removed.join(', ')}` : '',
    changed.length > 0 ? `~${changed.join(', ')}` : '',
  ].filter((item) => item !== '')
  return parts.join(' ') || 'none'
}

export function projectActivationCards(input: WorkspaceSnapshotInput): readonly ActivationCard[] {
  const cards: ActivationCard[] = []
  for (const approval of input.extensionApprovals ?? []) {
    if (approval.decision !== 'approved-for-exact-diff') continue
    const registryStatus = input.registry.find((item) => item.owner === approval.owner && item.version === approval.candidateVersion)?.status
    const lifecycle = extensionLifecycleOf({
      registryStatus,
      decision: approval.decision,
      activationState: input.activation?.state,
      pendingCandidateId: input.activation?.pendingCandidateId,
      candidateId: approval.candidateId,
      lastFailureCandidateId: input.activation?.lastFailureCandidateId,
      eligibilityDenials: approval.eligibilityDenials,
      newerAuthoritative: input.registry.some((item) => (
        item.owner === approval.owner
        && item.status === 'active'
        && compareOwnerVersion(item.version, approval.candidateVersion) > 0
      )),
    })
    if (lifecycle === 'ACTIVATION_FAILED') {
      if (input.activation?.generation === undefined) continue
      if (!isActivationRetryEligible({
        lifecycle,
        eligibilityOk: approval.eligibilityOk,
        eligibilityDenials: approval.eligibilityDenials,
        recoveryRequired: input.recoveryRequired,
        safeMode: input.safeMode,
      })) continue
    } else if (lifecycle !== 'APPROVED_NOT_ACTIVE' && lifecycle !== 'ACTIVATING' && lifecycle !== 'DISABLED_REACTIVATABLE') {
      continue
    }
    cards.push(selfExtensionActivationCard(approval, lifecycle, {
      generation: input.activation?.generation,
      failurePhase: input.activation?.lastFailure?.phase,
    }))
  }
  return cards
}

function selfExtensionActivationCard(
  approval: NonNullable<WorkspaceSnapshotInput['extensionApprovals']>[number],
  status: ActivationCard['status'],
  attempt?: { readonly generation?: number; readonly failurePhase?: string },
): ActivationCard {
  const eligibilityOk = approval.eligibilityOk !== false
  const denials = approval.eligibilityDenials ?? []
  const capabilitiesChanged = approval.capabilitiesChanged ?? []
  const permissionsChanged = approval.permissionsChanged ?? []
  const toolsChanged = approval.toolsChanged ?? []
  return {
    id: activationCardId(approval.id, status, attempt?.generation === undefined ? undefined : {
      generation: attempt.generation,
      failurePhase: attempt.failurePhase,
    }),
    kind: 'self-extension-activate',
    title: status === 'DISABLED_REACTIVATABLE'
      ? 'Reactivate extension'
      : status === 'ACTIVATION_FAILED'
        ? 'Retry activation'
        : 'SELF-EXTENSION ACTIVATION',
    owner: approval.owner,
    version: approval.candidateVersion,
    candidateId: approval.candidateId,
    digest: approval.digest,
    fingerprint: approval.fingerprint,
    runtimeContractVersion: approval.runtimeContractVersion,
    isolatedRuntime: true,
    capabilitiesAdded: approval.capabilitiesAdded,
    capabilitiesRemoved: approval.capabilitiesRemoved,
    capabilitiesChanged,
    permissionsAdded: approval.permissionsAdded,
    permissionsRemoved: approval.permissionsRemoved,
    permissionsChanged,
    toolsAdded: approval.toolsAdded ?? [],
    toolsRemoved: approval.toolsRemoved ?? [],
    toolsChanged,
    effects: approval.effects,
    eligibilityOk,
    eligibilityDenials: denials,
    status,
    details: [
      `Owner       ${approval.owner}@${approval.candidateVersion}`,
      `Candidate   ${approval.candidateId}`,
      `Digest      ${approval.digest}`,
      `Fingerprint ${approval.fingerprint}`,
      `Capabilities ${formatExactDiff(approval.capabilitiesAdded, approval.capabilitiesRemoved, capabilitiesChanged)}`,
      `Tools       ${formatExactDiff(approval.toolsAdded ?? [], approval.toolsRemoved ?? [], toolsChanged)}`,
      `Permissions ${formatExactDiff(approval.permissionsAdded, approval.permissionsRemoved, permissionsChanged)}`,
      `Effects     ${approval.effects.join('; ') || 'none'}`,
      `Contract    ${approval.runtimeContractVersion || 'unspecified'}`,
      'Generated code runs only in the isolated runner after this trusted activation.',
      eligibilityOk ? 'Eligible for trusted activation.' : `Not eligible: ${denials.join(', ') || 'denied'}`,
      status === 'DISABLED_REACTIVATABLE'
        ? 'This reactivates the exact disabled revision. It is not uninstall rollback and does not create a new version.'
        : status === 'ACTIVATION_FAILED'
          ? 'Previous trusted activation failed. This card rebinds the exact sealed digest and fingerprint after current eligibility is rechecked.'
          : 'Approval did not activate this candidate. Conversation yes cannot activate it.',
    ],
  }
}
