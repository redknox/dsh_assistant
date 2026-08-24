import type { DiscoveryFacts } from '../discovery/types.js'
import type {
  ActiveOwnerResolution,
  OwnershipConflict,
  RegistryQuery,
  RegistryRecord,
} from '../registry/types.js'

/** Read-only registry facts. The resolver must not register, approve, or change lifecycle. */
export interface RegistryReadModel {
  resolveActiveOwner(capability: string): ActiveOwnerResolution
  list(query?: RegistryQuery): readonly RegistryRecord[]
  conflicts(): readonly OwnershipConflict[]
}

export const RESOLUTION_KINDS = [
  'reuse',
  'configure',
  'evolve-owner',
  'adopt-existing',
  'implement-provider',
  'new-plugin',
  'host-product-change-required',
  'insufficient-information',
  'conflict',
] as const
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number]

export const RESOLUTION_OPTIONS = [
  'reuse',
  'configure',
  'evolve-owner',
  'adopt-existing',
  'implement-provider',
  'new-plugin',
] as const
export type ResolutionOption = (typeof RESOLUTION_OPTIONS)[number]

export interface PermissionOption {
  readonly owner: string
  readonly permission: string
  readonly satisfiesNeed: boolean
}

export interface KnownPluginOption {
  readonly owner: string
  readonly version?: string
  readonly capabilities: readonly string[]
}

export interface KnownProviderOption {
  readonly provider: string
  readonly seam: string
  /** Exact capability ids this provider can satisfy. Required unless `domains` is set. */
  readonly capabilities?: readonly string[]
  /** Capability domain prefixes this provider can satisfy (e.g. `calendar`). */
  readonly domains?: readonly string[]
}

export interface ArchitectureInventory {
  /** When true, absence from seams/plugins/providers is evidence the need is genuinely new. */
  readonly complete: boolean
  readonly seams: readonly string[]
}

export interface ResolutionRequest {
  readonly capability: string
  readonly need: string
  /** Extra behavior the current owner does not already expose (e.g. attendee/free-busy). */
  readonly behavior?: string
  /** Caller-supplied fact: the active owner already satisfies the need. */
  readonly alreadySatisfied?: boolean
  readonly permissionOptions?: readonly PermissionOption[]
  readonly knownPlugins?: readonly KnownPluginOption[]
  readonly knownProviders?: readonly KnownProviderOption[]
  readonly inventory?: ArchitectureInventory
}

export interface ResolutionStep {
  readonly option: ResolutionOption
  readonly verdict: 'accepted' | 'rejected'
  readonly reason: string
}

export interface ResolutionTarget {
  readonly owner?: string
  readonly version?: string
  readonly seam?: string
  readonly provider?: string
  readonly permission?: string
}

export interface ResolutionReview {
  readonly kind: ResolutionKind
  readonly capability: string
  readonly need: string
  readonly recommendation: string
  readonly rationale: string
  readonly target?: ResolutionTarget
  readonly implications: readonly string[]
  readonly assumptions: readonly string[]
  readonly unresolved: readonly string[]
  readonly steps: readonly ResolutionStep[]
  readonly discoveryFacts?: DiscoveryFacts
  readonly registryFacts: {
    readonly exact: ActiveOwnerResolution
    readonly domainOwners: readonly { owner: string; version: string; capabilities: readonly string[] }[]
    readonly conflicts: readonly OwnershipConflict[]
  }
}

export interface CapabilityResolution {
  review(request: ResolutionRequest): ResolutionReview
}
