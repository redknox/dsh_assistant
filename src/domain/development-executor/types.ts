export const DEVELOPMENT_EXECUTOR_IDS = ['native', 'codex', 'claude-code'] as const
export type DevelopmentExecutorId = (typeof DEVELOPMENT_EXECUTOR_IDS)[number]
export type ExternalDevelopmentExecutorId = Exclude<DevelopmentExecutorId, 'native'>

export interface DevelopmentExecutorAvailability {
  readonly id: DevelopmentExecutorId
  readonly label: string
  readonly available: boolean
  /** True when a provider route is configured well enough to attempt execution. */
  readonly executionReady: boolean
  readonly detail: string
  readonly native: boolean
  readonly verification: 'built-in' | 'authenticated' | 'custom-route-configured' | 'execution-verified' | 'installed-unverified' | 'authentication-failed' | 'unavailable'
  /** Provider account login only; custom routes may be ready without it. */
  readonly authenticated: boolean
  readonly route: 'built-in' | 'provider-account' | 'custom-provider' | 'none'
}

export interface DevelopmentTask {
  readonly runId: string
  readonly candidateId: string
  readonly workspaceRoot: string
  readonly prompt: string
  readonly signal?: AbortSignal
  readonly onSpawn?: (pid: number) => void
  readonly onProgress?: (bytes: number) => void
}

export interface DevelopmentExecution {
  readonly exitCode: number | null
  readonly termination: 'exited' | 'cancelled' | 'timed-out'
  readonly output: string
  readonly truncated: boolean
  readonly durationMs: number
}

/** Replaceable implementation seam. It can author files, but owns no governance authority. */
export interface DevelopmentExecutor {
  readonly id: ExternalDevelopmentExecutorId
  readonly label: string
  inspect(): DevelopmentExecutorAvailability
  execute(task: DevelopmentTask): Promise<DevelopmentExecution>
  terminateOrphan?(run: Pick<DevelopmentRun, 'pid' | 'startedAt'>): boolean
}

export type DevelopmentRunStatus = 'preparing' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'interrupted'

export interface DevelopmentRun {
  readonly runId: string
  readonly candidateId: string
  readonly executor: ExternalDevelopmentExecutorId
  readonly status: DevelopmentRunStatus
  readonly startedAt: string
  readonly updatedAt: string
  readonly finishedAt?: string
  readonly pid?: number
  readonly progressBytes: number
  readonly changedFiles: readonly string[]
  readonly durationMs?: number
  readonly output?: string
  readonly outputTruncated: boolean
  readonly rolledBack: boolean
  readonly detail: string
}

/** Internal persistence seam. Implementations own both run metadata and pre-run workspace snapshots. */
export interface DevelopmentRunStore {
  list(): readonly DevelopmentRun[]
  save(run: DevelopmentRun): void
  stageSnapshot(runId: string, workspaceRoot: string): void
  restoreSnapshot(runId: string, workspaceRoot: string): void
  discardSnapshot(runId: string): void
}

export interface DevelopmentRunResult {
  readonly runId: string
  readonly candidateId: string
  readonly executor: ExternalDevelopmentExecutorId
  readonly status: Extract<DevelopmentRunStatus, 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'interrupted'>
  readonly changedFiles: readonly string[]
  readonly durationMs: number
  readonly output: string
  readonly outputTruncated: boolean
  readonly rolledBack: boolean
  readonly next: string
}

export interface DevelopmentExecutorHub {
  inspect(): readonly DevelopmentExecutorAvailability[]
  runs(input?: { readonly candidateId?: string; readonly limit?: number }): readonly DevelopmentRun[]
  cancel(runId: string): DevelopmentRun
  develop(input: {
    readonly candidateId: string
    readonly executor: ExternalDevelopmentExecutorId
    readonly instructions?: string
    readonly signal?: AbortSignal
  }): Promise<DevelopmentRunResult>
}
