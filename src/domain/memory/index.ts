export type {
  Confidence,
  ConflictGroup,
  ConflictPolicy,
  MemoryActor,
  MemoryCategory,
  MemoryMechanism,
  MemoryQuery,
  MemoryRecord,
  MemoryReplaceInput,
  MemoryStatus,
  MemoryVisibility,
  MemoryWriteInput,
  PersonalMemory,
  Polarity,
  Provenance,
  QueryResult,
  RetrievalTrace,
  SelectionReason,
  SessionHistoryRef,
  WriteResult,
} from './types.js'
export { MEMORY_CATEGORIES, isSessionHistoryRef } from './types.js'
export { InMemoryPersistence, type MemoryPersistence } from './persistence.js'
export { InMemoryPersonalMemory, MemoryService, renderModelVisibleMemory, type MemoryServiceOptions } from './service.js'
export {
  MemoryContractError,
  normalizeStatement,
  normalizeTopicKey,
  normalizeWriteInput,
  polarityIsKnownFalse,
  polarityIsUnknown,
} from './normalize.js'
