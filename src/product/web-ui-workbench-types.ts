/** Browser-safe DTOs. Authority and runtime validation remain in the domain Workbench. */
export interface CapabilitySpecificationSummaryView {
  readonly id: string
  readonly revision: number
  readonly supersedesId?: string
  readonly capability: string
  readonly goal: string
  readonly status: string
  readonly digest: string
}

export interface CapabilitySpecificationView extends CapabilitySpecificationSummaryView {
  readonly version: string
  readonly source: 'explicit' | 'legacy'
  readonly nonGoals: readonly string[]
  readonly inputs: readonly { readonly name: string; readonly description: string; readonly required: boolean }[]
  readonly businessRules: readonly string[]
  readonly permissions: readonly string[]
  readonly effects: {
    readonly filesystem: readonly string[]
    readonly network: readonly string[]
    readonly process: readonly string[]
    readonly secrets: readonly string[]
    readonly externalSystems: readonly string[]
    readonly remoteSideEffect: 'none' | 'read-only' | 'mutate'
  }
  readonly acceptanceExamples: readonly {
    readonly name: string
    readonly given: readonly string[]
    readonly when: string
    readonly then: readonly string[]
    readonly fixture?: { readonly input: Readonly<Record<string, unknown>>; readonly expected: unknown }
  }[]
  readonly unresolved: readonly string[]
}

export interface CapabilityEvaluationView {
  readonly specificationId: string
  readonly specificationDigest: string
  readonly candidateId?: string
  readonly report?: {
    readonly status: 'passed' | 'failed' | 'unresolved' | 'not-applicable'
    readonly executed: number
    readonly summary: string
    readonly cases: readonly {
      readonly name: string
      readonly status: 'passed' | 'failed'
      readonly input: Readonly<Record<string, unknown>>
      readonly expected: unknown
      readonly actual?: unknown
      readonly error?: string
    }[]
  }
}

export interface CapabilitySpecificationDiffView {
  readonly from: { readonly id: string; readonly revision: number; readonly digest: string }
  readonly to: { readonly id: string; readonly revision: number; readonly digest: string }
  readonly changedFields: readonly string[]
  readonly changes: Readonly<Record<string, { readonly before: unknown; readonly after: unknown }>>
}

export interface CapabilitySpecificationRevisionInput {
  readonly goal?: string
  readonly nonGoals?: readonly string[]
  readonly businessRules?: readonly string[]
  readonly unresolved?: readonly string[]
}

export interface WorkbenchSnapshotView {
  readonly specifications: readonly CapabilitySpecificationSummaryView[]
  readonly plans: readonly unknown[]
  readonly candidates: readonly unknown[]
  readonly nextCursor?: string
  readonly mutable: boolean
}
