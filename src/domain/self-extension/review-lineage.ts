import { existsSync, readFileSync } from 'node:fs'
import { writeJsonAtomic } from '../persistence/atomic.js'
import type { ReviewFinding, ReviewReport } from '../review/types.js'
import type { DurableAuthorityStore } from './authority-store.js'
import { PersistenceIntegrityError, PersistenceSchemaError } from './errors.js'
import { SELF_EXTENSION_SCHEMA_VERSION, type SelfExtensionHome } from './home.js'

export interface ReviewLineageFile {
  readonly schemaVersion: number
  readonly reports: readonly ReviewReport[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFinding(value: unknown, index: number): ReviewFinding {
  if (!isObject(value)) throw new PersistenceIntegrityError(`review finding ${index} must be an object`)
  if (typeof value.id !== 'string' || typeof value.claim !== 'string' || typeof value.status !== 'string') {
    throw new PersistenceIntegrityError(`review finding ${index} is missing id, claim, or status`)
  }
  if (typeof value.blocking !== 'boolean' || typeof value.reviewedDigest !== 'string') {
    throw new PersistenceIntegrityError(`review finding ${index} is missing blocking or reviewedDigest`)
  }
  return value as unknown as ReviewFinding
}

function parseReport(value: unknown, index: number): ReviewReport {
  if (!isObject(value)) throw new PersistenceIntegrityError(`review report ${index} must be an object`)
  if (typeof value.candidateId !== 'string' || typeof value.digest !== 'string') {
    throw new PersistenceIntegrityError(`review report ${index} is missing candidateId or digest`)
  }
  if (!Array.isArray(value.findings)) {
    throw new PersistenceIntegrityError(`review report ${index} findings must be an array`)
  }
  if (value.approvalStatus !== 'NOT APPROVED') {
    throw new PersistenceIntegrityError(`review report ${index} cannot self-assert approval`)
  }
  return {
    ...(value as unknown as ReviewReport),
    findings: value.findings.map((item, findingIndex) => parseFinding(item, findingIndex)),
    approvalStatus: 'NOT APPROVED',
  }
}

export function parseReviewLineageFile(parsed: unknown): ReviewLineageFile {
  if (!isObject(parsed)) throw new PersistenceIntegrityError('review lineage file must be an object')
  if (parsed.schemaVersion !== SELF_EXTENSION_SCHEMA_VERSION) {
    throw new PersistenceSchemaError(`unsupported review lineage schema ${String(parsed.schemaVersion)}`)
  }
  if (!Array.isArray(parsed.reports)) throw new PersistenceIntegrityError('review lineage reports must be an array')
  return {
    schemaVersion: SELF_EXTENSION_SCHEMA_VERSION,
    reports: parsed.reports.map((item, index) => parseReport(item, index)),
  }
}

/** Host-owned durable ReviewReport history. Reconstructs after restart; corrupt or expected-missing files fail closed. */
export class DurableReviewLineage {
  private reports: ReviewReport[] = []
  readonly lineageUnavailable: boolean

  constructor(
    private readonly home: SelfExtensionHome,
    private readonly authority?: DurableAuthorityStore,
  ) {
    const expected = (authority?.snapshot().reviewLineage.generation ?? 0) > 0
    const present = existsSync(home.reviewLineagePath)
    this.lineageUnavailable = expected && !present
    if (!present) return
    try {
      this.reports = [...parseReviewLineageFile(JSON.parse(readFileSync(home.reviewLineagePath, 'utf8'))).reports]
    } catch (error) {
      if (error instanceof PersistenceIntegrityError || error instanceof PersistenceSchemaError) throw error
      throw new PersistenceIntegrityError(`review lineage is corrupt: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (authority && authority.snapshot().reviewLineage.generation === 0) {
      authority.saveReviewLineage({ generation: 1 })
    }
  }

  restore(): readonly ReviewReport[] {
    return this.reports
  }

  save(reports: readonly ReviewReport[]): void {
    this.reports = [...reports]
    const file: ReviewLineageFile = { schemaVersion: SELF_EXTENSION_SCHEMA_VERSION, reports: this.reports }
    writeJsonAtomic(this.home.reviewLineagePath, file)
    if (!this.authority) return
    this.authority.saveReviewLineage({ generation: this.authority.snapshot().reviewLineage.generation + 1 })
  }
}
