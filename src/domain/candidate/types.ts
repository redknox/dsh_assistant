import type { ReliabilityGateResult, RiskModel } from '../reliability/types.js'
import type { EvidenceLevel, ExtensionProvenance } from '../registry/types.js'
import type { ResolutionKind, ResolutionReview } from '../resolution/types.js'

export const CANDIDATE_LIFECYCLES = [
  'planned',
  'developing',
  'validation-pending',
  'validated',
  'validation-failed',
  'validation-incomplete',
] as const
export type CandidateLifecycle = (typeof CANDIDATE_LIFECYCLES)[number]

export const VALIDATION_STAGE_STATUSES = [
  'passed',
  'failed',
  'blocked',
  'not-applicable',
  'unresolved',
] as const
export type ValidationStageStatus = (typeof VALIDATION_STAGE_STATUSES)[number]

export const ALLOWED_VALIDATION_TASKS = [
  'manifest.validate',
  'package.inspect',
  'runtime.contract',
  'source.contract',
  'source.boundary',
  'typecheck',
  'tests',
  'bundle.inspect',
  'digest',
] as const
export type AllowedValidationTask = (typeof ALLOWED_VALIDATION_TASKS)[number]

export interface ValidationTaskRequest {
  readonly name: string
  readonly argv?: readonly string[]
  readonly script?: string
}

export const REMOTE_SIDE_EFFECTS = ['none', 'read-only', 'mutate'] as const
export type RemoteSideEffect = (typeof REMOTE_SIDE_EFFECTS)[number]

export interface OperationalEffects {
  readonly filesystem: readonly string[]
  readonly network: readonly string[]
  readonly process: readonly string[]
  readonly secrets: readonly string[]
  readonly externalSystems: readonly string[]
  /**
   * Authoritative remote side-effect class. Capability names are not this signal.
   * Omitted + network/credentials is stored as `mutate` (fail closed).
   * Only an explicit `read-only` declaration yields R1.
   */
  readonly remoteSideEffect: RemoteSideEffect
}

export interface CandidateManifest {
  readonly owner: string
  readonly version: string
  readonly provenance: ExtensionProvenance
  readonly baseVersion?: string
  readonly resolutionKind: ResolutionKind
  readonly resolutionCapability: string
  readonly resolutionNeed: string
  readonly capabilities: readonly string[]
  readonly permissions: readonly string[]
  readonly runtimeSeams: readonly string[]
  readonly tools: readonly string[]
  readonly services: readonly string[]
  readonly providers: readonly string[]
  readonly secrets: readonly string[]
  readonly configRequired: readonly string[]
  readonly effects: OperationalEffects
  readonly entryPoints: readonly string[]
  readonly validationTasks: readonly ValidationTaskRequest[]
  readonly riskModel?: RiskModel
  readonly runtimeContractVersion?: string
  readonly pluginDependencies?: readonly PluginCapabilityDependency[]
}

export const PLUGIN_DEPENDENCY_STRENGTHS = ['hard', 'optional'] as const
export type PluginDependencyStrength = (typeof PLUGIN_DEPENDENCY_STRENGTHS)[number]

export interface PluginCapabilityDependency {
  readonly capability: string
  readonly strength: PluginDependencyStrength
}

export interface CandidateManifestInput {
  readonly capabilities?: readonly string[]
  readonly permissions?: readonly string[]
  readonly runtimeSeams?: readonly string[]
  readonly tools?: readonly string[]
  readonly services?: readonly string[]
  readonly providers?: readonly string[]
  readonly secrets?: readonly string[]
  readonly configRequired?: readonly string[]
  readonly effects?: Partial<OperationalEffects>
  readonly entryPoints?: readonly string[]
  readonly validationTasks?: readonly ValidationTaskRequest[]
  readonly riskModel?: RiskModel
  readonly runtimeContractVersion?: string
  readonly pluginDependencies?: readonly PluginCapabilityDependency[]
}

export interface CandidateIdentity {
  readonly id: string
  readonly owner: string
  readonly version: string
  readonly baseVersion?: string
  readonly provenance: ExtensionProvenance
}

export interface CandidateRecord {
  readonly id: string
  readonly owner: string
  readonly version: string
  readonly baseVersion?: string
  readonly provenance: ExtensionProvenance
  readonly lifecycle: CandidateLifecycle
  readonly workspaceRoot: string
  readonly manifest: CandidateManifest
  readonly digest?: string
  readonly validation?: ValidationReport
  readonly sealed: boolean
}

export interface NamedDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: readonly string[]
}

export interface CandidateDiff {
  readonly owner: string
  readonly baseVersion?: string
  readonly candidateVersion: string
  readonly capabilities: NamedDiff
  readonly permissions: NamedDiff
  readonly tools: NamedDiff
  readonly services: NamedDiff
  readonly providers: NamedDiff
  readonly runtimeSeams: NamedDiff
  readonly effects: OperationalEffects
  readonly runtimeContractVersion?: string
}

export interface ValidationStageResult {
  readonly name: string
  readonly status: ValidationStageStatus
  readonly summary: string
  readonly startedAt: string
  readonly endedAt: string
  readonly evidence: EvidenceLevel
  readonly diagnostics?: string
}

export interface ValidationReport {
  readonly candidateId: string
  readonly digest: string
  readonly passed: boolean
  readonly stages: readonly ValidationStageResult[]
  readonly unresolved: readonly string[]
  readonly blocked: readonly string[]
  readonly reliability?: ReliabilityGateResult
}

export interface CreateCandidateInput {
  readonly review: ResolutionReview
  readonly owner: string
  readonly version: string
  readonly baseVersion?: string
  readonly provenance?: ExtensionProvenance
  readonly manifest?: CandidateManifestInput
  readonly files?: Readonly<Record<string, string>>
  readonly onAfterWriteFile?: (relativePath: string) => void
}

export interface CandidateWorkspace {
  create(input: CreateCandidateInput): CandidateRecord
  get(id: string): CandidateRecord
  list(): readonly CandidateRecord[]
  writeFile(id: string, relativePath: string, content: string): CandidateRecord
  readFile(id: string, relativePath: string): string
  listFiles(id: string): readonly string[]
  link(id: string, relativePath: string, target: string): never
  setManifest(id: string, manifest: CandidateManifestInput): CandidateRecord
  diff(id: string): CandidateDiff
  discard(id: string): void
  seal(id: string): CandidateRecord
}

export interface CandidateValidation {
  validate(id: string): ValidationReport
}
