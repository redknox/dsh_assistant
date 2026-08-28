import type { JobId, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkflowDefinition, WorkflowRunRecord, WorkflowStatus } from './types.js'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    assistant: 'assistant'
  }
}

export class AssistantJobService {
  static readonly maxActivePerOwner = 4
  private readonly workflows = new Map<string, WorkflowDefinition>()
  private readonly runs = new Map<string, WorkflowRunRecord>()
  private readonly owners = new Map<string, Agent>()
  private nextRun = 1

  constructor(private readonly jobs: JobRegistry) {}

  register(workflow: WorkflowDefinition): void {
    this.workflows.set(workflow.name, workflow)
  }

  list(): WorkflowStatus[] {
    return [...this.workflows.values()].map((workflow) => ({
      name: workflow.name,
      title: workflow.title,
      schedule: workflow.schedule,
      intent: workflow.intent,
      lastRun: this.lastRun(workflow.name),
    }))
  }

  lastRun(workflow: string): WorkflowRunRecord | undefined {
    return [...this.runs.values()].reverse().find((run) => run.workflow === workflow)
  }

  getRun(runId: string): WorkflowRunRecord | undefined {
    return this.runs.get(runId)
  }

  start(name: string, input: Record<string, unknown> = {}, owner?: Agent): { runId: string; jobId: JobId } {
    const workflow = this.workflows.get(name)
    if (!workflow) throw new Error(`unknown workflow: ${name}`)
    if (owner) {
      const active = [...this.runs.values()].filter((run) => run.status === 'running' && this.owners.get(run.runId) === owner).length
      if (active >= AssistantJobService.maxActivePerOwner) {
        throw new Error(`a session may run at most ${AssistantJobService.maxActivePerOwner} registered workflows at once`)
      }
    }
    const runId = `run-${this.nextRun++}`
    const controller = new AbortController()
    const jobId = this.jobs.start({
      kind: 'assistant',
      label: workflow.title,
      outputLimitBytes: 64 * 1024,
      ...(owner ? { owner } : {}),
      run: () => {
        const done = this.execute(runId, workflow, controller.signal, input)
        return {
          cancel() {
            controller.abort()
          },
          done,
        }
      },
    })
    this.runs.set(runId, {
      runId,
      workflow: workflow.name,
      jobId,
      startedAt: new Date().toISOString(),
      status: 'running',
    })
    if (owner) this.owners.set(runId, owner)
    return { runId, jobId }
  }

  cancel(runId: string, reason = 'cancelled by caller'): 'requested' | 'already-finished' {
    const run = this.runs.get(runId)
    if (!run) throw new Error(`unknown run: ${runId}`)
    return this.jobs.kill(run.jobId, this.owners.get(runId), reason)
  }

  wait(runId: string, timeoutMs = 5000): Promise<WorkflowRunRecord> {
    const run = this.runs.get(runId)
    if (!run) return Promise.reject(new Error(`unknown run: ${runId}`))
    return this.jobs.wait(run.jobId, timeoutMs, this.owners.get(runId)).then(() => {
      const latest = this.runs.get(runId)
      if (!latest) throw new Error(`unknown run: ${runId}`)
      return latest
    })
  }

  private async execute(
    runId: string,
    workflow: WorkflowDefinition,
    signal: AbortSignal,
    input: Record<string, unknown>,
  ): Promise<JobOutcome> {
    try {
      const summary = await workflow.run({ signal, input })
      this.finish(runId, signal.aborted ? 'killed' : 'completed', summary)
      return {
        status: signal.aborted ? 'killed' : 'completed',
        detail: signal.aborted ? 'cancelled' : 'ok',
        output: summary,
      }
    } catch (error) {
      if (signal.aborted) {
        this.finish(runId, 'killed', undefined, 'cancelled')
        return { status: 'killed', detail: 'cancelled' }
      }
      this.finish(runId, 'failed', undefined, 'failed')
      return { status: 'failed', detail: 'failed' }
    }
  }

  private finish(runId: string, status: WorkflowRunRecord['status'], summary?: string, error?: string): void {
    const current = this.runs.get(runId)
    if (!current || current.status !== 'running') return
    this.runs.set(runId, {
      ...current,
      status,
      summary,
      error,
      finishedAt: new Date().toISOString(),
    })
  }
}
