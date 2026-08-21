import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { CandidateRecord } from '../candidate/types.js'
import { writeJsonAtomic } from '../persistence/atomic.js'
import { PersistenceIntegrityError, PersistenceSchemaError } from './errors.js'
import { SELF_EXTENSION_SCHEMA_VERSION, type SelfExtensionHome } from './home.js'

export const ARTIFACT_RETENTIONS = [
  'candidate',
  'sealed',
  'active',
  'retired',
  'rollback-retained',
  'rejected',
] as const
export type ArtifactRetention = (typeof ARTIFACT_RETENTIONS)[number]

export interface CandidateIndexRow {
  readonly record: CandidateRecord
  readonly retention: ArtifactRetention
}

export interface CandidateIndexFile {
  readonly schemaVersion: number
  readonly candidates: readonly CandidateIndexRow[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Resolve an artifact directory and refuse any path that leaves `area`. */
export function resolveCandidateArtifactDir(area: string, id: string): string {
  assertCandidateArtifactId(id)
  const root = path.resolve(area)
  const dest = path.resolve(root, id)
  const rel = path.relative(root, dest)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).length !== 1) {
    throw new PersistenceIntegrityError(`candidate artifact path escapes candidate area: ${id}`)
  }
  return dest
}

/** Candidate artifact ids are a single path segment, never a relative or absolute path. */
export function assertCandidateArtifactId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id === '' || id !== id.trim()) {
    throw new PersistenceIntegrityError('candidate id must be a non-empty identifier')
  }
  const unix = id.replaceAll('\\', '/')
  if (path.isAbsolute(id) || path.isAbsolute(unix) || unix.startsWith('/') || unix.startsWith('~')) {
    throw new PersistenceIntegrityError(`candidate id must not be an absolute path: ${id}`)
  }
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new PersistenceIntegrityError(`candidate id must be a single path segment: ${id}`)
  }
  if (id === '.' || id === '..' || id.includes('..')) {
    throw new PersistenceIntegrityError(`candidate id must not contain path traversal: ${id}`)
  }
}

function parseIndexRow(value: unknown): CandidateIndexRow {
  if (!isObject(value)) throw new PersistenceIntegrityError('candidate index row must be an object')
  if (!ARTIFACT_RETENTIONS.includes(value.retention as ArtifactRetention)) {
    throw new PersistenceIntegrityError(`unsupported candidate retention ${String(value.retention)}`)
  }
  if (!isObject(value.record)) throw new PersistenceIntegrityError('candidate index record must be an object')
  assertCandidateArtifactId(value.record.id)
  if (value.record.workspaceRoot !== undefined) assertCandidateArtifactId(value.record.workspaceRoot)
  if (typeof value.record.sealed !== 'boolean') {
    throw new PersistenceIntegrityError('candidate index record.sealed must be a boolean')
  }
  return {
    retention: value.retention as ArtifactRetention,
    record: value.record as unknown as CandidateIndexRow['record'],
  }
}

export function parseCandidateIndexFile(parsed: unknown): CandidateIndexFile {
  if (!isObject(parsed)) throw new PersistenceIntegrityError('candidate index must be an object')
  if (parsed.schemaVersion !== SELF_EXTENSION_SCHEMA_VERSION) {
    throw new PersistenceSchemaError(`unsupported candidate index schema ${String(parsed.schemaVersion)}`)
  }
  if (!Array.isArray(parsed.candidates)) throw new PersistenceIntegrityError('candidate index candidates must be an array')
  return {
    schemaVersion: SELF_EXTENSION_SCHEMA_VERSION,
    candidates: parsed.candidates.map((row, index) => {
      try {
        return parseIndexRow(row)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new PersistenceIntegrityError(`candidate index row ${index}: ${message}`)
      }
    }),
  }
}

export function retentionFor(record: CandidateRecord, activeIds: ReadonlySet<string>): ArtifactRetention {
  if (activeIds.has(record.id)) return 'active'
  if (record.lifecycle === 'validation-failed') return 'rejected'
  if (record.sealed) return 'sealed'
  return 'candidate'
}

export class DurableCandidateIndex {
  private rows: CandidateIndexRow[] = []

  constructor(private readonly home: SelfExtensionHome) {
    if (!existsSync(home.candidateIndexPath)) return
    this.rows = [...parseCandidateIndexFile(JSON.parse(readFileSync(home.candidateIndexPath, 'utf8'))).candidates]
  }

  restore(areaRoot: string): CandidateRecord[] {
    return this.rows.map((row) => ({
      ...row.record,
      workspaceRoot: resolveCandidateArtifactDir(areaRoot, row.record.id),
    }))
  }

  save(records: readonly CandidateRecord[], activeIds: ReadonlySet<string> = new Set()): void {
    this.rows = records.map((record) => ({
      record: { ...record, workspaceRoot: record.id },
      retention: retentionFor(record, activeIds),
    }))
    const file: CandidateIndexFile = { schemaVersion: SELF_EXTENSION_SCHEMA_VERSION, candidates: this.rows }
    writeJsonAtomic(this.home.candidateIndexPath, file)
  }

  mark(id: string, retention: ArtifactRetention): void {
    this.rows = this.rows.map((row) => row.record.id === id ? { ...row, retention } : row)
    const file: CandidateIndexFile = { schemaVersion: SELF_EXTENSION_SCHEMA_VERSION, candidates: this.rows }
    writeJsonAtomic(this.home.candidateIndexPath, file)
  }
}
