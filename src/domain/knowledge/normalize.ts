import { KNOWLEDGE_SOURCE_KINDS, type KnowledgeIngestInput, type KnowledgeSourceKind } from './types.js'

export class KnowledgeContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'KnowledgeContractError'
  }
}

export function assertSourceKind(kind: string): asserts kind is KnowledgeSourceKind {
  if (!(KNOWLEDGE_SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new KnowledgeContractError(`unknown knowledge source kind: ${kind}`)
  }
}

export function normalizeSourceUri(sourceUri: string): string {
  const normalized = sourceUri.trim()
  if (normalized.length === 0) throw new KnowledgeContractError('sourceUri must be non-empty')
  return normalized
}

export function optionalTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined
  const normalized = title.trim()
  return normalized.length === 0 ? undefined : normalized
}

export function chunkText(text: string): string[] {
  const chunks = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (chunks.length === 0) {
    throw new KnowledgeContractError('source has no retrievable text')
  }
  return chunks
}

export function titleFromSourceText(text: string): string | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (const line of lines) {
    const heading = line.trim()
    if (heading.startsWith('# ')) return optionalTitle(heading.slice(2))
    if (heading.length > 0) return undefined
  }
  return undefined
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((token) => token.length > 0)
}

export function normalizeIngestInput(input: KnowledgeIngestInput): KnowledgeIngestInput {
  assertSourceKind(input.sourceKind)
  const text = input.text.replace(/^\uFEFF/, '')
  if (text.includes('\0')) {
    throw new KnowledgeContractError('source text is malformed')
  }
  return {
    sourceUri: normalizeSourceUri(input.sourceUri),
    sourceKind: input.sourceKind,
    text,
    title: optionalTitle(input.title) ?? titleFromSourceText(text),
  }
}

export const MAX_RETRIEVAL_HITS = 5
export const MAX_EXCERPT_CHARS = 240

export function boundLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_RETRIEVAL_HITS
  if (!Number.isInteger(limit) || limit < 1) {
    throw new KnowledgeContractError('retrieval limit must be a positive integer')
  }
  return Math.min(limit, MAX_RETRIEVAL_HITS)
}
