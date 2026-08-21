import type { KnowledgeChunk, KnowledgeDocument, KnowledgeHit, KnowledgeQuery } from './types.js'
import { MAX_EXCERPT_CHARS, tokenize } from './normalize.js'

export interface KnowledgeIndex {
  upsert(document: KnowledgeDocument, chunks: readonly KnowledgeChunk[]): void
  search(query: KnowledgeQuery, limit: number): KnowledgeHit[]
  getDocument(id: string): KnowledgeDocument | undefined
}

/** Lexical overlap index. Vector/embedding backends can replace this adapter. */
export class InMemoryKeywordIndex implements KnowledgeIndex {
  private readonly documents = new Map<string, KnowledgeDocument>()
  private readonly chunks = new Map<string, KnowledgeChunk[]>()

  upsert(document: KnowledgeDocument, chunks: readonly KnowledgeChunk[]): void {
    this.documents.set(document.id, document)
    this.chunks.set(document.id, [...chunks])
  }

  getDocument(id: string): KnowledgeDocument | undefined {
    return this.documents.get(id)
  }

  search(query: KnowledgeQuery, limit: number): KnowledgeHit[] {
    const queryTokens = new Set(tokenize(query.text))
    if (queryTokens.size === 0) return []
    const hits: KnowledgeHit[] = []
    for (const [documentId, chunks] of this.chunks) {
      const document = this.documents.get(documentId)
      if (!document) continue
      for (const chunk of chunks) {
        const chunkTokens = tokenize(chunk.text)
        const overlap = chunkTokens.filter((token) => queryTokens.has(token))
        if (overlap.length === 0) continue
        const scoreValue = overlap.length / queryTokens.size
        hits.push({
          chunk,
          document,
          citation: {
            documentId: document.id,
            chunkId: chunk.id,
            sourceUri: document.sourceUri,
            sourceKind: document.sourceKind,
            excerpt: chunk.text.slice(0, MAX_EXCERPT_CHARS),
            ...(document.title ? { title: document.title } : {}),
          },
          score: { kind: 'lexical', value: scoreValue },
          reasons: [`lexical-overlap=${overlap.length}/${queryTokens.size}`, `source=${document.sourceUri}`],
        })
      }
    }
    return hits
      .sort((left, right) => scoreOf(right) - scoreOf(left))
      .slice(0, limit)
  }
}

function scoreOf(hit: KnowledgeHit): number {
  return hit.score.kind === 'lexical' ? hit.score.value : 0
}
