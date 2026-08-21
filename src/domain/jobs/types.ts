import type { JobId } from '@deepseek-ai/dsh-jobs'

export type WorkflowSchedule =
  | { readonly kind: 'manual' }
  | { readonly kind: 'every'; readonly everyMs: number }

export type WorkflowIntent = 'read' | 'execute'
export type WorkflowRunStatus = 'running' | 'completed' | 'killed' | 'failed'

export interface WorkflowRunContext {
  readonly signal: AbortSignal
  readonly input: Record<string, unknown>
}

export interface WorkflowDefinition {
  readonly name: string
  readonly title: string
  readonly schedule: WorkflowSchedule
  readonly intent: WorkflowIntent
  run(context: WorkflowRunContext): Promise<string>
}

export interface WorkflowRunRecord {
  readonly runId: string
  readonly workflow: string
  readonly jobId: JobId
  readonly startedAt: string
  readonly finishedAt?: string
  readonly status: WorkflowRunStatus
  readonly summary?: string
  readonly error?: string
}

export interface WorkflowStatus {
  readonly name: string
  readonly title: string
  readonly schedule: WorkflowSchedule
  readonly nextRunAt?: string
  readonly intent: WorkflowIntent
  readonly lastRun?: WorkflowRunRecord
}
