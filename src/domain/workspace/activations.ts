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
  if (!input.safeMode && !input.recoveryRequired && input.skillCatalog?.state !== 'withheld') {
    for (const skill of input.skills ?? []) {
      if (!skill.system && skill.lifecycle === 'approved') cards.push(skillActivationCard(skill))
    }
  }
  return cards
}

function skillActivationCard(skill: NonNullable<WorkspaceSnapshotInput['skills']>[number]): ActivationCard {
  const invocation = [
    skill.modelInvocable ? 'model' : '',
    skill.userInvocable ? 'user' : '',
  ].filter(Boolean).join(' + ') || 'not invocable'
  const resources = skill.resources.join(', ') || 'none'
  const dependencies = skill.dependsOn.join(', ') || 'none'
  return {
    id: `skill-activation:${skill.id}:${skill.generation}`,
    kind: 'skill-activate',
    title: 'SKILL ACTIVATION',
    owner: `skill/${skill.name}`,
    version: skill.version,
    candidateId: skill.id,
    digest: skill.digest,
    fingerprint: skill.approvalFingerprint ?? skill.digest,
    isolatedRuntime: false,
    capabilitiesAdded: [],
    capabilitiesRemoved: [],
    capabilitiesChanged: [],
    permissionsAdded: [],
    permissionsRemoved: [],
    permissionsChanged: [],
    toolsAdded: [],
    toolsRemoved: [],
    toolsChanged: [],
    workflowsAdded: [],
    workflowsRemoved: [],
    workflowsChanged: [],
    effects: [],
    eligibilityOk: true,
    eligibilityDenials: [],
    status: 'APPROVED_NOT_ACTIVE',
    skill: {
      id: skill.id,
      name: skill.name,
      version: skill.version,
      digest: skill.digest,
      approvalFingerprint: skill.approvalFingerprint,
      generation: skill.generation,
    },
    details: [
      `Skill       ${skill.name}@${skill.version}`,
      `Digest      ${skill.digest}`,
      `Generation  ${skill.generation}`,
      `Invocation  ${invocation}`,
      `Resources   ${resources}`,
      `Depends on  ${dependencies}`,
      'Approval did not activate this Skill. Activation publishes the exact approved instructions to the active catalog.',
    ],
    release: {
      request: `Put ${titleCase(skill.name)} online`,
      stage: 'ready',
      reason: 'Approval accepts this exact instruction package, but activation is the separate decision that makes it available to the assistant and user.',
      outcome: `The exact approved Skill will become live with ${invocation} invocation.`,
      scope: `${skill.name}@${skill.version} · exact digest · catalog generation ${skill.generation} · reversible`,
      facts: [
        { label: 'PURPOSE', value: skill.description },
        { label: 'INVOCATION', value: invocation },
        { label: 'RESOURCES', value: resources },
        { label: 'DEPENDENCIES', value: dependencies },
      ],
    },
  }
}

function titleCase(value: string): string {
  return value.split(/[-_]/).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ')
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
  const workflowsChanged = approval.workflowsChanged ?? []
  const capabilityDiff = formatExactDiff(approval.capabilitiesAdded, approval.capabilitiesRemoved, capabilitiesChanged)
  const toolDiff = formatExactDiff(approval.toolsAdded ?? [], approval.toolsRemoved ?? [], toolsChanged)
  const workflowDiff = formatExactDiff(approval.workflowsAdded ?? [], approval.workflowsRemoved ?? [], workflowsChanged)
  const permissionDiff = formatExactDiff(approval.permissionsAdded, approval.permissionsRemoved, permissionsChanged)
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
    workflowsAdded: approval.workflowsAdded ?? [],
    workflowsRemoved: approval.workflowsRemoved ?? [],
    workflowsChanged,
    effects: approval.effects,
    eligibilityOk,
    eligibilityDenials: denials,
    status,
    details: [
      `Owner       ${approval.owner}@${approval.candidateVersion}`,
      `Candidate   ${approval.candidateId}`,
      `Digest      ${approval.digest}`,
      `Fingerprint ${approval.fingerprint}`,
      `Capabilities ${capabilityDiff}`,
      `Tools       ${toolDiff}`,
      `Workflows   ${workflowDiff}`,
      `Permissions ${permissionDiff}`,
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
    release: {
      request: releaseRequest(status, approval.owner),
      stage: !eligibilityOk
        ? 'blocked'
        : status === 'DISABLED_REACTIVATABLE'
          ? 'reactivate'
          : status === 'ACTIVATION_FAILED'
            ? 'retry'
            : status === 'ACTIVATING' ? 'working' : 'ready',
      reason: status === 'DISABLED_REACTIVATABLE'
        ? 'This exact revision was previously disabled. Returning it to service is a separate trusted decision.'
        : status === 'ACTIVATION_FAILED'
          ? 'The previous activation attempt failed. Retry is available only after the host rechecks the sealed artifact and current eligibility.'
          : 'Review and approval authorize this exact revision, but only this separate trusted action can put it into service.',
      outcome: releaseOutcome(capabilityDiff, toolDiff, workflowDiff),
      scope: `${approval.owner}@${approval.candidateVersion} · isolated runtime · exact digest · reversible`,
      facts: [
        { label: 'CAPABILITIES', value: capabilityDiff },
        { label: 'TOOLS', value: toolDiff },
        { label: 'WORKFLOWS', value: workflowDiff },
        { label: 'PERMISSIONS', value: permissionDiff },
        { label: 'EFFECTS', value: approval.effects.join('; ') || 'None declared' },
      ],
    },
  }
}

function releaseRequest(status: ActivationCard['status'], owner: string): string {
  const name = owner.split('/').at(-1)?.split('-').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ') || owner
  if (status === 'DISABLED_REACTIVATABLE') return `Bring ${name} back online`
  if (status === 'ACTIVATION_FAILED') return `Retry ${name} activation`
  return `Put ${name} online`
}

function releaseOutcome(capabilities: string, tools: string, workflows: string): string {
  const surfaces = [
    capabilities !== 'none' ? `capabilities ${capabilities}` : '',
    tools !== 'none' ? `tools ${tools}` : '',
    workflows !== 'none' ? `workflows ${workflows}` : '',
  ].filter(Boolean)
  return surfaces.length > 0
    ? `The isolated revision will become live and publish ${surfaces.join('; ')}.`
    : 'The exact isolated revision will become the active version for its owner.'
}
