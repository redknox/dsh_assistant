import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MEMORY_CATEGORIES, type MemoryRecord } from '../../domain/memory/types.js'
import { MemoryContractError } from '../../domain/memory/normalize.js'
import type { MemoryPersistence } from '../../domain/memory/persistence.js'

/** File-format DTO. Must be decoded into domain records; it is not the domain model. */
interface JsonMemoryFileDto {
  version: 1
  records: unknown[]
}

/** Local JSON snapshot adapter for development/testing. Not a production database. */
export class JsonFileMemoryPersistence implements MemoryPersistence {
  constructor(private readonly filePath: string) {}

  load(): MemoryRecord[] {
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      return decodeFile(parsed)
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }
  }

  save(records: readonly MemoryRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const payload: JsonMemoryFileDto = { version: 1, records: records.map(encodeRecord) }
    const tempPath = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tempPath, this.filePath)
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ENOENT'
}

function decodeFile(parsed: unknown): MemoryRecord[] {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MemoryContractError('json memory file must be an object')
  }
  const file = parsed as { version?: unknown; records?: unknown }
  if (file.version !== 1) {
    throw new MemoryContractError('unsupported json memory file version')
  }
  if (!Array.isArray(file.records)) {
    throw new MemoryContractError('json memory file records must be an array')
  }
  return file.records.map((record, index) => decodeRecord(record, index))
}

function encodeRecord(record: MemoryRecord): Record<string, unknown> {
  return {
    id: record.id,
    category: record.category,
    topicKey: record.topicKey,
    statement: record.statement,
    polarity: record.polarity,
    confidence: record.confidence,
    provenance: record.provenance,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    visibility: record.visibility,
    ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}),
    ...(record.deletedAt ? { deletedAt: record.deletedAt } : {}),
  }
}

function decodeRecord(value: unknown, index: number): MemoryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryContractError(`json memory record ${index} must be an object`)
  }
  const raw = value as Record<string, unknown>
  const category = requireString(raw, 'category', index)
  if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
    throw new MemoryContractError(`json memory record ${index} has unknown category`)
  }
  const polarity = requireString(raw, 'polarity', index)
  if (polarity !== 'true' && polarity !== 'false' && polarity !== 'unknown') {
    throw new MemoryContractError(`json memory record ${index} has invalid polarity`)
  }
  const status = requireString(raw, 'status', index)
  if (status !== 'active' && status !== 'superseded' && status !== 'deleted') {
    throw new MemoryContractError(`json memory record ${index} has invalid status`)
  }
  const visibility = requireString(raw, 'visibility', index)
  if (visibility !== 'model' && visibility !== 'internal') {
    throw new MemoryContractError(`json memory record ${index} has invalid visibility`)
  }
  const record: MemoryRecord = {
    id: requireString(raw, 'id', index),
    category: category as MemoryRecord['category'],
    topicKey: requireString(raw, 'topicKey', index),
    statement: requireString(raw, 'statement', index),
    polarity,
    confidence: decodeConfidence(raw.confidence, index),
    provenance: decodeProvenance(raw.provenance, index),
    createdAt: requireString(raw, 'createdAt', index),
    updatedAt: requireString(raw, 'updatedAt', index),
    status,
    visibility,
  }
  if (typeof raw.supersededBy === 'string') {
    return { ...record, supersededBy: raw.supersededBy }
  }
  if (typeof raw.deletedAt === 'string') {
    return { ...record, deletedAt: raw.deletedAt }
  }
  return record
}

function decodeConfidence(value: unknown, index: number): MemoryRecord['confidence'] {
  if (typeof value !== 'object' || value === null) {
    throw new MemoryContractError(`json memory record ${index} has invalid confidence`)
  }
  const raw = value as { kind?: unknown; value?: unknown }
  if (raw.kind === 'unknown') return { kind: 'unknown' }
  if (raw.kind === 'score' && typeof raw.value === 'number' && Number.isFinite(raw.value)) {
    return { kind: 'score', value: raw.value }
  }
  throw new MemoryContractError(`json memory record ${index} has invalid confidence`)
}

function decodeProvenance(value: unknown, index: number): MemoryRecord['provenance'] {
  if (typeof value !== 'object' || value === null) {
    throw new MemoryContractError(`json memory record ${index} has invalid provenance`)
  }
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.evidenceIds) || !raw.evidenceIds.every((item) => typeof item === 'string')) {
    throw new MemoryContractError(`json memory record ${index} has invalid provenance.evidenceIds`)
  }
  const actor = raw.actor
  const mechanism = raw.mechanism
  if (actor !== 'user' && actor !== 'assistant' && actor !== 'import') {
    throw new MemoryContractError(`json memory record ${index} has invalid provenance.actor`)
  }
  if (mechanism !== 'explicit_write' && mechanism !== 'user_confirmed' && mechanism !== 'import') {
    throw new MemoryContractError(`json memory record ${index} has invalid provenance.mechanism`)
  }
  if (typeof raw.recordedAt !== 'string') {
    throw new MemoryContractError(`json memory record ${index} has invalid provenance.recordedAt`)
  }
  return { actor, mechanism, evidenceIds: [...raw.evidenceIds], recordedAt: raw.recordedAt }
}

function requireString(raw: Record<string, unknown>, key: string, index: number): string {
  const value = raw[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new MemoryContractError(`json memory record ${index} missing ${key}`)
  }
  return value
}
