import { randomUUID } from 'node:crypto'
import { MemoryContractError, normalizeStatement, normalizeWriteInput, statementsConflict } from './normalize.js'
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
  type WriteResult,
} from './types.js'

function nowIso(): string {
  return new Date().toISOString()
}

function clone(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    provenance: { ...record.provenance, evidenceIds: [...record.provenance.evidenceIds] },
    confidence: record.confidence.kind === 'unknown' ? { kind: 'unknown' } : { kind: 'score', value: record.confidence.value },
  }
}

/**
 * In-process memory adapter for tests and smoke boot.
 * Not a production database; domain types stay provider-neutral.
 */
export class InMemoryPersonalMemory implements PersonalMemory {
  private readonly records = new Map<string, MemoryRecord>()

  get(id: string): MemoryRecord | undefined {
    const record = this.records.get(id)
    return record ? clone(record) : undefined
  }

  query(query: MemoryQuery = {}): QueryResult {
    const visibility = query.visibility ?? 'any'
    const records = [...this.records.values()]
      .filter((record) => {
        if (query.category && record.category !== query.category) return false
        if (query.topicKey && record.topicKey !== query.topicKey) return false
        if (!query.includeDeleted && record.status === 'deleted') return false
        if (!query.includeSuperseded && record.status === 'superseded') return false
        if (visibility !== 'any' && record.visibility !== visibility) return false
        return true
      })
      .map(clone)

    const conflicts = this.conflictsAmong(records.filter((record) => record.status === 'active'))
    return {
      records,
      conflicts,
      trace: {
        query,
        recordIds: records.map((record) => record.id),
        conflictTopicKeys: conflicts.map((group) => group.topicKey),
      },
    }
  }

  write(input: MemoryWriteInput): WriteResult {
    if (isSessionHistoryRef(input as unknown)) {
      throw new MemoryContractError('session history is not durable memory and must not be written')
    }
    const normalized = normalizeWriteInput(input)
    const at = nowIso()
    const supersededIds: string[] = []

    if (normalized.conflictPolicy === 'supersede_topic') {
      for (const record of this.records.values()) {
        if (record.topicKey === normalized.topicKey && record.status === 'active') {
          supersededIds.push(record.id)
        }
      }
    }

    const id = randomUUID()
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
    return { record: clone(record), supersededIds, conflicts: this.topicConflicts(normalized.topicKey) }
  }

  replace(id: string, input: MemoryReplaceInput): WriteResult {
    const existing = this.records.get(id)
    if (!existing) throw new MemoryContractError(`memory not found: ${id}`)
    if (existing.status === 'deleted') throw new MemoryContractError(`cannot replace deleted memory: ${id}`)

    const replacementId = randomUUID()
    const at = nowIso()
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
    return { record: clone(record), supersededIds: [id], conflicts: this.topicConflicts(record.topicKey) }
  }

  delete(id: string, provenance: Provenance): MemoryRecord {
    const existing = this.records.get(id)
    if (!existing) throw new MemoryContractError(`memory not found: ${id}`)
    const at = nowIso()
    const deleted: MemoryRecord = {
      ...existing,
      status: 'deleted',
      deletedAt: at,
      updatedAt: at,
      provenance,
    }
    this.records.set(id, deleted)
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

export function renderModelVisibleMemory(memory: PersonalMemory): { text: string; trace: QueryResult['trace'] } {
  const result = memory.query({ visibility: 'model' })
  if (result.records.length === 0) {
    return { text: '', trace: result.trace }
  }
  const lines = result.records.map((record) => {
    const conflict = result.conflicts.some((group) => group.recordIds.includes(record.id)) ? ' [conflict]' : ''
    return `- (${record.category}/${record.polarity}${conflict}) ${record.topicKey}: ${record.statement} [${record.id}]`
  })
  return {
    text: ['Durable personal memory (not session history):', ...lines].join('\n'),
    trace: result.trace,
  }
}
