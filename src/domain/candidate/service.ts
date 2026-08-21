import path from 'node:path'
import type { RegistryReadModel } from '../resolution/types.js'
import { diffAgainstBase } from './diff.js'
import { CandidateContractError, SealedCandidateError, WorkspaceEscapeError } from './errors.js'
import { ensureDir, listSourceFiles, readSourceFile, removeTree, writeSourceFile } from './files.js'
import { assertChangeReview, defaultProvenance, normalizeManifest } from './manifest.js'
import { candidateDirName, resolveInsideRoot } from './paths.js'
import type {
  CandidateDiff,
  CandidateManifestInput,
  CandidateRecord,
  CandidateValidation,
  CandidateWorkspace,
  CreateCandidateInput,
  ValidationReport,
} from './types.js'
import { lifecycleFromReport, runValidation } from './validation.js'

interface MutableCandidate extends CandidateRecord {
  lifecycle: CandidateRecord['lifecycle']
  digest?: string
  validation?: ValidationReport
  sealed: boolean
  manifest: CandidateRecord['manifest']
}

export interface CandidateServiceOptions {
  readonly restore?: readonly CandidateRecord[]
  readonly persist?: (records: readonly CandidateRecord[]) => void
}

export class CandidateService implements CandidateWorkspace, CandidateValidation {
  private readonly records = new Map<string, MutableCandidate>()
  private readonly persistRecords?: (records: readonly CandidateRecord[]) => void

  constructor(
    private readonly registry: RegistryReadModel,
    private readonly areaRoot: string,
    options: CandidateServiceOptions = {},
  ) {
    this.persistRecords = options.persist
    for (const record of options.restore ?? []) {
      this.records.set(record.id, { ...record })
    }
  }

  create(input: CreateCandidateInput): CandidateRecord {
    assertChangeReview(input.review)
    const provenance = input.provenance ?? defaultProvenance(input.review, input.owner)
    const manifest = normalizeManifest(
      input.review,
      input.owner,
      input.version,
      input.baseVersion ?? input.review.target?.version,
      provenance,
      input.manifest,
    )
    const id = candidateDirName(manifest.owner, manifest.version)
    if (this.records.has(id)) {
      throw new CandidateContractError(`candidate already exists: ${id}`)
    }
    const workspaceRoot = path.join(this.areaRoot, id)
    ensureDir(workspaceRoot)
    writeSourceFile(workspaceRoot, 'candidate.manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
    const record: MutableCandidate = {
      id,
      owner: manifest.owner,
      version: manifest.version,
      baseVersion: manifest.baseVersion,
      provenance,
      lifecycle: 'planned',
      workspaceRoot,
      manifest,
      sealed: false,
    }
    this.records.set(id, record)
    this.flush()
    return this.snapshot(record)
  }

  get(id: string): CandidateRecord {
    return this.snapshot(this.require(id))
  }

  list(): readonly CandidateRecord[] {
    return [...this.records.values()].map((record) => this.snapshot(record))
  }

  writeFile(id: string, relativePath: string, content: string): CandidateRecord {
    const record = this.require(id)
    this.assertMutable(record)
    writeSourceFile(record.workspaceRoot, relativePath, content)
    const next = this.snapshot(this.markDeveloping(record))
    this.flush()
    return next
  }

  readFile(id: string, relativePath: string): string {
    return readSourceFile(this.require(id).workspaceRoot, relativePath)
  }

  listFiles(id: string): readonly string[] {
    return listSourceFiles(this.require(id).workspaceRoot)
  }

  link(_id: string, _relativePath: string, _target: string): never {
    throw new WorkspaceEscapeError('symlink creation is not allowed in candidate workspaces')
  }

  setManifest(id: string, manifest: CandidateManifestInput): CandidateRecord {
    const record = this.require(id)
    this.assertMutable(record)
    record.manifest = normalizeManifest(
      {
        kind: record.manifest.resolutionKind,
        capability: record.manifest.resolutionCapability,
        need: record.manifest.resolutionNeed,
        recommendation: '',
        rationale: '',
        implications: [],
        assumptions: [],
        unresolved: [],
        steps: [],
        registryFacts: { exact: { kind: 'unknown', capability: record.manifest.resolutionCapability }, domainOwners: [], conflicts: [] },
      },
      record.owner,
      record.version,
      record.baseVersion,
      record.provenance,
      manifest,
    )
    writeSourceFile(record.workspaceRoot, 'candidate.manifest.json', `${JSON.stringify(record.manifest, null, 2)}\n`)
    const next = this.snapshot(this.markDeveloping(record))
    this.flush()
    return next
  }

  diff(id: string): CandidateDiff {
    const record = this.require(id)
    const owned = this.registry.list({ owner: record.owner })
    const base = record.baseVersion === undefined
      ? owned.find((item) => item.status === 'active')
      : owned.find((item) => item.version === record.baseVersion)
    return diffAgainstBase(record.manifest, base)
  }

  discard(id: string): void {
    const record = this.require(id)
    removeTree(record.workspaceRoot)
    this.records.delete(id)
    this.flush()
  }

  seal(id: string): CandidateRecord {
    const record = this.require(id)
    if (record.lifecycle !== 'validated' && record.lifecycle !== 'validation-failed' && record.lifecycle !== 'validation-incomplete') {
      throw new CandidateContractError(`cannot seal candidate ${id} before validation`)
    }
    record.sealed = true
    const next = this.snapshot(record)
    this.flush()
    return next
  }

  validate(id: string): ValidationReport {
    const record = this.require(id)
    if (record.sealed) {
      throw new SealedCandidateError(`sealed candidate ${id} cannot be re-validated in place`)
    }
    record.lifecycle = 'validation-pending'
    const report = runValidation(record)
    record.digest = report.digest
    record.validation = report
    record.lifecycle = lifecycleFromReport(report)
    this.flush()
    return report
  }

  private require(id: string): MutableCandidate {
    const record = this.records.get(id)
    if (record === undefined) throw new CandidateContractError(`unknown candidate: ${id}`)
    return record
  }

  private assertMutable(record: MutableCandidate): void {
    if (record.sealed) {
      throw new SealedCandidateError(`sealed candidate ${record.id} is immutable; create a new revision`)
    }
  }

  private markDeveloping(record: MutableCandidate): MutableCandidate {
    record.lifecycle = 'developing'
    record.digest = undefined
    record.validation = undefined
    return record
  }

  private flush(): void {
    this.persistRecords?.([...this.records.values()].map((record) => this.snapshot(record)))
  }

  private snapshot(record: MutableCandidate): CandidateRecord {
    return {
      id: record.id,
      owner: record.owner,
      version: record.version,
      baseVersion: record.baseVersion,
      provenance: record.provenance,
      lifecycle: record.lifecycle,
      workspaceRoot: record.workspaceRoot,
      manifest: record.manifest,
      digest: record.digest,
      validation: record.validation,
      sealed: record.sealed,
    }
  }
}

export function assertWorkspacePath(root: string, relativePath: string): string {
  return resolveInsideRoot(root, relativePath)
}
