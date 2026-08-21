export type {
  ActiveOwnerResolution,
  ApprovalState,
  CapabilityClaim,
  CapabilityRegistry,
  EvidenceLevel,
  ExtensionProvenance,
  LifecycleStatus,
  OwnershipConflict,
  PluginVersionId,
  ProvenanceKind,
  ProvenanceOrigin,
  RegistryQuery,
  RegistryRecord,
  RegistryRegisterInput,
} from './types.js'
export {
  APPROVAL_STATES,
  EVIDENCE_LEVELS,
  LIFECYCLE_STATUSES,
  PROVENANCE_KINDS,
  PROVENANCE_ORIGINS,
} from './types.js'
export {
  OwnershipConflictError,
  RegistryContractError,
  cloneRecord,
  normalizeRegisterInput,
  parseCapabilityId,
  parseOwnerId,
  parseVersion,
  recordKey,
} from './normalize.js'
export { parseRegistryRecord, toRegistrySnapshot, type RegistryRecordSnapshot } from './snapshot.js'
export { InMemoryRegistryPersistence, type RegistryPersistence } from './persistence.js'
export { RegistryService } from './service.js'
export { CORE_BOOTSTRAP_INVENTORY, bootstrapCoreInventory } from './bootstrap.js'
