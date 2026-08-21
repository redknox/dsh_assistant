import type { SystemState } from '../personality/types.js'
import type { WorkspaceSnapshotInput } from './types.js'

export function deriveSystemState(input: WorkspaceSnapshotInput): SystemState {
  if (input.safeMode) return 'SAFE_MODE'
  if (input.recoveryRequired) return 'RECOVERY'
  if (input.blockedReason) return 'BLOCKED'
  if (input.pendingConfirmations.some((item) => item.status === 'pending')) return 'NEEDS_APPROVAL'
  if (input.integrationStatus.some((item) => !item.available)) return 'DEGRADED'
  if (input.agentStatus === 'running') return 'WORKING'
  if (input.jobs.some((job) => job.lastRunStatus === 'running' || job.lastRunStatus === 'pending')) return 'WAITING'
  return 'READY'
}
