/** Durable personal-memory categories. Knowledge/RAG is a different capability. */
export const MEMORY_CATEGORIES = [
  'fact',
  'preference',
  'relationship',
  'project',
  'behavioral_preference',
  'episodic_summary',
] as const

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

/**
 * Three-valued polarity. `unknown` is not `false` and must not be coerced.
 */
export type Polarity = 'true' | 'false' | 'unknown'

export type MemoryStatus = 'active' | 'superseded' | 'deleted'

export type MemoryVisibility = 'model' | 'internal'

export type MemoryActor = 'user' | 'assistant' | 'import'

export type MemoryMechanism = 'explicit_write' | 'user_confirmed' | 'import'

export interface Provenance {
  readonly actor: MemoryActor
  readonly mechanism: MemoryMechanism
  /** Evidence identifiers; empty means no evidence, not a negative fact. */
  readonly evidenceIds: readonly string[]
  readonly recordedAt: string
}

export type Confidence =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'score'; readonly value: number }

export interface MemoryRecord {
  readonly id: string
  readonly category: MemoryCategory
  readonly topicKey: string
  readonly statement: string
  readonly polarity: Polarity
  readonly confidence: Confidence
  readonly provenance: Provenance
  readonly createdAt: string
  readonly updatedAt: string
  readonly status: MemoryStatus
  readonly supersededBy?: string
  readonly deletedAt?: string
  readonly visibility: MemoryVisibility
}

/**
 * DSH session/event history is not durable personal memory.
 * Callers must not pass session events into {@link PersonalMemory.write}.
 */
export interface SessionHistoryRef {
  readonly kind: 'dsh_session_history'
  readonly sessionId: string
}

export function isSessionHistoryRef(value: unknown): value is SessionHistoryRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as SessionHistoryRef).kind === 'dsh_session_history'
  )
}

export interface MemoryQuery {
  readonly category?: MemoryCategory
  readonly topicKey?: string
  readonly includeDeleted?: boolean
  readonly includeSuperseded?: boolean
  readonly visibility?: MemoryVisibility | 'any'
}

export type ConflictPolicy = 'keep_both' | 'supersede_topic'

export interface MemoryWriteInput {
  readonly category: MemoryCategory
  readonly topicKey: string
  readonly statement: string
  readonly polarity: Polarity
  readonly confidence: Confidence
  readonly provenance: Provenance
  readonly visibility: MemoryVisibility
  readonly conflictPolicy: ConflictPolicy
}

export interface MemoryReplaceInput {
  readonly statement?: string
  readonly polarity?: Polarity
  readonly confidence?: Confidence
  readonly provenance: Provenance
  readonly visibility?: MemoryVisibility
}

export interface ConflictGroup {
  readonly topicKey: string
  readonly recordIds: readonly string[]
}

export interface RetrievalTrace {
  readonly query: MemoryQuery
  readonly recordIds: readonly string[]
  readonly conflictTopicKeys: readonly string[]
}

export interface QueryResult {
  readonly records: readonly MemoryRecord[]
  readonly conflicts: readonly ConflictGroup[]
  readonly trace: RetrievalTrace
}

export interface WriteResult {
  readonly record: MemoryRecord
  readonly supersededIds: readonly string[]
  readonly conflicts: readonly ConflictGroup[]
}

export interface PersonalMemory {
  get(id: string): MemoryRecord | undefined
  query(query?: MemoryQuery): QueryResult
  write(input: MemoryWriteInput): WriteResult
  replace(id: string, input: MemoryReplaceInput): WriteResult
  delete(id: string, provenance: Provenance): MemoryRecord
}
