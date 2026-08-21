import { existsSync, readFileSync } from 'node:fs'
import type { RegistryPersistence } from '../registry/persistence.js'
import type { RegistryRecordSnapshot } from '../registry/snapshot.js'
import { writeJsonAtomic } from '../persistence/atomic.js'
import { PersistenceIntegrityError, PersistenceSchemaError } from './errors.js'
import { SELF_EXTENSION_SCHEMA_VERSION, type SelfExtensionHome } from './home.js'
import type { ActivationFailure, ActivationPhase, ActivationSnapshot, ActivationState, ApprovalRecord } from '../governance/types.js'

export interface DurableActivationSection {
  readonly state: ActivationState
  readonly generation: number
  readonly phase?: ActivationPhase
  readonly pendingCandidateId?: string
}

export interface DurableRecoverySection {
  readonly current?: ActivationSnapshot
  readonly lastKnownGood?: ActivationSnapshot
  readonly rollbackTarget?: ActivationSnapshot
  readonly lastFailure?: ActivationFailure
  readonly safeMode: boolean
  readonly diagnostics: readonly string[]
}

export interface DurableGovernanceSection {
  readonly approvals: readonly ApprovalRecord[]
  readonly nextApproval: number
}

/** Host metadata: generation 0 is first-ever empty history; generation > 0 means lineage file is expected. */
export interface DurableReviewLineageSection {
  readonly generation: number
}

export interface AuthorityFile {
  readonly schemaVersion: number
  readonly registry: { readonly records: readonly RegistryRecordSnapshot[] }
  readonly governance: DurableGovernanceSection
  readonly activation: DurableActivationSection
  readonly recovery: DurableRecoverySection
  readonly reviewLineage: DurableReviewLineageSection
}

const EMPTY_REVIEW_LINEAGE: DurableReviewLineageSection = { generation: 0 }

const EMPTY_AUTHORITY: AuthorityFile = {
  schemaVersion: SELF_EXTENSION_SCHEMA_VERSION,
  registry: { records: [] },
  governance: { approvals: [], nextApproval: 1 },
  activation: { state: 'idle', generation: 0 },
  recovery: { safeMode: false, diagnostics: [] },
  reviewLineage: EMPTY_REVIEW_LINEAGE,
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseAuthorityFile(parsed: unknown): AuthorityFile {
  if (!isObject(parsed)) throw new PersistenceIntegrityError('authority file must be an object')
  if (parsed.schemaVersion === undefined) throw new PersistenceIntegrityError('authority file is missing schemaVersion')
  if (parsed.schemaVersion !== SELF_EXTENSION_SCHEMA_VERSION) {
    throw new PersistenceSchemaError(`unsupported self-extension schema ${String(parsed.schemaVersion)}`)
  }
  if (!isObject(parsed.registry) || !Array.isArray(parsed.registry.records)) {
    throw new PersistenceIntegrityError('authority.registry.records must be an array')
  }
  if (!isObject(parsed.governance) || !Array.isArray(parsed.governance.approvals)) {
    throw new PersistenceIntegrityError('authority.governance.approvals must be an array')
  }
  if (!isObject(parsed.activation) || typeof parsed.activation.state !== 'string') {
    throw new PersistenceIntegrityError('authority.activation.state is required')
  }
  if (!isObject(parsed.recovery) || typeof parsed.recovery.safeMode !== 'boolean') {
    throw new PersistenceIntegrityError('authority.recovery.safeMode is required')
  }
  return {
    ...(parsed as unknown as AuthorityFile),
    reviewLineage: parseReviewLineageSection(parsed.reviewLineage),
  }
}

function parseReviewLineageSection(value: unknown): DurableReviewLineageSection {
  if (value === undefined) return EMPTY_REVIEW_LINEAGE
  if (!isObject(value) || typeof value.generation !== 'number' || !Number.isInteger(value.generation) || value.generation < 0) {
    throw new PersistenceIntegrityError('authority.reviewLineage.generation must be a non-negative integer')
  }
  return { generation: value.generation }
}

/** Single atomic authority file with named ownership sections. */
export class DurableAuthorityStore implements RegistryPersistence {
  private file: AuthorityFile
  private deferred = false

  constructor(private readonly home: SelfExtensionHome) {
    this.file = existsSync(home.authorityPath) ? parseAuthorityFile(JSON.parse(readFileSync(home.authorityPath, 'utf8'))) : EMPTY_AUTHORITY
  }

  beginDeferredWrites(): void {
    this.deferred = true
  }

  endDeferredWrites(): void {
    this.deferred = false
  }

  snapshot(): AuthorityFile {
    return structuredClone(this.file)
  }

  load(): readonly unknown[] {
    return structuredClone(this.file.registry.records)
  }

  save(records: readonly RegistryRecordSnapshot[]): void {
    this.replace({ registry: { records: records.map((row) => structuredClone(row)) } })
  }

  saveGovernance(section: DurableGovernanceSection): void {
    this.replace({ governance: structuredClone(section) })
  }

  saveActivation(section: DurableActivationSection): void {
    this.replace({ activation: structuredClone(section) })
  }

  saveRecovery(section: DurableRecoverySection): void {
    this.replace({ recovery: structuredClone(section) })
  }

  saveReviewLineage(section: DurableReviewLineageSection): void {
    this.replace({ reviewLineage: structuredClone(section) })
  }

  appendDiagnostic(message: string): void {
    this.replace({
      recovery: {
        ...this.file.recovery,
        diagnostics: [...this.file.recovery.diagnostics, message].slice(-32),
      },
    })
  }

  /** One atomic replace of every authority section. */
  commitAll(file: AuthorityFile): void {
    this.file = {
      ...structuredClone(file),
      schemaVersion: SELF_EXTENSION_SCHEMA_VERSION,
      reviewLineage: file.reviewLineage ?? EMPTY_REVIEW_LINEAGE,
    }
    writeJsonAtomic(this.home.authorityPath, this.file)
  }

  private replace(patch: Partial<AuthorityFile>): void {
    this.file = {
      ...this.file,
      schemaVersion: SELF_EXTENSION_SCHEMA_VERSION,
      ...patch,
    }
    if (!this.deferred) writeJsonAtomic(this.home.authorityPath, this.file)
  }
}
