import type { JobId, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { WorkflowDefinition, WorkflowRunRecord, WorkflowStatus } from './types.js'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    assistant: 'assistant'
  }
}

export class AssistantJobService {
  private readonly workflows = new Map<string, WorkflowDefinition>()
  private readonly runs = new Map<string, WorkflowRunRecord>()
  private nextRun = 1

  constructor(private readonly jobs: JobRegistry) {}

  register(workflow: WorkflowDefinition): void {
    this.workflows.set(workflow.name, workflow)
  }

  list(): WorkflowStatus[] {
    return [...this.workflows.values()].map((workflow) => ({
      name: workflow.name,
      title: workflow.title,
      recurrence: workflow.recurrence,
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

  start(name: string, input: Record<string, unknown> = {}): { runId: string; jobId: JobId } {
    const workflow = this.workflows.get(name)
    if (!workflow) throw new Error(`unknown workflow: ${name}`)
    const runId = `run-${this.nextRun++}`
    const controller = new AbortController()
    const jobId = this.jobs.start({
      kind: 'assistant',
      label: workflow.title,
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
    return { runId, jobId }
  }

  cancel(runId: string, reason = 'cancelled by caller'): 'requested' | 'already-finished' {
    const run = this.runs.get(runId)
    if (!run) throw new Error(`unknown run: ${runId}`)
    return this.jobs.kill(run.jobId, undefined, reason)
  }

  wait(runId: string, timeoutMs = 5000): Promise<WorkflowRunRecord> {
    const run = this.runs.get(runId)
    if (!run) return Promise.reject(new Error(`unknown run: ${runId}`))
    return this.jobs.wait(run.jobId, timeoutMs).then(() => {
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
