export const KNOWLEDGE_SOURCE_KINDS = ['file', 'note', 'fixture'] as const
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number]

export interface KnowledgeDocument {
  readonly id: string
  readonly sourceUri: string
  readonly sourceKind: KnowledgeSourceKind
  /** Present only when the source itself provided a title. Never invented. */
  readonly title?: string
  readonly ingestedAt: string
}

export interface KnowledgeChunk {
  readonly id: string
  readonly documentId: string
  readonly ordinal: number
  readonly text: string
}

export interface KnowledgeCitation {
  readonly documentId: string
  readonly chunkId: string
  readonly sourceUri: string
  readonly sourceKind: KnowledgeSourceKind
  readonly title?: string
  readonly excerpt: string
}

export interface KnowledgeQuery {
  readonly text: string
  readonly limit?: number
}

export type RetrievalScore =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'lexical'; readonly value: number }

export interface KnowledgeHit {
  readonly chunk: KnowledgeChunk
  readonly document: KnowledgeDocument
  readonly citation: KnowledgeCitation
  readonly score: RetrievalScore
  readonly reasons: readonly string[]
}

export interface KnowledgeRetrievalTrace {
  readonly query: KnowledgeQuery
  readonly hitCount: number
  readonly why: string
}

export interface KnowledgeRetrieval {
  readonly hits: readonly KnowledgeHit[]
  readonly trace: KnowledgeRetrievalTrace
}

export interface KnowledgeIngestInput {
  readonly sourceUri: string
  readonly sourceKind: KnowledgeSourceKind
  readonly text: string
  readonly title?: string
}

export interface PersonalKnowledge {
  ingest(input: KnowledgeIngestInput): KnowledgeDocument
  retrieve(query: KnowledgeQuery): KnowledgeRetrieval
  getDocument(id: string): KnowledgeDocument | undefined
}
