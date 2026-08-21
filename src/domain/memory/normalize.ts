import { MEMORY_CATEGORIES, type Confidence, type MemoryCategory, type MemoryWriteInput, type Polarity, type Provenance } from './types.js'

export class MemoryContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryContractError'
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

export function assertCategory(category: string): asserts category is MemoryCategory {
  if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
    throw new MemoryContractError(`unknown memory category: ${category}`)
  }
}

export function assertPolarity(polarity: Polarity): void {
  if (polarity !== 'true' && polarity !== 'false' && polarity !== 'unknown') {
    throw new MemoryContractError('polarity must be true, false, or unknown')
  }
}

export function assertConfidence(confidence: Confidence): void {
  if (confidence.kind === 'unknown') return
  if (confidence.kind !== 'score' || !Number.isFinite(confidence.value) || confidence.value < 0 || confidence.value > 1) {
    throw new MemoryContractError('confidence score must be a finite number in [0, 1]')
  }
}

export function assertProvenance(provenance: Provenance): void {
  if (!ISO_INSTANT.test(provenance.recordedAt)) {
    throw new MemoryContractError('provenance.recordedAt must be a UTC ISO-8601 instant')
  }
  if (!Array.isArray(provenance.evidenceIds)) {
    throw new MemoryContractError('provenance.evidenceIds must be an array')
  }
}

export function normalizeTopicKey(topicKey: string): string {
  const normalized = topicKey.trim().toLowerCase()
  if (normalized.length === 0) throw new MemoryContractError('topicKey must be non-empty')
  return normalized
}

export function normalizeStatement(statement: string): string {
  const normalized = statement.trim()
  if (normalized.length === 0) throw new MemoryContractError('statement must be non-empty')
  return normalized
}

export function normalizeWriteInput(input: MemoryWriteInput): MemoryWriteInput {
  assertCategory(input.category)
  assertPolarity(input.polarity)
  assertConfidence(input.confidence)
  assertProvenance(input.provenance)
  return {
    ...input,
    topicKey: normalizeTopicKey(input.topicKey),
    statement: normalizeStatement(input.statement),
  }
}

/** Explicit rule: unknown is not false. */
export function polarityIsKnownFalse(polarity: Polarity): boolean {
  return polarity === 'false'
}

export function polarityIsUnknown(polarity: Polarity): boolean {
  return polarity === 'unknown'
}

export function statementsConflict(a: { statement: string; polarity: Polarity }, b: { statement: string; polarity: Polarity }): boolean {
  if (a.statement === b.statement && a.polarity === b.polarity) return false
  if (a.polarity === 'unknown' || b.polarity === 'unknown') {
    return a.statement !== b.statement || a.polarity !== b.polarity
  }
  return a.statement !== b.statement || a.polarity !== b.polarity
}
