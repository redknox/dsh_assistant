import { randomUUID } from 'node:crypto'
import { MAX_EXCERPT_CHARS, boundLimit, chunkText, normalizeIngestInput } from './normalize.js'
import type { KnowledgeIndex } from './keyword-index.js'
import { InMemoryKeywordIndex } from './keyword-index.js'
import type {
  KnowledgeDocument,
  KnowledgeIngestInput,
  KnowledgeQuery,
  KnowledgeRetrieval,
  PersonalKnowledge,
} from './types.js'

export interface KnowledgeServiceOptions {
  now?: () => string
  id?: () => string
}

export class KnowledgeService implements PersonalKnowledge {
  private readonly now: () => string
  private readonly id: () => string

  constructor(
    private readonly index: KnowledgeIndex = new InMemoryKeywordIndex(),
    options: KnowledgeServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.id = options.id ?? (() => randomUUID())
  }

  ingest(input: KnowledgeIngestInput): KnowledgeDocument {
    const normalized = normalizeIngestInput(input)
    const document: KnowledgeDocument = {
      id: this.id(),
      sourceUri: normalized.sourceUri,
      sourceKind: normalized.sourceKind,
      ingestedAt: this.now(),
      ...(normalized.title ? { title: normalized.title } : {}),
    }
    const chunks = chunkText(normalized.text).map((text, ordinal) => ({
      id: `${document.id}:${ordinal}`,
      documentId: document.id,
      ordinal,
      text,
    }))
    this.index.upsert(document, chunks)
    return document
  }

  retrieve(query: KnowledgeQuery): KnowledgeRetrieval {
    const text = query.text.trim()
    const boundedQuery = { text, limit: boundLimit(query.limit) }
    if (text.length === 0) {
      return {
        hits: [],
        trace: { query: boundedQuery, hitCount: 0, why: 'empty query; no knowledge selected' },
      }
    }
    const hits = this.index.search(boundedQuery, boundedQuery.limit ?? 5).map((hit) => ({
      ...hit,
      citation: {
        ...hit.citation,
        excerpt: hit.citation.excerpt.slice(0, MAX_EXCERPT_CHARS),
      },
    }))
    return {
      hits,
      trace: {
        query: boundedQuery,
        hitCount: hits.length,
        why: hits.length === 0
          ? `no lexical matches for ${JSON.stringify(text)}`
          : `selected ${hits.length} chunk(s) by lexical overlap, limit=${boundedQuery.limit}`,
      },
    }
  }

  getDocument(id: string): KnowledgeDocument | undefined {
    return this.index.getDocument(id)
  }
}
