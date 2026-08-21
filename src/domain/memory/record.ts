import {
  assertCategory,
  assertConfidence,
  assertPolarity,
  assertProvenance,
  MemoryContractError,
} from './normalize.js'
import type { Confidence, MemoryRecord, Polarity, Provenance } from './types.js'

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const RECORD_KEYS = new Set([
  'id',
  'category',
  'topicKey',
  'statement',
  'polarity',
  'confidence',
  'provenance',
  'createdAt',
  'updatedAt',
  'status',
  'visibility',
  'supersededBy',
  'deletedAt',
])

function assertIsoInstant(value: string, field: string): void {
  if (!ISO_INSTANT.test(value)) {
    throw new MemoryContractError(`${field} must be a UTC ISO-8601 instant`)
  }
}

function requireNonEmptyString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MemoryContractError(`memory record missing ${key}`)
  }
  return value
}

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new MemoryContractError(`${label} has unknown field ${key}`)
    }
  }
}

function parseConfidence(value: unknown): Confidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryContractError('confidence must be an object')
  }
  const raw = value as Record<string, unknown>
  rejectUnknownKeys(raw, new Set(['kind', 'value']), 'confidence')
  if (raw.kind === 'unknown') {
    if ('value' in raw) throw new MemoryContractError('unknown confidence must not include value')
    const confidence: Confidence = { kind: 'unknown' }
    assertConfidence(confidence)
    return confidence
  }
  if (raw.kind === 'score') {
    if (typeof raw.value !== 'number') throw new MemoryContractError('confidence score value must be a number')
    const confidence: Confidence = { kind: 'score', value: raw.value }
    assertConfidence(confidence)
    return confidence
  }
  throw new MemoryContractError('confidence.kind must be unknown or score')
}

function parseProvenance(value: unknown): Provenance {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryContractError('provenance must be an object')
  }
  const raw = value as Record<string, unknown>
  rejectUnknownKeys(raw, new Set(['actor', 'mechanism', 'evidenceIds', 'recordedAt']), 'provenance')
  const actor = raw.actor
  const mechanism = raw.mechanism
  if (actor !== 'user' && actor !== 'assistant' && actor !== 'import') {
    throw new MemoryContractError('invalid provenance.actor')
  }
  if (mechanism !== 'explicit_write' && mechanism !== 'user_confirmed' && mechanism !== 'import') {
    throw new MemoryContractError('invalid provenance.mechanism')
  }
  if (!Array.isArray(raw.evidenceIds) || !raw.evidenceIds.every((item) => typeof item === 'string')) {
    throw new MemoryContractError('provenance.evidenceIds must be an array of strings')
  }
  if (typeof raw.recordedAt !== 'string') {
    throw new MemoryContractError('provenance.recordedAt must be a string')
  }
  const provenance: Provenance = {
    actor,
    mechanism,
    evidenceIds: [...raw.evidenceIds],
    recordedAt: raw.recordedAt,
  }
  assertProvenance(provenance)
  return provenance
}

/**
 * Decode one persisted record through domain validation.
 * Hand-edited or corrupt JSON cannot enter the service without passing these checks.
 */
export function parseMemoryRecord(value: unknown): MemoryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryContractError('memory record must be an object')
  }
  const raw = value as Record<string, unknown>
  rejectUnknownKeys(raw, RECORD_KEYS, 'memory record')

  const category = requireNonEmptyString(raw, 'category')
  assertCategory(category)
  const polarity = requireNonEmptyString(raw, 'polarity') as Polarity
  assertPolarity(polarity)
  const status = requireNonEmptyString(raw, 'status')
  if (status !== 'active' && status !== 'superseded' && status !== 'deleted') {
    throw new MemoryContractError('invalid memory status')
  }
  const visibility = requireNonEmptyString(raw, 'visibility')
  if (visibility !== 'model' && visibility !== 'internal') {
    throw new MemoryContractError('invalid memory visibility')
  }

  const createdAt = requireNonEmptyString(raw, 'createdAt')
  const updatedAt = requireNonEmptyString(raw, 'updatedAt')
  assertIsoInstant(createdAt, 'createdAt')
  assertIsoInstant(updatedAt, 'updatedAt')

  const record: MemoryRecord = {
    id: requireNonEmptyString(raw, 'id'),
    category,
    topicKey: requireNonEmptyString(raw, 'topicKey'),
    statement: requireNonEmptyString(raw, 'statement'),
    polarity,
    confidence: parseConfidence(raw.confidence),
    provenance: parseProvenance(raw.provenance),
    createdAt,
    updatedAt,
    status,
    visibility,
  }

  if (status === 'superseded') {
    if (typeof raw.supersededBy !== 'string' || raw.supersededBy.trim().length === 0) {
      throw new MemoryContractError('superseded memory requires supersededBy')
    }
    if ('deletedAt' in raw) throw new MemoryContractError('superseded memory must not include deletedAt')
    return { ...record, supersededBy: raw.supersededBy }
  }
  if (status === 'deleted') {
    if (typeof raw.deletedAt !== 'string') {
      throw new MemoryContractError('deleted memory requires deletedAt')
    }
    assertIsoInstant(raw.deletedAt, 'deletedAt')
    if ('supersededBy' in raw) throw new MemoryContractError('deleted memory must not include supersededBy')
    return { ...record, deletedAt: raw.deletedAt }
  }
  if ('supersededBy' in raw || 'deletedAt' in raw) {
    throw new MemoryContractError('active memory must not include supersededBy or deletedAt')
  }
  return record
}
