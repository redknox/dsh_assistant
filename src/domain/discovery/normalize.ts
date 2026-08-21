import { EMPTY_EFFECTS, type DiscoveredCapability, type DiscoveredEffects, type DiscoveryProvenance } from './types.js'

const KNOWN_KEYS = new Set([
  'identity',
  'source',
  'provenance',
  'version',
  'capabilities',
  'seams',
  'tools',
  'permissions',
  'effects',
  'configRequired',
  'credentialRequirements',
  'runtimeDependencies',
  'dshCompatibility',
  'packageIdentity',
  'integrity',
  'provider',
  'status',
  'eligibility',
  'rejectionReason',
  'scripts',
  'entry',
  'install',
])

function asStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function asEffects(value: unknown): DiscoveredEffects {
  if (value === undefined || value === null || typeof value !== 'object') return EMPTY_EFFECTS
  const record = value as Record<string, unknown>
  return {
    filesystem: asStringList(record.filesystem),
    network: asStringList(record.network),
    process: asStringList(record.process),
    secrets: asStringList(record.secrets),
  }
}

function asProvenance(value: unknown): DiscoveryProvenance | undefined {
  return value === 'dsh-core' || value === 'dsh-official' || value === 'third-party' || value === 'managed' || value === 'generated'
    ? value
    : undefined
}

/**
 * Read declared metadata only. Extra keys stay inspectable and are never executed.
 * Provenance/trust are stamped here as untrusted third-party; raw `provenance` is a claim only.
 */
export function normalizeDiscoveredCapability(raw: Record<string, unknown>): DiscoveredCapability | undefined {
  const identity = typeof raw.identity === 'string' ? raw.identity : undefined
  if (identity === undefined || identity === '') return undefined
  const claimed = asProvenance(raw.provenance) ?? (typeof raw.provenance === 'string' ? raw.provenance : undefined)
  const unexpectedFields = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key) || key === 'scripts' || key === 'entry' || key === 'install')
  return {
    identity,
    source: typeof raw.source === 'string' ? raw.source : 'unknown',
    provenance: 'third-party',
    claimedProvenance: claimed !== undefined && claimed !== 'third-party' ? claimed : undefined,
    sourceTrust: 'untrusted',
    version: typeof raw.version === 'string' ? raw.version : 'unknown',
    capabilities: asStringList(raw.capabilities),
    seams: asStringList(raw.seams),
    tools: asStringList(raw.tools),
    permissions: asStringList(raw.permissions),
    effects: asEffects(raw.effects),
    configRequired: asStringList(raw.configRequired),
    credentialRequirements: asStringList(raw.credentialRequirements),
    runtimeDependencies: asStringList(raw.runtimeDependencies),
    dshCompatibility: typeof raw.dshCompatibility === 'string' ? raw.dshCompatibility : 'unknown',
    packageIdentity: typeof raw.packageIdentity === 'string' ? raw.packageIdentity : undefined,
    integrity: typeof raw.integrity === 'string' ? raw.integrity : undefined,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    status: raw.status === 'installed' || raw.status === 'available' ? raw.status : 'unknown',
    eligibility: 'match',
    unexpectedFields,
  }
}
