import type { ActivationCard, WorkspaceSnapshotInput } from './types.js'
import { extensionLifecycleOf } from './lifecycle.js'

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
    })
    if (lifecycle !== 'APPROVED_NOT_ACTIVE' && lifecycle !== 'ACTIVATING') continue
    cards.push(selfExtensionActivationCard(approval, lifecycle))
  }
  return cards
}

function selfExtensionActivationCard(
  approval: NonNullable<WorkspaceSnapshotInput['extensionApprovals']>[number],
  status: ActivationCard['status'],
): ActivationCard {
  const eligibilityOk = approval.eligibilityOk !== false
  const denials = approval.eligibilityDenials ?? []
  return {
    id: approval.id,
    kind: 'self-extension-activate',
    title: 'SELF-EXTENSION ACTIVATION',
    owner: approval.owner,
    version: approval.candidateVersion,
    candidateId: approval.candidateId,
    digest: approval.digest,
    fingerprint: approval.fingerprint,
    runtimeContractVersion: approval.runtimeContractVersion,
    isolatedRuntime: true,
    capabilitiesAdded: approval.capabilitiesAdded,
    capabilitiesRemoved: approval.capabilitiesRemoved,
    permissionsAdded: approval.permissionsAdded,
    permissionsRemoved: approval.permissionsRemoved,
    toolsAdded: approval.toolsAdded ?? [],
    toolsRemoved: approval.toolsRemoved ?? [],
    effects: approval.effects,
    eligibilityOk,
    eligibilityDenials: denials,
    status,
    details: [
      `Owner       ${approval.owner}@${approval.candidateVersion}`,
      `Candidate   ${approval.candidateId}`,
      `Digest      ${approval.digest}`,
      `Fingerprint ${approval.fingerprint}`,
      `Capabilities +${approval.capabilitiesAdded.join(', ') || 'none'} −${approval.capabilitiesRemoved.join(', ') || 'none'}`,
      `Tools       +${(approval.toolsAdded ?? []).join(', ') || 'none'} −${(approval.toolsRemoved ?? []).join(', ') || 'none'}`,
      `Permissions +${approval.permissionsAdded.join(', ') || 'none'} −${approval.permissionsRemoved.join(', ') || 'none'}`,
      `Effects     ${approval.effects.join('; ') || 'none'}`,
      `Contract    ${approval.runtimeContractVersion || 'unspecified'}`,
      'Generated code runs only in the isolated runner after this trusted activation.',
      eligibilityOk ? 'Eligible for trusted activation.' : `Not eligible: ${denials.join(', ') || 'denied'}`,
      'Approval did not activate this candidate. Conversation yes cannot activate it.',
    ],
  }
}
