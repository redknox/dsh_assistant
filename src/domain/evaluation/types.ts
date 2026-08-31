export type EvaluationJson = null | boolean | number | string | readonly EvaluationJson[] | { readonly [key: string]: EvaluationJson }

export interface EvaluationFixture {
  readonly input: { readonly [key: string]: EvaluationJson }
  readonly expected: EvaluationJson
}

export interface CapabilityEvaluationCase {
  readonly name: string
  readonly input: { readonly [key: string]: EvaluationJson }
  readonly expected: EvaluationJson
}

export interface CapabilityEvaluationSuite {
  readonly version: 'capability-evaluation/v1'
  readonly specificationId: string
  readonly specificationDigest: string
  readonly capability: string
  readonly cases: readonly CapabilityEvaluationCase[]
}

export interface CapabilityEvaluationCaseResult extends CapabilityEvaluationCase {
  readonly status: 'passed' | 'failed'
  readonly actual?: EvaluationJson
  readonly error?: string
}

export interface CapabilityEvaluationReport {
  readonly version: 'capability-evaluation-report/v1'
  readonly candidateId: string
  readonly specificationId?: string
  readonly specificationDigest?: string
  readonly capability?: string
  readonly status: 'passed' | 'failed' | 'unresolved' | 'not-applicable'
  readonly executed: number
  readonly cases: readonly CapabilityEvaluationCaseResult[]
  readonly summary: string
}

export interface CapabilityEvaluationExecutorResult {
  readonly stdout: string
  readonly diagnostics?: string
  readonly unavailable?: boolean
}

export interface CapabilityEvaluationExecutor {
  run(workspaceRoot: string, runnerPath: string): CapabilityEvaluationExecutorResult
}

export interface EvaluationSpecificationInput {
  readonly id: string
  readonly digest: string
  readonly capability: string
  readonly acceptanceExamples: readonly {
    readonly name: string
    readonly fixture?: EvaluationFixture
  }[]
}
