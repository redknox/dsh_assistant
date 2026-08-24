/** Evidence vocabulary shared with README / ENGINEERING.md. */
export const EVIDENCE_LEVELS = [
  'Designed',
  'Implemented',
  'Verified',
  'Experimental',
  'Unknown',
  'Unsupported',
] as const
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]

export const LIFECYCLE_STATUSES = ['candidate', 'active', 'disabled', 'retired'] as const
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number]

export const APPROVAL_STATES = ['unreviewed', 'rejected', 'approved-for-this-diff'] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]

export const PROVENANCE_KINDS = ['managed', 'generated'] as const
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number]

export const PROVENANCE_ORIGINS = ['human', 'assistant', 'import'] as const
export type ProvenanceOrigin = (typeof PROVENANCE_ORIGINS)[number]

export interface ExtensionProvenance {
  readonly kind: ProvenanceKind
  readonly origin: ProvenanceOrigin
}

export interface PluginVersionId {
  readonly owner: string
  readonly version: string
}

export interface CapabilityClaim {
  readonly id: string
  readonly permissions: readonly string[]
}

export interface RegistryRecord {
  readonly owner: string
  readonly version: string
  readonly provenance: ExtensionProvenance
  readonly status: LifecycleStatus
  readonly evidence: EvidenceLevel
  readonly approval: ApprovalState
  readonly capabilities: readonly CapabilityClaim[]
  readonly permissions: readonly string[]
  readonly runtimeSeams: readonly string[]
  readonly provider?: string
  readonly tools: readonly string[]
  readonly services: readonly string[]
  readonly providers: readonly string[]
  readonly pluginDependencies: readonly { readonly capability: string; readonly strength: 'hard' | 'optional' }[]
}

export interface RegistryQuery {
  readonly owner?: string
  readonly status?: LifecycleStatus
  readonly capability?: string
  readonly provenanceKind?: ProvenanceKind
}

export type ActiveOwnerResolution =
  | { readonly kind: 'unknown'; readonly capability: string }
  | { readonly kind: 'inactive'; readonly capability: string; readonly records: readonly RegistryRecord[] }
  | { readonly kind: 'owner'; readonly capability: string; readonly record: RegistryRecord }
  | { readonly kind: 'conflict'; readonly capability: string; readonly records: readonly RegistryRecord[] }

export interface OwnershipConflict {
  readonly capability: string
  readonly records: readonly RegistryRecord[]
}

export interface RegistryRevisePatch {
  readonly capabilities?: readonly CapabilityClaim[]
  readonly permissions?: readonly string[]
  readonly provider?: string
  readonly providers?: readonly string[]
}

export interface RegistryRegisterInput {
  readonly owner: string
  readonly version: string
  readonly provenance: ExtensionProvenance
  readonly status?: LifecycleStatus
  readonly evidence: EvidenceLevel
  readonly capabilities: readonly CapabilityClaim[]
  readonly permissions?: readonly string[]
  readonly runtimeSeams: readonly string[]
  readonly provider?: string
  readonly tools?: readonly string[]
  readonly services?: readonly string[]
  readonly providers?: readonly string[]
  readonly pluginDependencies?: readonly { readonly capability: string; readonly strength: 'hard' | 'optional' }[]
}

export interface CapabilityRegistry {
  register(input: RegistryRegisterInput): RegistryRecord
  get(owner: string, version: string): RegistryRecord | undefined
  list(query?: RegistryQuery): readonly RegistryRecord[]
  resolveActiveOwner(capability: string): ActiveOwnerResolution
  listCapabilities(owner: string, version: string): readonly string[]
  conflicts(): readonly OwnershipConflict[]
  transitionStatus(owner: string, version: string, status: LifecycleStatus): RegistryRecord
  revise(owner: string, version: string, patch: RegistryRevisePatch): RegistryRecord
}
