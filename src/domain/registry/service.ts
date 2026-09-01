import {
  OwnershipConflictError,
  RegistryContractError,
  cloneRecord,
  normalizeRegisterInput,
  parseCapabilityId,
  parseOwnerId,
  parseVersion,
  recordKey,
} from './normalize.js'
import type { RegistryPersistence } from './persistence.js'
import { parseRegistryRecord, toRegistrySnapshot } from './snapshot.js'
import type {
  ActiveOwnerResolution,
  CapabilityRegistry,
  LifecycleStatus,
  OwnershipConflict,
  RegistryQuery,
  RegistryRecord,
  RegistryRegisterInput,
  RegistryRevisePatch,
} from './types.js'

function claimsCapability(record: RegistryRecord, capability: string): boolean {
  return record.capabilities.some((item) => item.id === capability)
}

function activeConflicts(records: readonly RegistryRecord[]): OwnershipConflict[] {
  const byCapability = new Map<string, RegistryRecord[]>()
  for (const record of records) {
    if (record.status !== 'active') continue
    for (const claim of record.capabilities) {
      const current = byCapability.get(claim.id) ?? []
      current.push(record)
      byCapability.set(claim.id, current)
    }
  }
  return [...byCapability.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([capability, items]) => ({ capability, records: items }))
}

export class RegistryService implements CapabilityRegistry {
  private records = new Map<string, RegistryRecord>()

  constructor(private readonly persistence: RegistryPersistence) {
    const decoded = persistence.load().map((row) => parseRegistryRecord(row))
    const conflicts = activeConflicts(decoded)
    if (conflicts[0]) {
      throw new OwnershipConflictError(
        conflicts[0].capability,
        conflicts[0].records.map((item) => ({ owner: item.owner, version: item.version })),
      )
    }
    for (const record of decoded) {
      this.records.set(recordKey(record.owner, record.version), record)
    }
  }

  register(input: RegistryRegisterInput): RegistryRecord {
    const record = normalizeRegisterInput(input)
    const key = recordKey(record.owner, record.version)
    if (this.records.has(key)) {
      throw new RegistryContractError(`record already exists: ${key}`)
    }
    this.assertNoActiveConflict(record)
    this.records.set(key, record)
    this.persist()
    return cloneRecord(record)
  }

  get(owner: string, version: string): RegistryRecord | undefined {
    const record = this.records.get(recordKey(parseOwnerId(owner), parseVersion(version)))
    return record === undefined ? undefined : cloneRecord(record)
  }

  list(query: RegistryQuery = {}): readonly RegistryRecord[] {
    const capability = query.capability === undefined ? undefined : parseCapabilityId(query.capability)
    return [...this.records.values()]
      .filter((record) => {
        if (query.owner !== undefined && record.owner !== parseOwnerId(query.owner)) return false
        if (query.status !== undefined && record.status !== query.status) return false
        if (query.provenanceKind !== undefined && record.provenance.kind !== query.provenanceKind) return false
        if (capability !== undefined && !claimsCapability(record, capability)) return false
        return true
      })
      .map(cloneRecord)
      .sort((left, right) => recordKey(left.owner, left.version).localeCompare(recordKey(right.owner, right.version)))
  }

  resolveActiveOwner(capability: string): ActiveOwnerResolution {
    const id = parseCapabilityId(capability)
    const mentioned = [...this.records.values()].filter((record) => claimsCapability(record, id))
    if (mentioned.length === 0) return { kind: 'unknown', capability: id }
    const active = mentioned.filter((record) => record.status === 'active')
    if (active.length === 1) {
      return { kind: 'owner', capability: id, record: cloneRecord(active[0]!) }
    }
    if (active.length > 1) {
      return { kind: 'conflict', capability: id, records: active.map(cloneRecord) }
    }
    return { kind: 'inactive', capability: id, records: mentioned.map(cloneRecord) }
  }

  listCapabilities(owner: string, version: string): readonly string[] {
    const record = this.get(owner, version)
    if (record === undefined) {
      throw new RegistryContractError(`unknown record: ${owner}@${version}`)
    }
    return record.capabilities.map((item) => item.id)
  }

  conflicts(): readonly OwnershipConflict[] {
    return activeConflicts([...this.records.values()]).map((item) => ({
      capability: item.capability,
      records: item.records.map(cloneRecord),
    })).sort((left, right) => left.capability.localeCompare(right.capability))
  }

  transitionStatus(owner: string, version: string, status: LifecycleStatus): RegistryRecord {
    const key = recordKey(parseOwnerId(owner), parseVersion(version))
    const current = this.records.get(key)
    if (current === undefined) throw new RegistryContractError(`unknown record: ${key}`)
    const next = { ...cloneRecord(current), status }
    if (status === 'active') this.assertNoActiveConflict(next, key)
    this.records.set(key, next)
    this.persist()
    return cloneRecord(next)
  }

  revise(owner: string, version: string, patch: RegistryRevisePatch): RegistryRecord {
    const key = recordKey(parseOwnerId(owner), parseVersion(version))
    const current = this.records.get(key)
    if (current === undefined) throw new RegistryContractError(`unknown record: ${key}`)
    const normalized = normalizeRegisterInput({
      owner: current.owner,
      version: current.version,
      provenance: current.provenance,
      status: current.status,
      evidence: current.evidence,
      capabilities: patch.capabilities ?? current.capabilities,
      permissions: patch.permissions ?? [...current.permissions],
      runtimeSeams: [...current.runtimeSeams],
      provider: patch.provider ?? current.provider,
      tools: [...current.tools],
      services: [...current.services],
      providers: patch.providers ?? [...current.providers],
      workflows: patch.workflows ?? [...current.workflows],
      pluginDependencies: [...(current.pluginDependencies ?? [])],
    })
    const next = { ...normalized, approval: current.approval, status: current.status }
    if (next.status === 'active') this.assertNoActiveConflict(next, key)
    this.records.set(key, next)
    this.persist()
    return cloneRecord(next)
  }

  private assertNoActiveConflict(record: RegistryRecord, ignoreKey?: string): void {
    if (record.status !== 'active') return
    for (const claim of record.capabilities) {
      const others = [...this.records.values()].filter((existing) => (
        recordKey(existing.owner, existing.version) !== (ignoreKey ?? recordKey(record.owner, record.version))
        && existing.status === 'active'
        && claimsCapability(existing, claim.id)
      ))
      if (others.length > 0) {
        throw new OwnershipConflictError(claim.id, [
          ...others.map((item) => ({ owner: item.owner, version: item.version })),
          { owner: record.owner, version: record.version },
        ])
      }
    }
  }

  private persist(): void {
    this.persistence.save([...this.records.values()].map(toRegistrySnapshot))
  }
}
