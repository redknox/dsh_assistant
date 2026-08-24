import {
  EVIDENCE_LEVELS,
  LIFECYCLE_STATUSES,
  PROVENANCE_KINDS,
  PROVENANCE_ORIGINS,
  type CapabilityClaim,
  type EvidenceLevel,
  type ExtensionProvenance,
  type LifecycleStatus,
  type RegistryRecord,
  type RegistryRegisterInput,
} from './types.js'

export class RegistryContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistryContractError'
  }
}

export class OwnershipConflictError extends RegistryContractError {
  readonly capability: string
  readonly owners: readonly { owner: string; version: string }[]

  constructor(capability: string, owners: readonly { owner: string; version: string }[]) {
    super(`conflicting active owners for ${capability}: ${owners.map((item) => `${item.owner}@${item.version}`).join(', ')}`)
    this.name = 'OwnershipConflictError'
    this.capability = capability
    this.owners = owners
  }
}

const OWNER_ID = /^(managed|generated)\/[a-z][a-z0-9-]*$/
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const CAPABILITY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/
const TOKEN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/
const NAME = /^[A-Za-z][A-Za-z0-9._-]*$/

export function parseCapabilityId(raw: string): string {
  if (typeof raw !== 'string' || !CAPABILITY.test(raw)) {
    throw new RegistryContractError(`malformed capability identity: ${JSON.stringify(raw)}`)
  }
  return raw
}

export function parseOwnerId(raw: string): string {
  if (typeof raw !== 'string' || !OWNER_ID.test(raw)) {
    throw new RegistryContractError(`malformed owner id: ${JSON.stringify(raw)}`)
  }
  return raw
}

export function parseVersion(raw: string): string {
  if (typeof raw !== 'string' || !VERSION.test(raw)) {
    throw new RegistryContractError(`malformed version: ${JSON.stringify(raw)}`)
  }
  return raw
}

function parseToken(raw: string, label: string): string {
  if (typeof raw !== 'string' || !TOKEN.test(raw)) {
    throw new RegistryContractError(`malformed ${label}: ${JSON.stringify(raw)}`)
  }
  return raw
}

function parseName(raw: string, label: string): string {
  if (typeof raw !== 'string' || !NAME.test(raw)) {
    throw new RegistryContractError(`malformed ${label}: ${JSON.stringify(raw)}`)
  }
  return raw
}

function parseEnum<T extends string>(raw: unknown, allowed: readonly T[], label: string): T {
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    throw new RegistryContractError(`invalid ${label}: ${JSON.stringify(raw)}`)
  }
  return raw as T
}

export function parseCapabilityClaim(raw: CapabilityClaim): CapabilityClaim {
  return {
    id: parseCapabilityId(raw.id),
    permissions: Object.freeze(raw.permissions.map((item) => parseToken(item, 'permission'))),
  }
}

export function normalizeRegisterInput(input: RegistryRegisterInput): RegistryRecord {
  const provenance: ExtensionProvenance = {
    kind: parseEnum(input.provenance.kind, PROVENANCE_KINDS, 'provenance.kind'),
    origin: parseEnum(input.provenance.origin, PROVENANCE_ORIGINS, 'provenance.origin'),
  }
  const owner = parseOwnerId(input.owner)
  if (provenance.kind === 'managed' && !owner.startsWith('managed/')) {
    throw new RegistryContractError('managed provenance requires a managed/* owner')
  }
  if (provenance.kind === 'generated' && !owner.startsWith('generated/')) {
    throw new RegistryContractError('generated provenance requires a generated/* owner')
  }
  const capabilities = Object.freeze(input.capabilities.map(parseCapabilityClaim))
  if (new Set(capabilities.map((item) => item.id)).size !== capabilities.length) {
    throw new RegistryContractError('duplicate capability claim on one record')
  }
  return {
    owner,
    version: parseVersion(input.version),
    provenance,
    status: input.status === undefined ? 'candidate' : parseEnum(input.status, LIFECYCLE_STATUSES, 'status'),
    evidence: parseEnum(input.evidence, EVIDENCE_LEVELS, 'evidence'),
    approval: 'unreviewed',
    capabilities,
    permissions: Object.freeze((input.permissions ?? []).map((item) => parseToken(item, 'permission'))),
    runtimeSeams: Object.freeze(input.runtimeSeams.map((item) => parseToken(item, 'runtime seam'))),
    provider: input.provider === undefined ? undefined : parseToken(input.provider, 'provider'),
    tools: Object.freeze((input.tools ?? []).map((item) => parseName(item, 'tool'))),
    services: Object.freeze((input.services ?? []).map((item) => parseName(item, 'service'))),
    providers: Object.freeze((input.providers ?? []).map((item) => parseToken(item, 'provider'))),
    pluginDependencies: Object.freeze((input.pluginDependencies ?? []).map((item, index) => {
      if (item.strength !== 'hard' && item.strength !== 'optional') {
        throw new RegistryContractError(`malformed pluginDependencies[${index}].strength`)
      }
      return { capability: parseCapabilityId(item.capability), strength: item.strength }
    })),
  }
}

export function cloneRecord(record: RegistryRecord): RegistryRecord {
  return {
    ...record,
    provenance: { ...record.provenance },
    capabilities: Object.freeze(record.capabilities.map((item) => ({
      id: item.id,
      permissions: Object.freeze([...item.permissions]),
    }))),
    permissions: Object.freeze([...record.permissions]),
    runtimeSeams: Object.freeze([...record.runtimeSeams]),
    tools: Object.freeze([...record.tools]),
    services: Object.freeze([...record.services]),
    providers: Object.freeze([...record.providers]),
    pluginDependencies: Object.freeze((record.pluginDependencies ?? []).map((item) => ({
      capability: item.capability,
      strength: item.strength,
    }))),
  }
}

export function recordKey(owner: string, version: string): string {
  return `${owner}@${version}`
}
