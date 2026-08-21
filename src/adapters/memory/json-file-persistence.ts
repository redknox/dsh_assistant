import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MemoryContractError } from '../../domain/memory/normalize.js'
import type { MemoryPersistence } from '../../domain/memory/persistence.js'
import { parseMemoryRecord } from '../../domain/memory/record.js'
import type { MemoryRecord } from '../../domain/memory/types.js'

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
  return file.records.map((record, index) => {
    try {
      return parseMemoryRecord(record)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new MemoryContractError(`json memory record ${index}: ${message}`)
    }
  })
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
