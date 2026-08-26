export const SKILL_SCHEMA_VERSION = 1

export const SKILL_PROVENANCE_KINDS = ['system', 'assistant-authored', 'third-party'] as const
export type SkillProvenanceKind = (typeof SKILL_PROVENANCE_KINDS)[number]

export const SKILL_PROVENANCE_ORIGINS = ['host', 'assistant', 'import'] as const
export type SkillProvenanceOrigin = (typeof SKILL_PROVENANCE_ORIGINS)[number]

export interface SkillProvenance {
  readonly kind: SkillProvenanceKind
  readonly origin: SkillProvenanceOrigin
}

export const SKILL_LIFECYCLES = [
  'drafted',
  'imported',
  'validated',
  'sealed',
  'review-complete',
  'approval-requested',
  'approved',
  'active',
  'disabled',
  'uninstalled',
] as const
export type SkillLifecycle = (typeof SKILL_LIFECYCLES)[number]

export interface SkillInvocationPolicy {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

export interface SkillIdentity {
  readonly name: string
  readonly version: string
  readonly digest: string
  readonly provenance: SkillProvenance
  readonly profile: string
  readonly lifecycle: SkillLifecycle
  readonly invocation: SkillInvocationPolicy
}

export interface SkillRecord extends SkillIdentity {
  readonly id: string
  readonly sealed: boolean
  readonly validationPassed: boolean
  readonly reviewComplete: boolean
  readonly baseVersion?: string
  readonly approvalFingerprint?: string
  readonly approvalDecision?: 'unreviewed' | 'approval-requested' | 'approved-for-exact-diff' | 'rejected' | 'superseded'
  readonly resources: readonly string[]
  readonly description: string
  readonly whenToUse?: string
  readonly dependents: readonly string[]
}

export interface SkillIndex {
  readonly schemaVersion: typeof SKILL_SCHEMA_VERSION
  readonly profile: string
  readonly records: readonly SkillRecord[]
  readonly active: Record<string, string>
  readonly lastActive?: { readonly name: string; readonly version: string }
}

export interface SkillInspectSummary {
  readonly name: string
  readonly version: string
  readonly profile: string
  readonly lifecycle: SkillLifecycle
  readonly sealed: boolean
  readonly digest: string
  readonly provenance: SkillProvenance
  readonly invocation: SkillInvocationPolicy
  readonly validationPassed: boolean
  readonly reviewComplete: boolean
  readonly resources: readonly string[]
  readonly description: string
  readonly whenToUse?: string
  readonly baseVersion?: string
}

export interface SkillImportResult {
  readonly status: 'imported' | 'duplicate'
  readonly candidateId: string
  readonly name: string
  readonly version: string
  readonly provenance: SkillProvenance
  readonly lifecycle: SkillLifecycle
  readonly sealed: boolean
  readonly nextAction: 'validate'
}
