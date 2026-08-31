import { humorSuppressed } from '../personality/effective.js'
import { projectActivity } from './activity.js'
import { projectActivationCards } from './activations.js'
import { projectApprovalCards, projectApprovalResolutions } from './approvals.js'
import { projectUserCapabilities } from './capabilities.js'
import { projectExtensions } from './extensions.js'
import { projectUserPlugins } from './plugins.js'
import { projectRollbackCard } from './rollback.js'
import { projectSkills } from './skills.js'
import { sanitizeMissionControlView } from './redact.js'
import { deriveSystemState } from './state.js'
import type { MissionControlView, WorkObjectKind, WorkspaceSnapshotInput } from './types.js'

export function projectMissionControl(input: WorkspaceSnapshotInput): MissionControlView {
  const systemState = deriveSystemState(input)
  const approvals = projectApprovalCards(input)
  const approvalResolutions = projectApprovalResolutions(input)
  const activations = projectActivationCards(input)
  const jobsRunning = input.jobs.filter((job) => job.lastRunStatus === 'running' || job.lastRunStatus === 'pending').length
  const degraded = input.integrationStatus.filter((item) => !item.available && item.configured !== false).map((item) => item.capability)
  if (input.skillCatalog?.state === 'degraded') degraded.push('skill catalog')
  const activationFailure = projectActivationFailure(input)
  const rollback = projectRollbackCard(input, systemState)
  const brief = input.jobs.find((job) => job.name === 'morning-brief')
  return sanitizeMissionControlView({
    identity: 'TARS-NG',
    systemState,
    ...(input.objective ? { objective: input.objective } : {}),
    ...(input.taskControl ? { taskControl: input.taskControl } : {}),
    conversation: input.conversation.filter(isDialogueItem).map((item) => ({
      kind: workKind(item.kind),
      text: item.text,
    })),
    activity: projectActivity(input),
    executionLog: input.executionLog ?? [],
    approvals,
    approvalResolutions,
    activations,
    plugins: projectUserPlugins(input),
    extensions: projectExtensions(input),
    skills: projectSkills(input),
    ...(input.skillCatalog ? { skillCatalog: input.skillCatalog } : {}),
    ...(input.skillRollback ? { skillRollback: input.skillRollback } : {}),
    ...(rollback ? { rollback } : {}),
    capabilities: projectUserCapabilities(input),
    memory: input.memory,
    knowledge: input.knowledge,
    ...(brief
      ? {
          workBrief: {
            status: brief.lastRunStatus ?? 'idle',
            ...(brief.lastRunId ? { runId: brief.lastRunId } : {}),
            ...(brief.lastRunFinishedAt ? { generatedAt: brief.lastRunFinishedAt } : {}),
            ...(brief.lastRunStatus === 'completed' && brief.lastRunSummary ? { markdown: brief.lastRunSummary } : {}),
          },
        }
      : {}),
    ...(input.contextEndurance ? { contextEndurance: input.contextEndurance } : {}),
    ...(input.materialInput ? { materialInput: input.materialInput } : {}),
    ...(systemState === 'SAFE_MODE' || systemState === 'RECOVERY'
      ? {
          recovery: {
            why: input.recoveryWhy ?? 'Trusted core is available; generated capabilities are disabled.',
            disabled: generatedDisabled(input),
            actions: ['Diagnostics', 'Rollback', 'Exit Safe Mode', 'Disable candidate', 'Restore backup'],
            exitReady: input.safeMode
              && !input.recoveryRequired
              && input.activation?.rollbackPlan?.denials.some((item) => item.reason === 'already-restored') === true,
          },
        }
      : {}),
    controlStrip: {
      pendingApprovals: input.pendingConfirmations.filter((item) => item.status === 'pending').length
        + (input.dshApprovals ?? []).filter((item) => item.status === 'pending').length,
      backgroundJobs: jobsRunning,
      ...(input.objective ? { objective: input.objective.text } : {}),
      ...(degraded.length > 0 ? { degradation: `${degraded.join(', ')} unavailable` } : {}),
      mode: systemState,
    },
    personality: {
      ...input.personality,
      humorSuppressed: humorSuppressed({ kind: systemState === 'SAFE_MODE' || systemState === 'RECOVERY' ? 'safety' : 'normal', systemState }),
    },
    developmentControlPlaneSeparated: true,
    ...(input.candidates ? { candidates: input.candidates } : {}),
    ...(activationFailure ? { activationFailure } : {}),
    ...(input.runtimeContext ? { runtimeContext: input.runtimeContext } : {}),
    ...(input.sessions ? { sessions: input.sessions } : {}),
  })
}

function projectActivationFailure(input: WorkspaceSnapshotInput): MissionControlView['activationFailure'] {
  const failure = input.activation?.lastFailure
  if (!failure || input.activation?.state !== 'activation-failed') return undefined
  const approval = input.extensionApprovals?.find((item) => item.candidateId === failure.candidateId)
  const registryActive = input.registry.some((item) => (
    item.status === 'active'
    && (approval
      ? item.owner === approval.owner && item.version === approval.candidateVersion
      : false)
  ))
  return {
    candidateId: failure.candidateId,
    phase: failure.phase,
    summary: failure.diagnostics,
    rollbackSucceeded: failure.rollbackSucceeded,
    recoveryRequired: input.recoveryRequired,
    registryActive,
  }
}

function isDialogueItem(item: WorkspaceSnapshotInput['conversation'][number]): item is WorkspaceSnapshotInput['conversation'][number] & { readonly kind: 'user' | 'assistant' } {
  return item.kind === 'user' || item.kind === 'assistant'
}

function workKind(kind: 'user' | 'assistant'): WorkObjectKind {
  if (kind === 'user') return 'user-message'
  return 'assistant-response'
}

function generatedDisabled(input: WorkspaceSnapshotInput): readonly string[] {
  return input.registry
    .filter((record) => record.provenance === 'generated' || record.provenance === 'third-party')
    .map((record) => `${record.owner}@${record.version}`)
}
