import type { MemoryRecord, RetrievalTrace } from '../domain/memory/types.js'

/** UI-facing memory rows; storage DTOs must not leak here. */
export interface MemoryRowProjection {
  readonly id: string
  readonly category: MemoryRecord['category']
  readonly topicKey: string
  readonly statement: string
  readonly polarity: MemoryRecord['polarity']
  readonly status: MemoryRecord['status']
  readonly modelVisible: boolean
}

export function projectMemoryRow(record: MemoryRecord): MemoryRowProjection {
  return {
    id: record.id,
    category: record.category,
    topicKey: record.topicKey,
    statement: record.statement,
    polarity: record.polarity,
    status: record.status,
    modelVisible: record.visibility === 'model',
  }
}

export interface ModelMemoryInjectionProjection {
  readonly text: string
  readonly trace: RetrievalTrace
}

export function projectModelMemoryInjection(text: string, trace: RetrievalTrace): ModelMemoryInjectionProjection {
  return { text, trace }
}
