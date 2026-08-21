export const DISCOVERY_PROVENANCE = [
  'dsh-core',
  'dsh-official',
  'third-party',
  'managed',
  'generated',
] as const
export type DiscoveryProvenance = (typeof DISCOVERY_PROVENANCE)[number]

export const DISCOVERY_AVAILABILITY = ['installed', 'available', 'unknown'] as const
export type DiscoveryAvailability = (typeof DISCOVERY_AVAILABILITY)[number]

export const DISCOVERY_REPORT_STATUSES = ['ok', 'unavailable', 'incomplete'] as const
export type DiscoveryReportStatus = (typeof DISCOVERY_REPORT_STATUSES)[number]

/** How far evaluation may go. Approved/active remain governance/Registry facts. */
export const DISCOVERY_ELIGIBILITY = ['match', 'compatible', 'eligible', 'rejected'] as const
export type DiscoveryEligibility = (typeof DISCOVERY_ELIGIBILITY)[number]

/** Owned by the discovery provider. Raw metadata cannot set or elevate this. */
export const DISCOVERY_SOURCE_TRUST = ['trusted', 'untrusted'] as const
export type DiscoverySourceTrust = (typeof DISCOVERY_SOURCE_TRUST)[number]

export const DISCOVERY_AUTHORITIES = ['host', 'untrusted'] as const
export type DiscoveryAuthority = (typeof DISCOVERY_AUTHORITIES)[number]

export interface DiscoveredEffects {
  readonly filesystem: readonly string[]
  readonly network: readonly string[]
  readonly process: readonly string[]
  readonly secrets: readonly string[]
}

export interface DiscoveryQuery {
  readonly capability: string
  readonly need: string
}

export interface DiscoveredCapability {
  readonly identity: string
  readonly source: string
  /** Provider-stamped class. Raw `provenance` claims never override this. */
  readonly provenance: DiscoveryProvenance
  /** What untrusted metadata claimed, when different from the stamped class. */
  readonly claimedProvenance?: string
  /** Provider/source authority. Never read from candidate metadata. */
  readonly sourceTrust: DiscoverySourceTrust
  readonly version: string
  readonly capabilities: readonly string[]
  readonly seams: readonly string[]
  readonly tools: readonly string[]
  readonly permissions: readonly string[]
  readonly effects: DiscoveredEffects
  readonly configRequired: readonly string[]
  readonly credentialRequirements: readonly string[]
  readonly runtimeDependencies: readonly string[]
  readonly dshCompatibility: string | 'unknown'
  readonly packageIdentity?: string
  readonly integrity?: string
  readonly provider?: string
  readonly status: DiscoveryAvailability
  readonly eligibility: DiscoveryEligibility
  readonly rejectionReason?: string
  /** Unexpected keys from untrusted metadata. Stored as data only; never executed. */
  readonly unexpectedFields: readonly string[]
}

export interface DiscoveryReport {
  readonly status: DiscoveryReportStatus
  readonly query: DiscoveryQuery
  readonly records: readonly DiscoveredCapability[]
  readonly diagnostics: readonly string[]
}

export interface CapabilityDiscovery {
  search(query: DiscoveryQuery): DiscoveryReport
  inspect(identity: string): DiscoveredCapability | undefined
}

export interface DiscoveryFacts {
  readonly status: DiscoveryReportStatus | 'not-queried'
  readonly records: readonly DiscoveredCapability[]
  readonly rejected: readonly { readonly identity: string; readonly reason: string }[]
  readonly diagnostics: readonly string[]
}

export const EMPTY_EFFECTS: DiscoveredEffects = {
  filesystem: [],
  network: [],
  process: [],
  secrets: [],
}
