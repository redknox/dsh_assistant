import { randomUUID } from 'node:crypto'
import { MemoryContractError, normalizeStatement, normalizeWriteInput, statementsConflict } from './normalize.js'
import type { MemoryPersistence } from './persistence.js'
import { InMemoryPersistence } from './persistence.js'
import {
  isSessionHistoryRef,
  type ConflictGroup,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryReplaceInput,
  type MemoryWriteInput,
  type PersonalMemory,
  type Provenance,
  type QueryResult,
  type RetrievalTrace,
  type SelectionReason,
  type WriteResult,
} from './types.js'

export interface MemoryServiceOptions {
  now?: () => string
  id?: () => string
}

function clone(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    provenance: { ...record.provenance, evidenceIds: [...record.provenance.evidenceIds] },
    confidence: record.confidence.kind === 'unknown' ? { kind: 'unknown' } : { kind: 'score', value: record.confidence.value },
  }
}

function matchesQuery(record: MemoryRecord, query: MemoryQuery): string[] | undefined {
  const reasons: string[] = [`status=${record.status}`]
  if (query.category) {
    if (record.category !== query.category) return undefined
    reasons.push(`category=${query.category}`)
  }
  if (query.topicKey) {
    if (record.topicKey !== query.topicKey) return undefined
    reasons.push(`topicKey=${query.topicKey}`)
  }
  if (!query.includeDeleted && record.status === 'deleted') return undefined
  if (!query.includeSuperseded && record.status === 'superseded') return undefined
  if (record.status === 'active' && !query.includeDeleted && !query.includeSuperseded) {
    reasons.push('default-excludes-deleted-and-superseded')
  }
  const visibility = query.visibility ?? 'any'
  if (visibility !== 'any') {
    if (record.visibility !== visibility) return undefined
    reasons.push(`visibility=${visibility}`)
  } else {
    reasons.push('visibility=any')
  }
  return reasons
}

/**
 * Application memory service. Persistence is injected and swappable.
 * Writes happen only through explicit {@link write}/{@link replace}/{@link delete} — never from session history.
 */
export class MemoryService implements PersonalMemory {
  private readonly records = new Map<string, MemoryRecord>()
  private readonly now: () => string
  private readonly id: () => string

  constructor(
    private readonly persistence: MemoryPersistence,
    options: MemoryServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.id = options.id ?? (() => randomUUID())
    for (const record of persistence.load()) {
      this.records.set(record.id, clone(record))
    }
  }

  get(id: string): MemoryRecord | undefined {
    const record = this.records.get(id)
    return record ? clone(record) : undefined
  }

  query(query: MemoryQuery = {}): QueryResult {
    const selections: SelectionReason[] = []
    const records: MemoryRecord[] = []
    for (const record of this.records.values()) {
      const reasons = matchesQuery(record, query)
      if (!reasons) continue
      records.push(clone(record))
      selections.push({ recordId: record.id, reasons })
    }
    const conflicts = this.conflictsAmong(records.filter((record) => record.status === 'active'))
    const trace: RetrievalTrace = {
      query,
      recordIds: records.map((record) => record.id),
      conflictTopicKeys: conflicts.map((group) => group.topicKey),
      selections,
      why: summarizeTrace(query, selections, conflicts.length),
    }
    return { records, conflicts, trace }
  }

  write(input: MemoryWriteInput): WriteResult {
    if (isSessionHistoryRef(input as unknown)) {
      throw new MemoryContractError('session history is not durable memory and must not be written')
    }
    const normalized = normalizeWriteInput(input)
    const at = this.now()
    const supersededIds: string[] = []

    if (normalized.conflictPolicy === 'supersede_topic') {
      for (const record of this.records.values()) {
        if (record.topicKey === normalized.topicKey && record.status === 'active') {
          supersededIds.push(record.id)
        }
      }
    }

    const id = this.id()
    for (const supersededId of supersededIds) {
      this.markSuperseded(supersededId, id, at)
    }

    const record: MemoryRecord = {
      id,
      category: normalized.category,
      topicKey: normalized.topicKey,
      statement: normalized.statement,
      polarity: normalized.polarity,
      confidence: normalized.confidence,
      provenance: normalized.provenance,
      createdAt: at,
      updatedAt: at,
      status: 'active',
      visibility: normalized.visibility,
    }
    this.records.set(id, record)
    this.flush()
    return { record: clone(record), supersededIds, conflicts: this.topicConflicts(normalized.topicKey) }
  }

  replace(id: string, input: MemoryReplaceInput): WriteResult {
    const existing = this.records.get(id)
    if (!existing) throw new MemoryContractError(`memory not found: ${id}`)
    if (existing.status === 'deleted') throw new MemoryContractError(`cannot replace deleted memory: ${id}`)

    const replacementId = this.id()
    const at = this.now()
    this.markSuperseded(id, replacementId, at)

    const statement = input.statement === undefined ? existing.statement : normalizeStatement(input.statement)
    const polarity = input.polarity ?? existing.polarity
    const confidence = input.confidence ?? existing.confidence
    const visibility = input.visibility ?? existing.visibility
    const record: MemoryRecord = {
      id: replacementId,
      category: existing.category,
      topicKey: existing.topicKey,
      statement,
      polarity,
      confidence,
      provenance: input.provenance,
      createdAt: existing.createdAt,
      updatedAt: at,
      status: 'active',
      visibility,
    }
    this.records.set(replacementId, record)
    this.flush()
    return { record: clone(record), supersededIds: [id], conflicts: this.topicConflicts(record.topicKey) }
  }

  delete(id: string, provenance: Provenance): MemoryRecord {
    const existing = this.records.get(id)
    if (!existing) throw new MemoryContractError(`memory not found: ${id}`)
    const at = this.now()
    const deleted: MemoryRecord = {
      ...existing,
      status: 'deleted',
      deletedAt: at,
      updatedAt: at,
      provenance,
    }
    this.records.set(id, deleted)
    this.flush()
    return clone(deleted)
  }

  private markSuperseded(id: string, successorId: string, at: string): void {
    const existing = this.records.get(id)
    if (!existing) return
    this.records.set(id, {
      ...existing,
      status: 'superseded',
      supersededBy: successorId,
      updatedAt: at,
    })
  }

  private flush(): void {
    this.persistence.save([...this.records.values()].map(clone))
  }

  private topicConflicts(topicKey: string): ConflictGroup[] {
    const active = [...this.records.values()].filter((record) => record.topicKey === topicKey && record.status === 'active')
    return this.conflictsAmong(active)
  }

  private conflictsAmong(records: readonly MemoryRecord[]): ConflictGroup[] {
    const byTopic = new Map<string, MemoryRecord[]>()
    for (const record of records) {
      const list = byTopic.get(record.topicKey) ?? []
      list.push(record)
      byTopic.set(record.topicKey, list)
    }
    const groups: ConflictGroup[] = []
    for (const [topicKey, group] of byTopic) {
      const conflicted = new Set<string>()
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const left = group[i]
          const right = group[j]
          if (left && right && statementsConflict(left, right)) {
            conflicted.add(left.id)
            conflicted.add(right.id)
          }
        }
      }
      if (conflicted.size > 0) {
        groups.push({ topicKey, recordIds: [...conflicted] })
      }
    }
    return groups
  }
}

export class InMemoryPersonalMemory extends MemoryService {
  constructor(options: MemoryServiceOptions = {}) {
    super(new InMemoryPersistence(), options)
  }
}

export function renderModelVisibleMemory(memory: PersonalMemory): { text: string; trace: QueryResult['trace'] } {
  const result = memory.query({ visibility: 'model' })
  if (result.records.length === 0) {
    return { text: '', trace: result.trace }
  }
  const lines = [
    'Durable personal memory (not session history):',
    `Selected ${result.trace.recordIds.length} record(s): ${result.trace.why}`,
    ...result.records.map((record) => {
      const conflict = result.conflicts.some((group) => group.recordIds.includes(record.id)) ? ' [conflict]' : ''
      const reasons = result.trace.selections.find((item) => item.recordId === record.id)?.reasons.join(', ') ?? ''
      return `- (${record.category}/${record.polarity}${conflict}) ${record.topicKey}: ${record.statement} [${record.id}; ${reasons}]`
    }),
  ]
  return { text: lines.join('\n'), trace: result.trace }
}

function summarizeTrace(query: MemoryQuery, selections: readonly SelectionReason[], conflictCount: number): string {
  const filters: string[] = []
  if (query.category) filters.push(`category=${query.category}`)
  if (query.topicKey) filters.push(`topicKey=${query.topicKey}`)
  if (query.visibility && query.visibility !== 'any') filters.push(`visibility=${query.visibility}`)
  if (!query.includeDeleted) filters.push('exclude-deleted')
  if (!query.includeSuperseded) filters.push('exclude-superseded')
  const filterText = filters.length > 0 ? filters.join(', ') : 'no extra filters'
  return `${selections.length} selected by ${filterText}; ${conflictCount} conflict group(s)`
}
