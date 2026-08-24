import {
  APPROVAL_STATES,
  EVIDENCE_LEVELS,
  LIFECYCLE_STATUSES,
  type ApprovalState,
  type RegistryRecord,
} from './types.js'
import { RegistryContractError, normalizeRegisterInput } from './normalize.js'

/**
 * Storage DTO. Persistence adapters may only read/write this shape.
 * It is not the registry domain model.
 */
export interface RegistryRecordSnapshot {
  readonly owner: string
  readonly version: string
  readonly provenance: { readonly kind: string; readonly origin: string }
  readonly status: string
  readonly evidence: string
  readonly approval: string
  readonly capabilities: readonly { readonly id: string; readonly permissions: readonly string[] }[]
  readonly permissions: readonly string[]
  readonly runtimeSeams: readonly string[]
  readonly provider?: string
  readonly tools: readonly string[]
  readonly services: readonly string[]
  readonly providers: readonly string[]
  readonly pluginDependencies?: readonly { readonly capability: string; readonly strength: string }[]
}

const SNAPSHOT_KEYS = new Set([
  'owner',
  'version',
  'provenance',
  'status',
  'evidence',
  'approval',
  'capabilities',
  'permissions',
  'runtimeSeams',
  'provider',
  'tools',
  'services',
  'providers',
  'pluginDependencies',
])

function asObject(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RegistryContractError(`${label} must be an object`)
  }
  return raw as Record<string, unknown>
}

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new RegistryContractError(`${label} has unknown field ${key}`)
  }
}

function parsePluginDependencies(raw: unknown): readonly { capability: string; strength: 'hard' | 'optional' }[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new RegistryContractError('pluginDependencies must be an array')
  return raw.map((item, index) => {
    const dep = asObject(item, `pluginDependencies[${index}]`)
    rejectUnknownKeys(dep, new Set(['capability', 'strength']), `pluginDependencies[${index}]`)
    if (typeof dep.capability !== 'string') {
      throw new RegistryContractError(`pluginDependencies[${index}].capability must be a string`)
    }
    if (dep.strength !== 'hard' && dep.strength !== 'optional') {
      throw new RegistryContractError(`pluginDependencies[${index}].strength must be hard or optional`)
    }
    return { capability: dep.capability, strength: dep.strength }
  })
}

function asStringArray(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) throw new RegistryContractError(`${label} must be an array`)
  return raw.map((item, index) => {
    if (typeof item !== 'string') throw new RegistryContractError(`${label}[${index}] must be a string`)
    return item
  })
}

export function toRegistrySnapshot(record: RegistryRecord): RegistryRecordSnapshot {
  return {
    owner: record.owner,
    version: record.version,
    provenance: { kind: record.provenance.kind, origin: record.provenance.origin },
    status: record.status,
    evidence: record.evidence,
    approval: record.approval,
    capabilities: record.capabilities.map((item) => ({
      id: item.id,
      permissions: [...item.permissions],
    })),
    permissions: [...record.permissions],
    runtimeSeams: [...record.runtimeSeams],
    provider: record.provider,
    tools: [...record.tools],
    services: [...record.services],
    providers: [...record.providers],
    pluginDependencies: [...(record.pluginDependencies ?? [])],
  }
}

/** Decode a persisted snapshot through the same invariants as register(), except stored approval is recorded as-is. */
export function parseRegistryRecord(raw: unknown): RegistryRecord {
  const snapshot = asObject(raw, 'registry snapshot')
  rejectUnknownKeys(snapshot, SNAPSHOT_KEYS, 'registry snapshot')
  const provenance = asObject(snapshot.provenance, 'provenance')
  rejectUnknownKeys(provenance, new Set(['kind', 'origin']), 'provenance')
  if (!Array.isArray(snapshot.capabilities)) {
    throw new RegistryContractError('capabilities must be an array')
  }
  const capabilities = snapshot.capabilities.map((item, index) => {
    const claim = asObject(item, `capabilities[${index}]`)
    rejectUnknownKeys(claim, new Set(['id', 'permissions']), `capabilities[${index}]`)
    if (typeof claim.id !== 'string') throw new RegistryContractError(`capabilities[${index}].id must be a string`)
    return { id: claim.id, permissions: asStringArray(claim.permissions, `capabilities[${index}].permissions`) }
  })
  const approval = snapshot.approval
  if (typeof approval !== 'string' || !APPROVAL_STATES.includes(approval as typeof APPROVAL_STATES[number])) {
    throw new RegistryContractError(`invalid approval: ${JSON.stringify(approval)}`)
  }
  if (typeof snapshot.status !== 'string' || !LIFECYCLE_STATUSES.includes(snapshot.status as typeof LIFECYCLE_STATUSES[number])) {
    throw new RegistryContractError(`invalid status: ${JSON.stringify(snapshot.status)}`)
  }
  if (typeof snapshot.evidence !== 'string' || !EVIDENCE_LEVELS.includes(snapshot.evidence as typeof EVIDENCE_LEVELS[number])) {
    throw new RegistryContractError(`invalid evidence: ${JSON.stringify(snapshot.evidence)}`)
  }
  const record = normalizeRegisterInput({
    owner: typeof snapshot.owner === 'string' ? snapshot.owner : '',
    version: typeof snapshot.version === 'string' ? snapshot.version : '',
    provenance: {
      kind: provenance.kind as 'managed',
      origin: provenance.origin as 'human',
    },
    status: snapshot.status as RegistryRecord['status'],
    evidence: snapshot.evidence as RegistryRecord['evidence'],
    capabilities,
    permissions: snapshot.permissions === undefined ? [] : asStringArray(snapshot.permissions, 'permissions'),
    runtimeSeams: asStringArray(snapshot.runtimeSeams, 'runtimeSeams'),
    provider: snapshot.provider === undefined ? undefined : String(snapshot.provider),
    tools: snapshot.tools === undefined ? [] : asStringArray(snapshot.tools, 'tools'),
    services: snapshot.services === undefined ? [] : asStringArray(snapshot.services, 'services'),
    providers: snapshot.providers === undefined ? [] : asStringArray(snapshot.providers, 'providers'),
    pluginDependencies: parsePluginDependencies(snapshot.pluginDependencies),
  })
  return { ...record, approval: approval as ApprovalState }
}
