import { humorSuppressed } from '../personality/effective.js'
import { projectActivity } from './activity.js'
import { projectActivationCards } from './activations.js'
import { projectApprovalCards } from './approvals.js'
import { projectUserCapabilities } from './capabilities.js'
import { sanitizeMissionControlView } from './redact.js'
import { deriveSystemState } from './state.js'
import type { MissionControlView, WorkObjectKind, WorkspaceSnapshotInput } from './types.js'

export function projectMissionControl(input: WorkspaceSnapshotInput): MissionControlView {
  const systemState = deriveSystemState(input)
  const approvals = projectApprovalCards(input)
  const activations = projectActivationCards(input)
  const jobsRunning = input.jobs.filter((job) => job.lastRunStatus === 'running' || job.lastRunStatus === 'pending').length
  const degraded = input.integrationStatus.filter((item) => !item.available).map((item) => item.capability)
  return sanitizeMissionControlView({
    identity: 'TARS-NG',
    systemState,
    ...(input.objective ? { objective: input.objective } : {}),
    conversation: input.conversation.map((item) => ({
      kind: workKind(item.kind),
      text: item.text,
    })),
    activity: projectActivity(input),
    approvals,
    activations,
    capabilities: projectUserCapabilities(input),
    memory: input.memory,
    knowledge: input.knowledge,
    ...(systemState === 'SAFE_MODE' || systemState === 'RECOVERY'
      ? {
          recovery: {
            why: input.recoveryWhy ?? 'Trusted core is available; generated capabilities are disabled.',
            disabled: generatedDisabled(input),
            actions: ['Diagnostics', 'Rollback', 'Exit Safe Mode', 'Disable candidate', 'Restore backup'],
          },
        }
      : {}),
    controlStrip: {
      pendingApprovals: input.pendingConfirmations.filter((item) => item.status === 'pending').length,
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
  })
}

function workKind(kind: 'user' | 'assistant' | 'tool_call' | 'tool_result'): WorkObjectKind {
  if (kind === 'user') return 'user-message'
  if (kind === 'assistant') return 'assistant-response'
  if (kind === 'tool_call') return 'tool-summary'
  return 'evidence'
}

function generatedDisabled(input: WorkspaceSnapshotInput): readonly string[] {
  return input.registry
    .filter((record) => record.provenance === 'generated')
    .map((record) => `${record.owner}@${record.version}`)
}
