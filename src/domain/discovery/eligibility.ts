import type { DiscoveredCapability, DiscoveryQuery } from './types.js'

export const SUPPORTED_DSH_RELEASE = '0.1.0-rc.8'

function domainOf(capability: string): string {
  return capability.slice(0, capability.indexOf('.'))
}

function matchesNeed(record: DiscoveredCapability, query: DiscoveryQuery): boolean {
  if (record.capabilities.includes(query.capability)) return true
  const domain = domainOf(query.capability)
  return record.capabilities.some((item) => item === domain || item.startsWith(`${domain}.`))
}

function hasUnboundEffects(record: DiscoveredCapability): boolean {
  return record.effects.process.some((item) => item === '*' || item === 'arbitrary')
    || record.effects.network.some((item) => item === '*' || item === 'arbitrary')
}

/** Classify a discovered record. Missing compatibility stays unknown — never optimistic. */
export function classifyDiscovery(record: DiscoveredCapability, query: DiscoveryQuery): DiscoveredCapability {
  if (record.unexpectedFields.length > 0 && (record.unexpectedFields.includes('scripts') || record.unexpectedFields.includes('install') || record.unexpectedFields.includes('entry'))) {
    return { ...record, eligibility: 'rejected', rejectionReason: 'untrusted metadata contained install/entry/script fields; treated as data only' }
  }
  if (!matchesNeed(record, query)) {
    return { ...record, eligibility: 'rejected', rejectionReason: `capabilities do not match ${query.capability}` }
  }
  if (hasUnboundEffects(record)) {
    return { ...record, eligibility: 'rejected', rejectionReason: 'declared effects are unbound or arbitrary' }
  }
  const hostTrusted = record.sourceTrust === 'trusted'
    && (record.provenance === 'dsh-core' || record.provenance === 'dsh-official' || record.provenance === 'managed')
  if (hostTrusted) {
    return { ...record, eligibility: 'eligible' }
  }
  if (record.dshCompatibility === 'unknown') {
    return { ...record, eligibility: 'match', rejectionReason: 'DSH compatibility is unknown; unknown is not compatible' }
  }
  if (record.dshCompatibility !== SUPPORTED_DSH_RELEASE) {
    return { ...record, eligibility: 'rejected', rejectionReason: `incompatible DSH constraint ${record.dshCompatibility}` }
  }
  if (record.seams.length === 0) {
    return { ...record, eligibility: 'compatible', rejectionReason: 'compatible package, but no public seam is declared for ownership-coherent adoption' }
  }
  return { ...record, eligibility: 'eligible' }
}

export function isEligible(record: DiscoveredCapability): boolean {
  return record.eligibility === 'eligible'
}
