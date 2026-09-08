export const DEVELOPMENT_EXECUTOR_IDS = ['native', 'codex', 'claude-code'] as const
export type DevelopmentExecutorId = (typeof DEVELOPMENT_EXECUTOR_IDS)[number]
export type ExternalDevelopmentExecutorId = Exclude<DevelopmentExecutorId, 'native'>

export interface DevelopmentExecutorAvailability {
  readonly id: DevelopmentExecutorId
  readonly label: string
  readonly available: boolean
  readonly detail: string
  readonly native: boolean
  readonly verification: 'built-in' | 'installed-unverified' | 'unavailable'
}

export interface DevelopmentTask {
  readonly candidateId: string
  readonly workspaceRoot: string
  readonly prompt: string
  readonly signal?: AbortSignal
}

export interface DevelopmentExecution {
  readonly exitCode: number | null
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
}

export interface DevelopmentRunResult {
  readonly runId: string
  readonly candidateId: string
  readonly executor: ExternalDevelopmentExecutorId
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly changedFiles: readonly string[]
  readonly durationMs: number
  readonly output: string
  readonly outputTruncated: boolean
  readonly rolledBack: boolean
  readonly next: string
}

export interface DevelopmentExecutorHub {
  inspect(): readonly DevelopmentExecutorAvailability[]
  develop(input: {
    readonly candidateId: string
    readonly executor: ExternalDevelopmentExecutorId
    readonly instructions?: string
    readonly signal?: AbortSignal
  }): Promise<DevelopmentRunResult>
}
