import { existsSync, lstatSync, opendirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { defaultProvenance } from '../candidate/manifest.js'
import type { CandidateManifestInput, CandidateRecord, CandidateValidation, CandidateWorkspace } from '../candidate/types.js'
import type { ExtensionGovernance } from '../governance/types.js'
import type { CapabilityResolution, ResolutionReview } from '../resolution/types.js'
import type { IndependentReview, ReviewReport } from '../review/types.js'
import { WorkbenchContractError } from './errors.js'
import {
  WORKBENCH_CHANGE_KINDS,
  WORKBENCH_MAX_FILE_BYTES,
  WORKBENCH_MAX_FILE_COUNT,
  WORKBENCH_MAX_LIST_DEPTH,
  WORKBENCH_MAX_TRAVERSAL_ENTRIES,
  WORKBENCH_MAX_WORKSPACE_BYTES,
  type CandidateWorkbench,
  type WorkbenchCandidateView,
  type WorkbenchCreateInput,
  type WorkbenchPlan,
  type WorkbenchPlanView,
} from './types.js'

interface Binding {
  readonly planId: string
  readonly parentId?: string
  readonly parentDigest?: string
}

export class WorkbenchService implements CandidateWorkbench {
  private nextPlan = 1
  private readonly plans = new Map<string, WorkbenchPlan>()
  private readonly bindings = new Map<string, Binding>()

  constructor(
    private readonly resolution: CapabilityResolution,
    private readonly workspace: CandidateWorkspace,
    private readonly validation: CandidateValidation,
    private readonly independentReview: IndependentReview,
    private readonly governance: ExtensionGovernance,
  ) {}

  plan(input: { capability: string; need: string; behavior?: string }): WorkbenchPlanView {
    const review = this.resolution.review({
      capability: input.capability,
      need: input.need,
      behavior: input.behavior,
    })
    return this.rememberPlan(review)
  }

  rememberPlan(review: ResolutionReview): WorkbenchPlanView {
    const id = `plan-${this.nextPlan++}`
    this.plans.set(id, { id, review })
    return viewPlan(id, review)
  }

  getPlan(planId: string): WorkbenchPlan {
    const plan = this.plans.get(planId)
    if (!plan) throw new WorkbenchContractError(`unknown workbench plan: ${planId}`)
    return plan
  }

  create(input: WorkbenchCreateInput): WorkbenchCandidateView {
    if (input.owner !== undefined || input.version !== undefined || input.provenance !== undefined) {
      throw new WorkbenchContractError('caller cannot set owner, version, or provenance; those come from the host plan')
    }
    const plan = this.getPlan(input.planId)
    if (!WORKBENCH_CHANGE_KINDS.includes(plan.review.kind as (typeof WORKBENCH_CHANGE_KINDS)[number])) {
      throw new WorkbenchContractError(`resolution kind ${plan.review.kind} does not create a candidate workspace`)
    }
    const identity = identityFromReview(plan.review)
    const record = this.workspace.create({
      review: plan.review,
      owner: identity.owner,
      version: identity.version,
      baseVersion: identity.baseVersion,
      provenance: defaultProvenance(plan.review, identity.owner),
      manifest: input.manifest,
    })
    this.bindings.set(record.id, { planId: plan.id })
    return this.inspect(record.id)
  }

  inspect(candidateId: string): WorkbenchCandidateView {
    const record = this.workspace.get(candidateId)
    const binding = this.bindings.get(candidateId)
    const reviewState = this.independentReview.status({ id: record.id, digest: record.digest })
    const last = this.independentReview.lastReport(record.id)
    return {
      id: record.id,
      owner: record.owner,
      version: record.version,
      baseVersion: record.baseVersion,
      provenance: record.provenance,
      lifecycle: record.lifecycle,
      sealed: record.sealed,
      digest: record.digest,
      resolutionKind: record.manifest.resolutionKind,
      resolutionCapability: record.manifest.resolutionCapability,
      planId: binding?.planId,
      parentId: binding?.parentId,
      validation: record.validation === undefined
        ? undefined
        : {
          passed: record.validation.passed,
          lifecycle: record.lifecycle,
          failed: record.validation.stages.filter((item) => item.status === 'failed' || item.status === 'blocked').map((item) => item.name),
          unresolved: [...record.validation.unresolved],
        },
      review: {
        state: reviewState,
        blockingFindings: last?.findings.filter((item) => item.blocking && item.status === 'open').length ?? 0,
        approvalStatus: 'NOT APPROVED',
      },
      diff: this.workspace.diff(record.id),
      requestEligibility: this.governance.requestEligibility(record.id),
    }
  }

  listFiles(candidateId: string): readonly string[] {
    const record = this.workspace.get(candidateId)
    return listBoundedFiles(record.workspaceRoot)
  }

  readFile(candidateId: string, relativePath: string): string {
    assertRelativePath(relativePath)
    const record = this.workspace.get(candidateId)
    const text = this.workspace.readFile(record.id, relativePath)
    if (Buffer.byteLength(text, 'utf8') > WORKBENCH_MAX_FILE_BYTES) {
      throw new WorkbenchContractError(`candidate file exceeds the ${WORKBENCH_MAX_FILE_BYTES} byte bound`)
    }
    return text
  }

  writeFile(candidateId: string, relativePath: string, content: string): WorkbenchCandidateView {
    assertRelativePath(relativePath)
    if (Buffer.byteLength(content, 'utf8') > WORKBENCH_MAX_FILE_BYTES) {
      throw new WorkbenchContractError(`candidate write exceeds the ${WORKBENCH_MAX_FILE_BYTES} byte bound`)
    }
    const record = this.workspace.get(candidateId)
    assertWorkspaceBudget(record, relativePath, content)
    this.workspace.writeFile(record.id, relativePath, content)
    return this.inspect(record.id)
  }

  setManifest(candidateId: string, manifest: CandidateManifestInput): WorkbenchCandidateView {
    if (manifest.validationTasks?.some((task) => task.argv !== undefined || task.script !== undefined)) {
      throw new WorkbenchContractError('candidate manifest cannot include argv, scripts, or a shell runner')
    }
    this.workspace.setManifest(candidateId, manifest)
    return this.inspect(candidateId)
  }

  validate(candidateId: string): WorkbenchCandidateView {
    this.validation.validate(candidateId)
    return this.inspect(candidateId)
  }

  seal(candidateId: string): WorkbenchCandidateView {
    this.workspace.seal(candidateId)
    return this.inspect(candidateId)
  }

  review(candidateId: string): ReviewReport {
    const record = this.workspace.get(candidateId)
    const parentId = this.bindings.get(candidateId)?.parentId
    return this.independentReview.reviewCandidate(record.id, parentId === undefined ? {} : { parentRevision: parentId })
  }

  inspectReview(candidateId: string) {
    const record = this.workspace.get(candidateId)
    return {
      state: this.independentReview.status({ id: record.id, digest: record.digest }),
      report: this.independentReview.lastReport(record.id),
    }
  }

  repair(candidateId: string): WorkbenchCandidateView {
    const parent = this.workspace.get(candidateId)
    if (!parent.sealed) throw new WorkbenchContractError('repair requires a sealed parent revision')
    const last = this.independentReview.lastReport(parent.id)
    if (last?.state !== 'changes-required') {
      throw new WorkbenchContractError('repair requires Independent Review changes-required on the parent')
    }
    const binding = this.bindings.get(parent.id)
    const plan = binding?.planId === undefined ? undefined : this.plans.get(binding.planId)
    const review = plan?.review ?? reviewFromRecord(parent)
    const nextVersion = bumpPatch(parent.version)
    const created = this.workspace.create({
      review,
      owner: parent.owner,
      version: nextVersion,
      baseVersion: parent.baseVersion,
      provenance: { kind: parent.provenance.kind, origin: 'assistant' },
      manifest: {
        capabilities: [...parent.manifest.capabilities],
        permissions: [...parent.manifest.permissions],
        runtimeSeams: [...parent.manifest.runtimeSeams],
        tools: [...parent.manifest.tools],
        services: [...parent.manifest.services],
        providers: [...parent.manifest.providers],
        secrets: [...parent.manifest.secrets],
        configRequired: [...parent.manifest.configRequired],
        effects: parent.manifest.effects,
        entryPoints: [...parent.manifest.entryPoints],
        riskModel: parent.manifest.riskModel,
      },
    })
    this.bindings.set(created.id, {
      planId: binding?.planId ?? `inherited-${parent.id}`,
      parentId: parent.id,
      parentDigest: parent.digest,
    })
    if (binding?.planId === undefined) this.plans.set(`inherited-${parent.id}`, { id: `inherited-${parent.id}`, review })
    for (const relative of this.workspace.listFiles(parent.id)) {
      if (relative === 'candidate.manifest.json') continue
      this.workspace.writeFile(created.id, relative, this.workspace.readFile(parent.id, relative))
    }
    return this.inspect(created.id)
  }

  requestApproval(candidateId: string) {
    return this.governance.requestApproval(candidateId)
  }
}

function viewPlan(id: string, review: ResolutionReview): WorkbenchPlanView {
  return {
    planId: id,
    kind: review.kind,
    capability: review.capability,
    need: review.need,
    recommendation: review.recommendation,
    rationale: review.rationale,
    target: review.target,
    canCreate: WORKBENCH_CHANGE_KINDS.includes(review.kind as (typeof WORKBENCH_CHANGE_KINDS)[number]),
    unresolved: review.unresolved,
  }
}

function identityFromReview(review: ResolutionReview): { owner: string; version: string; baseVersion?: string } {
  if (review.kind === 'new-plugin') {
    return { owner: `generated/${review.capability.replaceAll('.', '-')}`, version: '0.1.0' }
  }
  const owner = review.target?.owner
  if (!owner) throw new WorkbenchContractError('host review is missing a target owner')
  const baseVersion = review.target?.version
  if (review.kind === 'adopt-existing' && review.target?.version) {
    return { owner, version: review.target.version, baseVersion }
  }
  return { owner, version: bumpPatch(baseVersion ?? '0.0.0'), baseVersion }
}

function bumpPatch(version: string): string {
  const parts = version.split('.')
  const last = Number(parts[parts.length - 1])
  if (!Number.isInteger(last)) throw new WorkbenchContractError(`cannot bump version ${version}`)
  parts[parts.length - 1] = String(last + 1)
  return parts.join('.')
}

function reviewFromRecord(record: CandidateRecord): ResolutionReview {
  return {
    kind: record.manifest.resolutionKind,
    capability: record.manifest.resolutionCapability,
    need: record.manifest.resolutionNeed,
    recommendation: 'repair revision of a reviewed parent',
    rationale: 'Host-owned parent lineage.',
    implications: [],
    assumptions: [],
    unresolved: [],
    steps: [],
    registryFacts: { exact: { kind: 'unknown', capability: record.manifest.resolutionCapability }, domainOwners: [], conflicts: [] },
    target: { owner: record.owner, version: record.baseVersion },
  }
}

function assertRelativePath(relativePath: string): void {
  if (relativePath.includes('\0')) throw new WorkbenchContractError('path is invalid')
}

function assertWorkspaceBudget(record: CandidateRecord, relativePath: string, content: string): void {
  const files = listBoundedFiles(record.workspaceRoot)
  if (!files.includes(relativePath) && files.length >= WORKBENCH_MAX_FILE_COUNT) {
    throw new WorkbenchContractError(`candidate workspace exceeds the ${WORKBENCH_MAX_FILE_COUNT} file bound`)
  }
  let total = Buffer.byteLength(content, 'utf8')
  for (const file of files) {
    if (file === relativePath) continue
    total += statSync(path.join(record.workspaceRoot, ...file.split('/'))).size
    if (total > WORKBENCH_MAX_WORKSPACE_BYTES) {
      throw new WorkbenchContractError(`candidate workspace exceeds the ${WORKBENCH_MAX_WORKSPACE_BYTES} byte bound`)
    }
  }
  if (total > WORKBENCH_MAX_WORKSPACE_BYTES) {
    throw new WorkbenchContractError(`candidate workspace exceeds the ${WORKBENCH_MAX_WORKSPACE_BYTES} byte bound`)
  }
}

function listBoundedFiles(root: string): string[] {
  const files: string[] = []
  let visited = 0
  const walk = (dirPath: string, rel: string, depth: number) => {
    if (depth > WORKBENCH_MAX_LIST_DEPTH) {
      throw new WorkbenchContractError(`candidate listing exceeded the depth bound of ${WORKBENCH_MAX_LIST_DEPTH}`)
    }
    const dir = opendirSync(dirPath)
    try {
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        visited += 1
        if (visited > WORKBENCH_MAX_TRAVERSAL_ENTRIES) {
          throw new WorkbenchContractError(`candidate listing exceeded the traversal bound of ${WORKBENCH_MAX_TRAVERSAL_ENTRIES}`)
        }
        if (entry.name === '.dsh') continue
        const relative = rel === '' ? entry.name : `${rel}/${entry.name}`
        const full = path.join(dirPath, entry.name)
        if (entry.isSymbolicLink() || (existsSync(full) && lstatSync(full).isSymbolicLink())) {
          throw new WorkbenchContractError(`symlink is not allowed in a candidate workspace: ${relative}`)
        }
        if (entry.isDirectory()) walk(full, relative, depth + 1)
        else if (entry.isFile()) {
          if (files.length >= WORKBENCH_MAX_FILE_COUNT) {
            throw new WorkbenchContractError(`candidate workspace exceeds the ${WORKBENCH_MAX_FILE_COUNT} file bound`)
          }
          files.push(relative)
        }
      }
    } finally {
      dir.closeSync()
    }
  }
  if (existsSync(root) && lstatSync(root).isDirectory()) walk(root, '', 0)
  return files.sort()
}

export function readBoundedFile(root: string, relativePath: string): string {
  const dest = path.join(root, ...relativePath.split('/'))
  const text = readFileSync(dest, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > WORKBENCH_MAX_FILE_BYTES) {
    throw new WorkbenchContractError(`candidate file exceeds the ${WORKBENCH_MAX_FILE_BYTES} byte bound`)
  }
  return text
}
