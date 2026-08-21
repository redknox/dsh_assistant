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

export function parseCandidateIndexFile(parsed: unknown): CandidateIndexFile {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PersistenceIntegrityError('candidate index must be an object')
  }
  const file = parsed as { schemaVersion?: unknown; candidates?: unknown }
  if (file.schemaVersion !== SELF_EXTENSION_SCHEMA_VERSION) {
    throw new PersistenceSchemaError(`unsupported candidate index schema ${String(file.schemaVersion)}`)
  }
  if (!Array.isArray(file.candidates)) throw new PersistenceIntegrityError('candidate index candidates must be an array')
  return { schemaVersion: SELF_EXTENSION_SCHEMA_VERSION, candidates: file.candidates as CandidateIndexRow[] }
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
      workspaceRoot: path.join(areaRoot, row.record.id),
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
