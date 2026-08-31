import { closeSync, existsSync, lstatSync, openSync, opendirSync, readFileSync, readSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { contractDigestExtras } from '../candidate/digest.js'
import { defaultProvenance } from '../candidate/manifest.js'
import { isImportedThirdParty } from '../generated-runtime/trust.js'
import { assertGeneratedBrokerPermissions } from '../generated-runtime/broker.js'
import {
  CAPABILITY_EVALUATION_RUNNER,
  CAPABILITY_EVALUATION_SUITE_STAMP,
  CapabilityEvaluationHarness,
} from '../evaluation/index.js'
import { parsePermission } from '../registry/normalize.js'
import { resolveInsideRoot } from '../candidate/paths.js'
import { SealedCandidateError } from '../candidate/errors.js'
import type { CandidateManifest, CandidateManifestInput, CandidateRecord, CandidateValidation, CandidateWorkspace } from '../candidate/types.js'
import type { ExtensionGovernance } from '../governance/types.js'
import type { CapabilityResolution, ResolutionReview } from '../resolution/types.js'
import type { IndependentReview, ReviewReport } from '../review/types.js'
import { AUTHORING_CONTRACT_STAMP, assertSupportedAuthoringContract, authoringContractV1 } from './authoring-contract.js'
import {
  CAPABILITY_SPECIFICATION_STAMP,
  capabilitySpecificationStamp,
  compareCapabilitySpecifications,
  defineCapabilitySpecification,
  normalizeOperationalEffects,
  reviseCapabilitySpecification,
  type CapabilitySpecification,
  type CapabilitySpecificationInput,
  type CapabilitySpecificationPatch,
} from './capability-specification.js'
import { projectValidationDiagnostics } from './diagnostics.js'
import { WorkbenchContractError, WorkbenchRepairRollbackError } from './errors.js'
import {
  boundListLimit,
  candidateStates,
  candidateStep,
  encodeListCursor,
  parseListCursor,
  type WorkbenchListView,
} from './listing.js'
import { parseWorkbenchRiskModel } from './risk-model.js'
import { boundActivationDiagnostics } from '../workspace/failure.js'
import { activationViewOf, compareOwnerVersion, extensionLifecycleOf } from '../workspace/lifecycle.js'
import { parseScaffoldNames, scaffoldFiles } from './scaffold.js'
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
  type WorkbenchListInput,
  type WorkbenchPersistState,
  type WorkbenchPlan,
  type WorkbenchPlanView,
  type WorkbenchScaffoldInput,
  type WorkbenchServiceOptions,
} from './types.js'

interface Binding {
  readonly planId: string
  readonly parentId?: string
  readonly parentDigest?: string
  readonly leftover?: boolean
  readonly runtimeContractVersion?: string
  readonly specificationId?: string
  readonly specificationDigest?: string
}

export class WorkbenchService implements CandidateWorkbench {
  private nextPlan = 1
  private nextSpecification = 1
  private readonly specifications = new Map<string, CapabilitySpecification>()
  private readonly plans = new Map<string, WorkbenchPlan>()
  private readonly bindings = new Map<string, Binding>()
  private readonly evaluation = new CapabilityEvaluationHarness()

  constructor(
    private readonly resolution: CapabilityResolution,
    private readonly workspace: CandidateWorkspace,
    private readonly validation: CandidateValidation,
    private readonly independentReview: IndependentReview,
    private readonly governance: ExtensionGovernance,
    private readonly options: WorkbenchServiceOptions = {},
  ) {
    const restore = options.restore
    if (restore === undefined) return
    this.nextPlan = restore.nextPlan
    this.nextSpecification = restore.nextSpecification
    for (const specification of restore.specifications) this.specifications.set(specification.id, specification)
    for (const plan of restore.plans) this.plans.set(plan.id, plan)
    for (const binding of restore.bindings) {
      this.bindings.set(binding.candidateId, {
        planId: binding.planId,
        parentId: binding.parentId,
        parentDigest: binding.parentDigest,
        leftover: binding.leftover,
        runtimeContractVersion: binding.runtimeContractVersion,
        specificationId: binding.specificationId,
        specificationDigest: binding.specificationDigest,
      })
    }
  }

  defineSpecification(input: CapabilitySpecificationInput): CapabilitySpecification {
    const specification = defineCapabilitySpecification(`spec-${this.nextSpecification++}`, input)
    this.specifications.set(specification.id, specification)
    this.flush()
    return specification
  }

  reviseSpecification(specificationId: string, patch: CapabilitySpecificationPatch): CapabilitySpecification {
    const previous = this.inspectSpecification(specificationId)
    if ([...this.specifications.values()].some((item) => item.supersedesId === previous.id)) {
      throw new WorkbenchContractError(`capability specification ${previous.id} is already superseded; revise its successor`)
    }
    const specification = reviseCapabilitySpecification(`spec-${this.nextSpecification++}`, previous, patch)
    this.specifications.set(specification.id, specification)
    this.flush()
    return specification
  }

  compareSpecifications(fromSpecificationId: string, toSpecificationId: string) {
    return compareCapabilitySpecifications(
      this.inspectSpecification(fromSpecificationId),
      this.inspectSpecification(toSpecificationId),
    )
  }

  inspectSpecification(specificationId: string): CapabilitySpecification {
    const specification = this.specifications.get(specificationId)
    if (!specification) throw new WorkbenchContractError(`unknown capability specification: ${specificationId}`)
    return specification
  }

  inspectSpecificationEvaluation(specificationId: string) {
    const specification = this.inspectSpecification(specificationId)
    const candidate = [...this.workspace.list()].reverse().find((record: CandidateRecord) => this.bindings.get(record.id)?.specificationId === specification.id)
    return {
      specificationId: specification.id,
      specificationDigest: specification.digest,
      ...(candidate === undefined ? {} : {
        candidateId: candidate.id,
        ...(candidate.validation?.evaluation === undefined ? {} : { report: candidate.validation.evaluation }),
      }),
    }
  }

  plan(input: { capability: string; need: string; behavior?: string } | { specificationId: string }): WorkbenchPlanView {
    const specification = 'specificationId' in input
      ? this.inspectSpecification(input.specificationId)
      : this.rememberLegacySpecification(input.capability, input.need, input.behavior)
    if (specification.status !== 'ready') {
      throw new WorkbenchContractError(`capability specification ${specification.id} needs clarification: ${specification.unresolved.join(' ')}`)
    }
    const inventory = this.options.inventory?.snapshot()
    const review = failClosedDiscovery(this.resolution.review({
      capability: specification.capability,
      need: specification.goal,
      ...(specification.businessRules.length === 0 ? {} : { behavior: specification.businessRules.join(' ') }),
      ...(inventory === undefined ? {} : { inventory }),
    }), inventory?.complete === true)
    return this.rememberReview(review, specification)
  }

  rememberPlan(review: ResolutionReview): WorkbenchPlanView {
    return this.rememberReview(review, this.rememberLegacySpecification(review.capability, review.need))
  }

  private rememberReview(review: ResolutionReview, specification: CapabilitySpecification): WorkbenchPlanView {
    const id = `plan-${this.nextPlan++}`
    this.plans.set(id, {
      id,
      review,
      specificationId: specification.id,
      specificationDigest: specification.digest,
    })
    this.flush()
    return viewPlan(id, review, specification)
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
    const specification = this.inspectSpecification(plan.specificationId)
    if (specification.digest !== plan.specificationDigest) {
      throw new WorkbenchContractError(`workbench plan ${plan.id} capability specification digest is stale`)
    }
    if (!WORKBENCH_CHANGE_KINDS.includes(plan.review.kind as (typeof WORKBENCH_CHANGE_KINDS)[number])) {
      throw new WorkbenchContractError(`resolution kind ${plan.review.kind} does not create a candidate workspace`)
    }
    const identity = identityFromReview(plan.review)
    const provenance = defaultProvenance(plan.review, identity.owner)
    if (specification.source === 'explicit') {
      assertExactPermissions(specification.permissions, input.manifest?.permissions ?? [])
      assertExactEffects(specification.effects, normalizeOperationalEffects(input.manifest?.effects ?? {}))
    }
    if (provenance.kind === 'generated') {
      assertGeneratedBrokerPermissions((input.manifest?.permissions ?? []).map(parsePermission))
    }
    const record = this.workspace.create({
      review: plan.review,
      owner: identity.owner,
      version: identity.version,
      baseVersion: identity.baseVersion,
      provenance,
      manifest: { ...input.manifest, runtimeContractVersion: '' },
    })
    this.workspace.writeFile(record.id, CAPABILITY_SPECIFICATION_STAMP, capabilitySpecificationStamp(specification))
    for (const [relativePath, content] of Object.entries(this.evaluation.prepare(specification))) {
      this.workspace.writeFile(record.id, relativePath, content)
    }
    this.bindings.set(record.id, {
      planId: plan.id,
      specificationId: specification.id,
      specificationDigest: specification.digest,
    })
    this.flush()
    return this.inspect(record.id)
  }

  adoptImported(candidateId: string): WorkbenchCandidateView {
    const record = this.workspace.get(candidateId)
    if (!isImportedThirdParty({
      owner: record.owner,
      provenanceKind: record.provenance.kind,
      origin: record.provenance.origin,
    })) {
      throw new WorkbenchContractError('adoptImported only accepts host-stamped third-party imports')
    }
    const existing = this.bindings.get(candidateId)
    if (existing) return this.inspect(candidateId)
    const plan = this.rememberPlan({
      kind: 'adopt-existing',
      capability: record.manifest.resolutionCapability,
      need: record.manifest.resolutionNeed,
      recommendation: 'Imported local third-party bundle awaiting existing validation and governance.',
      rationale: 'Host-stamped third-party import. Bundle claims cannot elevate provenance.',
      implications: [],
      assumptions: [],
      unresolved: [],
      steps: [],
      registryFacts: {
        exact: { kind: 'unknown', capability: record.manifest.resolutionCapability },
        domainOwners: [],
        conflicts: [],
      },
      target: { owner: record.owner, version: record.version },
    })
    this.bindings.set(candidateId, {
      planId: plan.planId,
      runtimeContractVersion: record.manifest.runtimeContractVersion,
    })
    this.flush()
    return this.inspect(candidateId)
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
      parentDigest: binding?.parentDigest,
      validation: record.validation === undefined
        ? undefined
        : {
          passed: record.validation.passed,
          lifecycle: record.lifecycle,
          failed: record.validation.stages.filter((item) => item.status === 'failed' || item.status === 'blocked').map((item) => item.name),
          unresolved: [...record.validation.unresolved],
          ...(record.validation.evaluation === undefined ? {} : { evaluation: record.validation.evaluation }),
        },
      review: {
        state: reviewState,
        blockingFindings: last?.findings.filter((item) => item.blocking && item.status === 'open').length ?? 0,
      },
      ...this.lifecycleOf(record),
      diff: this.workspace.diff(record.id),
      requestEligibility: this.governance.requestEligibility(record.id),
      step: this.stepOf(record.id),
      leftover: binding?.leftover === true,
      contractVersion: binding?.runtimeContractVersion ?? record.manifest.runtimeContractVersion,
      specification: binding?.specificationId === undefined ? undefined : this.specifications.get(binding.specificationId),
    }
  }

  inspectAuthoringContract(version?: string) {
    try {
      assertSupportedAuthoringContract(version)
    } catch (error) {
      throw new WorkbenchContractError(error instanceof Error ? error.message : String(error))
    }
    return authoringContractV1()
  }

  scaffold(input: WorkbenchScaffoldInput): WorkbenchCandidateView {
    const record = this.workspace.get(input.candidateId)
    assertImportedReadOnly(record)
    if (record.sealed) throw new WorkbenchContractError('cannot scaffold a sealed candidate')
    const plan = this.bindings.get(record.id)?.planId === undefined
      ? undefined
      : this.plans.get(this.bindings.get(record.id)!.planId)
    const capability = record.manifest.resolutionCapability
    const names = parseScaffoldNames({
      owner: record.owner,
      capability,
      toolName: input.toolName,
      toolDescription: input.toolDescription,
      capabilityOverride: input.capability,
    })
    if (plan && input.capability !== undefined && input.capability !== plan.review.capability) {
      throw new WorkbenchContractError('scaffold capability must match the host plan')
    }
    const files = scaffoldFiles(names)
    for (const [relative, content] of Object.entries(files)) {
      const existing = tryRead(this.workspace, record.id, relative)
      if (existing !== undefined && existing.trim() !== '' && existing !== content) {
        throw new WorkbenchContractError(`refusing to overwrite non-empty candidate file: ${relative}`)
      }
    }
    for (const [relative, content] of Object.entries(files)) {
      if (relative === AUTHORING_CONTRACT_STAMP) {
        this.workspace.writeFile(record.id, relative, content)
        continue
      }
      this.writeFile(record.id, relative, content)
    }
    this.workspace.setManifest(record.id, mergeManifestPatch(this.workspace.get(record.id).manifest, {
      capabilities: record.manifest.capabilities.length > 0 ? [...record.manifest.capabilities] : [capability],
      tools: record.manifest.tools.length > 0 ? [...record.manifest.tools] : [names.toolName],
      entryPoints: record.manifest.entryPoints.length > 0 ? [...record.manifest.entryPoints] : ['src/plugin.js'],
    }, authoringContractV1().id))
    const binding = this.bindings.get(record.id)
    if (binding) {
      this.bindings.set(record.id, { ...binding, runtimeContractVersion: authoringContractV1().id })
    }
    this.flush()
    return this.inspect(record.id)
  }

  inspectValidation(candidateId: string) {
    return projectValidationDiagnostics(this.workspace.get(candidateId))
  }

  list(input: WorkbenchListInput = {}): WorkbenchListView {
    const limit = boundListLimit(input.limit)
    const cursor = parseListCursor(input.cursor)
    const specifications = [...this.specifications.values()].map((specification) => ({
      id: specification.id,
      revision: specification.revision,
      supersedesId: specification.supersedesId,
      capability: specification.capability,
      goal: specification.goal,
      status: specification.status,
      digest: specification.digest,
    }))
    const plans = [...this.plans.values()].map((plan) => ({
      planId: plan.id,
      specificationId: plan.specificationId,
      specificationDigest: plan.specificationDigest,
      kind: plan.review.kind,
      capability: plan.review.capability,
      need: plan.review.need,
      canCreate: WORKBENCH_CHANGE_KINDS.includes(plan.review.kind as (typeof WORKBENCH_CHANGE_KINDS)[number]),
    }))
    const candidates = this.workspace.list().map((record) => {
      const view = this.inspect(record.id)
      return {
        id: record.id,
        owner: record.owner,
        version: record.version,
        states: candidateStates({
          lifecycle: record.lifecycle,
          sealed: record.sealed,
          reviewState: view.review?.state,
          approval: this.governance.inspectApproval(record.id)?.decision,
          registryStatus: this.options.registry?.get(record.owner, record.version)?.status,
        }),
        step: view.step,
        planId: view.planId,
        specificationId: view.specification?.id,
        parentId: view.parentId,
        leftover: view.leftover,
      }
    })
    const specificationSlice = specifications.slice(cursor.specifications, cursor.specifications + limit)
    const planSlice = plans.slice(cursor.plans, cursor.plans + limit)
    const candidateSlice = candidates.slice(cursor.candidates, cursor.candidates + limit)
    const nextSpecifications = cursor.specifications + limit
    const nextPlans = cursor.plans + limit
    const nextCandidates = cursor.candidates + limit
    const next = nextSpecifications < specifications.length || nextPlans < plans.length || nextCandidates < candidates.length
      ? encodeListCursor({
        specifications: Math.min(nextSpecifications, specifications.length),
        plans: Math.min(nextPlans, plans.length),
        candidates: Math.min(nextCandidates, candidates.length),
      })
      : undefined
    return {
      specifications: specificationSlice,
      plans: planSlice,
      candidates: candidateSlice,
      ...(next === undefined ? {} : { nextCursor: next }),
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
    if (relativePath === AUTHORING_CONTRACT_STAMP || relativePath === CAPABILITY_SPECIFICATION_STAMP || relativePath === 'candidate.manifest.json' || relativePath.startsWith('.dsh/')) {
      throw new WorkbenchContractError(`candidate write cannot change host-owned path: ${relativePath}`)
    }
    if (Buffer.byteLength(content, 'utf8') > WORKBENCH_MAX_FILE_BYTES) {
      throw new WorkbenchContractError(`candidate write exceeds the ${WORKBENCH_MAX_FILE_BYTES} byte bound`)
    }
    const record = this.workspace.get(candidateId)
    assertImportedReadOnly(record)
    assertWorkspaceBudget(record, relativePath, content)
    try {
      this.workspace.writeFile(record.id, relativePath, content)
    } catch (error) {
      if (error instanceof SealedCandidateError) throw new WorkbenchContractError(error.message)
      throw error
    }
    this.flush()
    return this.inspect(record.id)
  }

  setManifest(candidateId: string, manifest: CandidateManifestInput): WorkbenchCandidateView {
    if (manifest.validationTasks?.some((task) => task.argv !== undefined || task.script !== undefined)) {
      throw new WorkbenchContractError('candidate manifest cannot include argv, scripts, or a shell runner')
    }
    if (manifest.riskModel !== undefined) parseWorkbenchRiskModel(manifest.riskModel)
    const record = this.workspace.get(candidateId)
    assertImportedReadOnly(record)
    const current = record.manifest
    const merged = mergeManifestPatch(current, manifest)
    const binding = this.bindings.get(candidateId)
    const specification = binding?.specificationId === undefined ? undefined : this.specifications.get(binding.specificationId)
    if (specification?.source === 'explicit') {
      assertExactPermissions(specification.permissions, merged.permissions ?? [])
      assertExactEffects(specification.effects, normalizeOperationalEffects(merged.effects ?? {}))
    }
    if (record.provenance.kind === 'generated') {
      const permissions = (merged.permissions ?? []).map(parsePermission)
      assertGeneratedBrokerPermissions(permissions)
    }
    this.workspace.setManifest(candidateId, merged)
    this.flush()
    return this.inspect(candidateId)
  }

  validate(candidateId: string): WorkbenchCandidateView {
    this.assertSpecificationStamp(candidateId)
    this.validation.validate(candidateId)
    this.flush()
    return this.inspect(candidateId)
  }

  seal(candidateId: string): WorkbenchCandidateView {
    this.workspace.seal(candidateId)
    this.flush()
    return this.inspect(candidateId)
  }

  review(candidateId: string): ReviewReport {
    const record = this.workspace.get(candidateId)
    const binding = this.bindings.get(candidateId)
    const parentDigest = binding?.parentDigest
    const parentReport = binding?.parentId === undefined ? undefined : this.independentReview.lastReport(binding.parentId)
    return this.independentReview.reviewCandidate(record.id, {
      ...(parentDigest === undefined ? {} : { parentRevision: parentDigest }),
      ...(parentReport === undefined
        ? {}
        : { priorFindings: parentReport.findings.filter((item) => item.blocking && item.status === 'open') }),
    })
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
    assertImportedReadOnly(parent)
    if (!parent.sealed) throw new WorkbenchContractError('repair requires a sealed parent revision')
    const last = this.independentReview.lastReport(parent.id)
    const approval = this.governance.inspectApproval(parent.id)
    if (last?.state !== 'changes-required' && approval?.decision !== 'rejected') {
      throw new WorkbenchContractError('repair requires Independent Review changes-required or a rejected approval on the parent')
    }
    const snapshot = snapshotRepairParent(parent)
    const binding = this.bindings.get(parent.id)
    const plan = binding?.planId === undefined ? undefined : this.plans.get(binding.planId)
    const review = plan?.review ?? reviewFromRecord(parent)
    const inheritedPlanId = binding?.planId === undefined ? `inherited-${parent.id}` : undefined
    const nextVersion = bumpPatch(parent.version)
    let createdId: string | undefined
    try {
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
          runtimeContractVersion: parent.manifest.runtimeContractVersion ?? '',
          pluginDependencies: [...(parent.manifest.pluginDependencies ?? [])],
        },
      })
      createdId = created.id
      let specificationId = binding?.specificationId
      let specificationDigest = binding?.specificationDigest
      if (inheritedPlanId !== undefined) {
        const specification = this.rememberLegacySpecification(review.capability, review.need)
        specificationId = specification.id
        specificationDigest = specification.digest
        this.plans.set(inheritedPlanId, {
          id: inheritedPlanId,
          review,
          specificationId,
          specificationDigest,
        })
      }
      this.bindings.set(created.id, {
        planId: binding?.planId ?? inheritedPlanId ?? `inherited-${parent.id}`,
        leftover: false,
        runtimeContractVersion: parent.manifest.runtimeContractVersion,
        parentId: parent.id,
        parentDigest: parent.digest,
        specificationId,
        specificationDigest,
      })
      this.copyParentWorkspace(created.id, snapshot)
      this.flush()
      return this.inspect(created.id)
    } catch (error) {
      if (createdId !== undefined) this.rollbackRepair(createdId, inheritedPlanId, error)
      throw error
    }
  }

  exportState(): WorkbenchPersistState {
    return {
      nextPlan: this.nextPlan,
      nextSpecification: this.nextSpecification,
      specifications: [...this.specifications.values()],
      plans: [...this.plans.values()],
      bindings: [...this.bindings.entries()].map(([candidateId, binding]) => ({
        candidateId,
        planId: binding.planId,
        ...(binding.parentId === undefined ? {} : { parentId: binding.parentId }),
        ...(binding.parentDigest === undefined ? {} : { parentDigest: binding.parentDigest }),
        ...(binding.leftover === true ? { leftover: true } : {}),
        ...(binding.runtimeContractVersion === undefined ? {} : { runtimeContractVersion: binding.runtimeContractVersion }),
        ...(binding.specificationId === undefined ? {} : { specificationId: binding.specificationId }),
        ...(binding.specificationDigest === undefined ? {} : { specificationDigest: binding.specificationDigest }),
      })),
    }
  }

  private copyParentWorkspace(childId: string, snapshot: RepairSnapshot): void {
    for (const file of snapshot.files) {
      if (file.relative === 'candidate.manifest.json') continue
      this.workspace.writeFile(childId, file.relative, file.bytes.toString('utf8'))
    }
  }

  private rollbackRepair(childId: string, inheritedPlanId: string | undefined, copyError: unknown): never {
    let rollbackError: unknown
    try {
      this.workspace.discard(childId)
    } catch (error) {
      rollbackError = error
    }
    if (rollbackError !== undefined) {
      const leftover = this.bindings.get(childId)
      if (leftover) this.bindings.set(childId, { ...leftover, leftover: true })
      try {
        this.flush()
      } catch (error) {
        rollbackError = error
      }
      throw new WorkbenchRepairRollbackError(
        `repair rollback failed for leftover candidate ${childId}: ${describeError(rollbackError)}; original: ${describeError(copyError)}`,
        copyError,
        rollbackError,
        childId,
      )
    }
    this.bindings.delete(childId)
    if (inheritedPlanId !== undefined) this.plans.delete(inheritedPlanId)
    try {
      this.flush()
    } catch (error) {
      throw new WorkbenchRepairRollbackError(
        `repair rollback persist failed after discarding ${childId}: ${describeError(error)}; original: ${describeError(copyError)}`,
        copyError,
        error,
        childId,
      )
    }
    throw copyError instanceof Error ? copyError : new WorkbenchContractError(String(copyError))
  }

  private flush(): void {
    this.options.persist?.(this.exportState())
  }

  private rememberLegacySpecification(capability: string, goal: string, behavior?: string): CapabilitySpecification {
    const specification = defineCapabilitySpecification(`spec-${this.nextSpecification++}`, {
      capability,
      goal,
      businessRules: behavior === undefined ? [] : [behavior],
    }, 'legacy')
    this.specifications.set(specification.id, specification)
    return specification
  }

  private assertSpecificationStamp(candidateId: string): void {
    const binding = this.bindings.get(candidateId)
    if (binding?.specificationId === undefined) return
    const specification = this.inspectSpecification(binding.specificationId)
    if (binding.specificationDigest !== specification.digest) {
      throw new WorkbenchContractError(`candidate ${candidateId} capability specification binding is stale`)
    }
    const actual = tryRead(this.workspace, candidateId, CAPABILITY_SPECIFICATION_STAMP)
    if (actual !== capabilitySpecificationStamp(specification)) {
      throw new WorkbenchContractError(`candidate ${candidateId} capability specification stamp does not match host authority`)
    }
    const prepared = this.evaluation.prepare(specification)
    for (const relativePath of [CAPABILITY_EVALUATION_SUITE_STAMP, CAPABILITY_EVALUATION_RUNNER]) {
      const expected = prepared[relativePath]
      const evaluationAsset = tryRead(this.workspace, candidateId, relativePath)
      if (evaluationAsset !== expected) {
        throw new WorkbenchContractError(`candidate ${candidateId} Capability Evaluation assets do not match host authority`)
      }
    }
  }

  requestApproval(candidateId: string) {
    return this.governance.requestApproval(candidateId)
  }

  private stepOf(candidateId: string) {
    const record = this.workspace.get(candidateId)
    return candidateStep({
      lifecycle: record.lifecycle,
      sealed: record.sealed,
      reviewState: this.independentReview.status({ id: record.id, digest: record.digest }),
      canRequest: this.governance.requestEligibility(record.id).ok,
      approval: this.governance.inspectApproval(record.id)?.decision,
      registryStatus: this.options.registry?.get(record.owner, record.version)?.status,
    })
  }

  private lifecycleOf(record: CandidateRecord): Pick<WorkbenchCandidateView, 'governanceApproval' | 'activationState' | 'activationFailureSummary'> {
    const decision = this.governance.inspectApproval(record.id)?.decision
    const inspected = this.options.activation?.inspect()
    const lifecycle = extensionLifecycleOf({
      registryStatus: this.options.registry?.get(record.owner, record.version)?.status,
      decision,
      activationState: inspected?.state,
      pendingCandidateId: inspected?.pendingCandidateId,
      candidateId: record.id,
      lastFailureCandidateId: inspected?.lastFailure?.candidateId,
      eligibilityDenials: this.governance.eligibility(record.id).denials.map((item) => item.reason),
      newerAuthoritative: this.options.registry?.list({ owner: record.owner }).some((item) => (
        item.status === 'active' && compareOwnerVersion(item.version, record.version) > 0
      )),
    })
    return {
      governanceApproval: decision ?? 'none',
      activationState: activationViewOf(lifecycle),
      ...(lifecycle === 'ACTIVATION_FAILED' && inspected?.lastFailure
        ? { activationFailureSummary: boundActivationDiagnostics(inspected.lastFailure.diagnostics ?? '') }
        : {}),
    }
  }
}

function assertImportedReadOnly(record: CandidateRecord): void {
  if (isImportedThirdParty({
    owner: record.owner,
    provenanceKind: record.provenance.kind,
    origin: record.provenance.origin,
  })) {
    throw new WorkbenchContractError('imported third-party candidate is read-only; import a new version')
  }
}

function viewPlan(id: string, review: ResolutionReview, specification: CapabilitySpecification): WorkbenchPlanView {
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
    specification,
  }
}

function assertExactPermissions(expected: readonly string[], actual: readonly string[]): void {
  const normalized = [...new Set(actual.map(parsePermission))].sort()
  if (expected.length !== normalized.length || expected.some((permission, index) => permission !== normalized[index])) {
    throw new WorkbenchContractError(`candidate permissions must exactly match capability specification: ${expected.join(', ') || '(none)'}`)
  }
}

function assertExactEffects(expected: CandidateManifest['effects'], actual: CandidateManifest['effects']): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new WorkbenchContractError('candidate operational effects must exactly match capability specification')
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

function mergeManifestPatch(
  current: CandidateManifest,
  patch: CandidateManifestInput,
  hostContract?: string,
): CandidateManifestInput {
  return {
    capabilities: patch.capabilities ?? current.capabilities,
    permissions: patch.permissions ?? current.permissions,
    runtimeSeams: patch.runtimeSeams ?? current.runtimeSeams,
    tools: patch.tools ?? current.tools,
    services: patch.services ?? current.services,
    providers: patch.providers ?? current.providers,
    secrets: patch.secrets ?? current.secrets,
    configRequired: patch.configRequired ?? current.configRequired,
    effects: {
      filesystem: patch.effects?.filesystem ?? current.effects.filesystem,
      network: patch.effects?.network ?? current.effects.network,
      process: patch.effects?.process ?? current.effects.process,
      secrets: patch.effects?.secrets ?? current.effects.secrets,
      externalSystems: patch.effects?.externalSystems ?? current.effects.externalSystems,
      remoteSideEffect: patch.effects?.remoteSideEffect ?? current.effects.remoteSideEffect,
    },
    entryPoints: patch.entryPoints ?? current.entryPoints,
    validationTasks: patch.validationTasks ?? current.validationTasks,
    riskModel: patch.riskModel ?? current.riskModel,
    runtimeContractVersion: hostContract ?? current.runtimeContractVersion ?? '',
    pluginDependencies: patch.pluginDependencies ?? current.pluginDependencies,
  }
}

function failClosedDiscovery(review: ResolutionReview, hostInventoryComplete: boolean): ResolutionReview {
  if (hostInventoryComplete) return review
  const status = review.discoveryFacts?.status
  if (review.kind !== 'new-plugin' || (status !== 'unavailable' && status !== 'incomplete')) return review
  return {
    ...review,
    kind: 'insufficient-information',
    recommendation: 'Gather discovery or a host-owned complete inventory before treating the capability as new.',
    rationale: 'Discovery is unavailable or incomplete; unknown is not proof the capability is new.',
    unresolved: [
      ...review.unresolved,
      'Discovery is unavailable or incomplete; Workbench will not treat absence as a new plugin.',
    ],
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface RepairSnapshot {
  readonly digest: string
  readonly files: readonly { readonly relative: string; readonly bytes: Buffer }[]
}

function snapshotRepairParent(parent: CandidateRecord): RepairSnapshot {
  if (parent.digest === undefined) {
    throw new WorkbenchContractError('repair requires a sealed parent with a host digest')
  }
  const names = listBoundedFiles(parent.workspaceRoot, true)
  const files: { relative: string; bytes: Buffer }[] = []
  const hash = createHash('sha256')
  let total = 0
  for (const relative of names) {
    const dest = resolveInsideRoot(parent.workspaceRoot, relative)
    const stat = lstatSync(dest)
    if (stat.isSymbolicLink()) {
      throw new WorkbenchContractError(`symlink is not allowed in a candidate workspace: ${relative}`)
    }
    if (stat.size > WORKBENCH_MAX_FILE_BYTES) {
      throw new WorkbenchContractError(`candidate file exceeds the ${WORKBENCH_MAX_FILE_BYTES} byte bound`)
    }
    total += stat.size
    if (total > WORKBENCH_MAX_WORKSPACE_BYTES) {
      throw new WorkbenchContractError(`candidate workspace exceeds the ${WORKBENCH_MAX_WORKSPACE_BYTES} byte bound`)
    }
    const bytes = readBoundedBytes(dest, relative, stat.size)
    hash.update(relative)
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
    files.push({ relative, bytes })
  }
  for (const extra of contractDigestExtras(parent.manifest.runtimeContractVersion)) {
    hash.update(extra.name)
    hash.update('\0')
    hash.update(extra.payload)
    hash.update('\0')
  }
  const digest = hash.digest('hex')
  if (digest !== parent.digest) {
    throw new WorkbenchContractError('parent candidate digest no longer matches the sealed revision')
  }
  return { digest, files }
}

function readBoundedBytes(dest: string, relative: string, expectedSize: number): Buffer {
  if (lstatSync(dest).isSymbolicLink()) {
    throw new WorkbenchContractError(`symlink is not allowed in a candidate workspace: ${relative}`)
  }
  const fd = openSync(dest, 'r')
  try {
    const out = Buffer.alloc(Math.min(expectedSize, WORKBENCH_MAX_FILE_BYTES))
    const chunk = Buffer.alloc(64 * 1024)
    let offset = 0
    while (offset < out.length) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, out.length - offset), offset)
      if (n === 0) break
      chunk.copy(out, offset, 0, n)
      offset += n
      if (offset > WORKBENCH_MAX_FILE_BYTES) {
        throw new WorkbenchContractError(`candidate file exceeds the ${WORKBENCH_MAX_FILE_BYTES} byte bound`)
      }
    }
    return out.subarray(0, offset)
  } finally {
    closeSync(fd)
  }
}

function assertRelativePath(relativePath: string): void {
  if (relativePath.includes('\0')) throw new WorkbenchContractError('path is invalid')
}

function assertWorkspaceBudget(record: CandidateRecord, relativePath: string, content: string): void {
  const files = listBoundedFiles(record.workspaceRoot)
  const budgetedFiles = files.filter((file) => file !== CAPABILITY_SPECIFICATION_STAMP)
  if (!budgetedFiles.includes(relativePath) && budgetedFiles.length >= WORKBENCH_MAX_FILE_COUNT) {
    throw new WorkbenchContractError(`candidate workspace exceeds the ${WORKBENCH_MAX_FILE_COUNT} file bound`)
  }
  let total = Buffer.byteLength(content, 'utf8')
  for (const file of budgetedFiles) {
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

function listBoundedFiles(root: string, includeHostAssets = false): string[] {
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
        if (!includeHostAssets && entry.name === '.dsh') continue
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

function tryRead(
  workspace: CandidateWorkspace,
  candidateId: string,
  relativePath: string,
): string | undefined {
  try {
    return workspace.readFile(candidateId, relativePath)
  } catch {
    return undefined
  }
}

export function readBoundedFile(root: string, relativePath: string): string {
  const dest = resolveInsideRoot(root, relativePath)
  if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
    throw new WorkbenchContractError(`symlink is not allowed in a candidate workspace: ${relativePath}`)
  }
  const text = readFileSync(dest, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > WORKBENCH_MAX_FILE_BYTES) {
    throw new WorkbenchContractError(`candidate file exceeds the ${WORKBENCH_MAX_FILE_BYTES} byte bound`)
  }
  return text
}
