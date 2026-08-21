export type {
  KnowledgeCitation,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeIngestInput,
  KnowledgeQuery,
  KnowledgeRetrieval,
  KnowledgeRetrievalTrace,
  KnowledgeSourceKind,
  PersonalKnowledge,
  RetrievalScore,
} from './types.js'
export { KNOWLEDGE_SOURCE_KINDS } from './types.js'
export { KnowledgeContractError, MAX_RETRIEVAL_HITS, chunkText, normalizeIngestInput } from './normalize.js'
export { InMemoryKeywordIndex, type KnowledgeIndex } from './keyword-index.js'
export { KnowledgeService, type KnowledgeServiceOptions } from './service.js'
