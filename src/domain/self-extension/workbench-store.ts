import { existsSync, readFileSync } from 'node:fs'
import { writeJsonAtomic } from '../persistence/atomic.js'
import { RESOLUTION_KINDS, type ResolutionReview } from '../resolution/types.js'
import type { WorkbenchPersistState, WorkbenchPlan } from '../workbench/types.js'
import {
  assertCapabilitySpecification,
  defineCapabilitySpecification,
  type CapabilitySpecification,
} from '../workbench/capability-specification.js'
import { PersistenceIntegrityError, PersistenceSchemaError } from './errors.js'
import { SELF_EXTENSION_SCHEMA_VERSION, type SelfExtensionHome } from './home.js'

export interface WorkbenchFile {
  readonly schemaVersion: number
  readonly nextProposal?: number
  readonly nextPlan: number
  readonly nextSpecification?: number
  readonly specifications?: readonly CapabilitySpecification[]
  readonly plans: readonly WorkbenchPlan[]
  readonly bindings: WorkbenchPersistState['bindings']
  readonly deliveryStops?: WorkbenchPersistState['deliveryStops']
  readonly proposals?: WorkbenchPersistState['proposals']
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReview(value: unknown, planId: string): ResolutionReview {
  if (!isObject(value)) throw new PersistenceIntegrityError(`workbench plan ${planId} review must be an object`)
  if (typeof value.kind !== 'string' || !RESOLUTION_KINDS.includes(value.kind as (typeof RESOLUTION_KINDS)[number])) {
    throw new PersistenceIntegrityError(`workbench plan ${planId} has an invalid resolution kind`)
  }
  for (const key of ['capability', 'need', 'recommendation', 'rationale'] as const) {
    if (typeof value[key] !== 'string') {
      throw new PersistenceIntegrityError(`workbench plan ${planId} is missing ${key}`)
    }
  }
  if (!Array.isArray(value.implications) || !Array.isArray(value.assumptions) || !Array.isArray(value.unresolved) || !Array.isArray(value.steps)) {
    throw new PersistenceIntegrityError(`workbench plan ${planId} review arrays are corrupt`)
  }
  if (!isObject(value.registryFacts) || !isObject(value.registryFacts.exact)) {
    throw new PersistenceIntegrityError(`workbench plan ${planId} is missing host registryFacts`)
  }
  return value as unknown as ResolutionReview
}

function parsePlan(value: unknown, index: number, specifications: CapabilitySpecification[]): WorkbenchPlan {
  if (!isObject(value)) throw new PersistenceIntegrityError(`workbench plan ${index} must be an object`)
  if (typeof value.id !== 'string' || value.id === '') {
    throw new PersistenceIntegrityError(`workbench plan ${index} is missing id`)
  }
  const review = parseReview(value.review, value.id)
  if (typeof value.specificationId === 'string' && typeof value.specificationDigest === 'string') {
    return { id: value.id, review, specificationId: value.specificationId, specificationDigest: value.specificationDigest }
  }
  const specification = defineCapabilitySpecification(`spec-legacy-${value.id}`, {
    capability: review.capability,
    goal: review.need,
  }, 'legacy')
  specifications.push(specification)
  return { id: value.id, review, specificationId: specification.id, specificationDigest: specification.digest }
}

function parseBinding(value: unknown, index: number): WorkbenchPersistState['bindings'][number] {
  if (!isObject(value)) throw new PersistenceIntegrityError(`workbench binding ${index} must be an object`)
  if (typeof value.candidateId !== 'string' || typeof value.planId !== 'string') {
    throw new PersistenceIntegrityError(`workbench binding ${index} is missing candidateId or planId`)
  }
  if (value.parentId !== undefined && typeof value.parentId !== 'string') {
    throw new PersistenceIntegrityError(`workbench binding ${index} parentId is invalid`)
  }
  if (value.parentDigest !== undefined && typeof value.parentDigest !== 'string') {
    throw new PersistenceIntegrityError(`workbench binding ${index} parentDigest is invalid`)
  }
  if (value.leftover !== undefined && typeof value.leftover !== 'boolean') {
    throw new PersistenceIntegrityError(`workbench binding ${index} leftover is invalid`)
  }
  if (value.runtimeContractVersion !== undefined && typeof value.runtimeContractVersion !== 'string') {
    throw new PersistenceIntegrityError(`workbench binding ${index} runtimeContractVersion is invalid`)
  }
  if (value.specificationId !== undefined && typeof value.specificationId !== 'string') {
    throw new PersistenceIntegrityError(`workbench binding ${index} specificationId is invalid`)
  }
  if (value.specificationDigest !== undefined && typeof value.specificationDigest !== 'string') {
    throw new PersistenceIntegrityError(`workbench binding ${index} specificationDigest is invalid`)
  }
  return {
    candidateId: value.candidateId,
    planId: value.planId,
    ...(typeof value.parentId === 'string' ? { parentId: value.parentId } : {}),
    ...(typeof value.parentDigest === 'string' ? { parentDigest: value.parentDigest } : {}),
    ...(value.leftover === true ? { leftover: true } : {}),
    ...(typeof value.runtimeContractVersion === 'string' ? { runtimeContractVersion: value.runtimeContractVersion } : {}),
    ...(typeof value.specificationId === 'string' ? { specificationId: value.specificationId } : {}),
    ...(typeof value.specificationDigest === 'string' ? { specificationDigest: value.specificationDigest } : {}),
  }
}

export function parseWorkbenchFile(parsed: unknown): WorkbenchFile {
  if (!isObject(parsed)) throw new PersistenceIntegrityError('workbench file must be an object')
  if (parsed.schemaVersion !== SELF_EXTENSION_SCHEMA_VERSION) {
    throw new PersistenceSchemaError(`unsupported workbench schema ${String(parsed.schemaVersion)}`)
  }
  if (typeof parsed.nextPlan !== 'number' || !Number.isInteger(parsed.nextPlan) || parsed.nextPlan < 1) {
    throw new PersistenceIntegrityError('workbench nextPlan must be a positive integer')
  }
  if (!Array.isArray(parsed.plans) || !Array.isArray(parsed.bindings)) {
    throw new PersistenceIntegrityError('workbench plans and bindings must be arrays')
  }
  const specifications = Array.isArray(parsed.specifications)
    ? parsed.specifications.map(assertCapabilitySpecification)
    : []
  if (new Set(specifications.map((item) => item.id)).size !== specifications.length) {
    throw new PersistenceIntegrityError('workbench capability specification ids must be unique')
  }
  const plans = parsed.plans.map((item, index) => parsePlan(item, index, specifications))
  const specificationById = new Map(specifications.map((item) => [item.id, item]))
  const superseded = new Set<string>()
  for (const specification of specifications) {
    if (specification.revision === 1) continue
    const previous = specification.supersedesId === undefined ? undefined : specificationById.get(specification.supersedesId)
    if (!previous
      || previous.source !== 'explicit'
      || previous.capability !== specification.capability
      || previous.revision + 1 !== specification.revision
      || specification.source !== 'explicit'
      || superseded.has(previous.id)) {
      throw new PersistenceIntegrityError(`workbench capability specification ${specification.id} has invalid revision lineage`)
    }
    superseded.add(previous.id)
  }
  for (const plan of plans) {
    const specification = specificationById.get(plan.specificationId)
    if (!specification || specification.digest !== plan.specificationDigest) {
      throw new PersistenceIntegrityError(`workbench plan ${plan.id} references an unknown or stale capability specification`)
    }
  }
  const planIds = new Set(plans.map((item) => item.id))
  if (planIds.size !== plans.length) throw new PersistenceIntegrityError('workbench plan ids must be unique')
  const planById = new Map(plans.map((item) => [item.id, item]))
  const bindings = parsed.bindings.map((item, index) => parseBinding(item, index))
  for (const binding of bindings) {
    const plan = planById.get(binding.planId)
    if (!plan) {
      throw new PersistenceIntegrityError(`workbench binding ${binding.candidateId} references unknown plan ${binding.planId}`)
    }
    if ((binding.specificationId !== undefined && binding.specificationId !== plan.specificationId)
      || (binding.specificationDigest !== undefined && binding.specificationDigest !== plan.specificationDigest)) {
      throw new PersistenceIntegrityError(`workbench binding ${binding.candidateId} references a stale capability specification`)
    }
  }
  const deliveryStops = Array.isArray(parsed.deliveryStops)
    ? parsed.deliveryStops.map((item, index) => parseDeliveryStop(item, index, specificationById))
    : []
  if (new Set(deliveryStops.map((item) => item.specificationId)).size !== deliveryStops.length) {
    throw new PersistenceIntegrityError('workbench delivery stop specification ids must be unique')
  }
  const proposals = Array.isArray(parsed.proposals) ? parsed.proposals.map(parseProposal) : []
  if (new Set(proposals.map((item) => item.id)).size !== proposals.length) {
    throw new PersistenceIntegrityError('workbench capability proposal ids must be unique')
  }
  const nextProposal = Math.max(0, ...proposals.map((item) => /^proposal-(\d+)$/.exec(item.id)?.[1]).filter((item): item is string => item !== undefined).map(Number)) + 1
  if (parsed.nextProposal !== undefined && (typeof parsed.nextProposal !== 'number' || !Number.isInteger(parsed.nextProposal) || parsed.nextProposal < nextProposal)) {
    throw new PersistenceIntegrityError('workbench nextProposal must be greater than existing proposal ids')
  }
  const nextSpecification = nextSpecificationAfter(specifications)
  if (parsed.nextSpecification !== undefined
    && (typeof parsed.nextSpecification !== 'number' || !Number.isInteger(parsed.nextSpecification) || parsed.nextSpecification < nextSpecification)) {
    throw new PersistenceIntegrityError('workbench nextSpecification must be greater than existing numeric specification ids')
  }
  return {
    schemaVersion: SELF_EXTENSION_SCHEMA_VERSION,
    nextPlan: parsed.nextPlan,
    nextSpecification: (parsed.nextSpecification as number | undefined) ?? nextSpecification,
    specifications,
    plans,
    bindings,
    deliveryStops,
    nextProposal: (parsed.nextProposal as number | undefined) ?? nextProposal,
    proposals,
  }
}

/** Host-owned Workbench plans and lineage bindings. Corrupt files fail closed. */
export class DurableWorkbenchStore {
  private state: WorkbenchPersistState = { nextProposal: 1, nextPlan: 1, nextSpecification: 1, specifications: [], plans: [], bindings: [], deliveryStops: [], proposals: [] }

  constructor(private readonly home: SelfExtensionHome) {
    if (!existsSync(home.workbenchPath)) return
    try {
      this.state = snapshotOf(parseWorkbenchFile(JSON.parse(readFileSync(home.workbenchPath, 'utf8'))))
    } catch (error) {
      if (error instanceof PersistenceIntegrityError || error instanceof PersistenceSchemaError) throw error
      throw new PersistenceIntegrityError(`workbench state is corrupt: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  restore(): WorkbenchPersistState {
    return this.state
  }

  save(state: WorkbenchPersistState): void {
    const file: WorkbenchFile = {
      schemaVersion: SELF_EXTENSION_SCHEMA_VERSION,
      nextProposal: state.nextProposal,
      nextPlan: state.nextPlan,
      nextSpecification: state.nextSpecification,
      specifications: state.specifications,
      plans: state.plans,
      bindings: state.bindings,
      deliveryStops: state.deliveryStops ?? [],
      proposals: state.proposals ?? [],
    }
    parseWorkbenchFile(file)
    this.state = snapshotOf(file)
    writeJsonAtomic(this.home.workbenchPath, file)
  }
}

function snapshotOf(file: WorkbenchFile): WorkbenchPersistState {
  return {
    nextProposal: file.nextProposal ?? 1,
    nextPlan: file.nextPlan,
    nextSpecification: file.nextSpecification ?? nextSpecificationAfter(file.specifications ?? []),
    specifications: file.specifications ?? [],
    plans: file.plans,
    bindings: file.bindings,
    deliveryStops: file.deliveryStops ?? [],
    proposals: file.proposals ?? [],
  }
}

function parseProposal(value: unknown, index: number): NonNullable<WorkbenchPersistState['proposals']>[number] {
  if (!isObject(value)
    || typeof value.id !== 'string'
    || typeof value.originSessionId !== 'string'
    || !['pending', 'declined', 'started'].includes(String(value.status))
    || typeof value.createdAt !== 'string'
    || Number.isNaN(Date.parse(value.createdAt))
    || (value.deliverySessionId !== undefined && typeof value.deliverySessionId !== 'string')) {
    throw new PersistenceIntegrityError(`workbench capability proposal ${index} is invalid`)
  }
  return {
    id: value.id,
    review: parseReview(value.review, value.id),
    originSessionId: value.originSessionId,
    status: value.status as 'pending' | 'declined' | 'started',
    createdAt: value.createdAt,
    ...(typeof value.deliverySessionId === 'string' ? { deliverySessionId: value.deliverySessionId } : {}),
  }
}

function parseDeliveryStop(
  value: unknown,
  index: number,
  specifications: ReadonlyMap<string, CapabilitySpecification>,
): NonNullable<WorkbenchPersistState['deliveryStops']>[number] {
  if (!isObject(value)
    || typeof value.specificationId !== 'string'
    || value.status !== 'stopped'
    || typeof value.stoppedFromSessionId !== 'string'
    || typeof value.stoppedAt !== 'string'
    || !specifications.has(value.specificationId)
    || Number.isNaN(Date.parse(value.stoppedAt))) {
    throw new PersistenceIntegrityError(`workbench delivery stop ${index} is invalid`)
  }
  return {
    specificationId: value.specificationId,
    status: 'stopped',
    stoppedFromSessionId: value.stoppedFromSessionId,
    stoppedAt: value.stoppedAt,
  }
}

function nextSpecificationAfter(specifications: readonly CapabilitySpecification[]): number {
  return Math.max(0, ...specifications.map((item) => /^spec-(\d+)$/.exec(item.id)?.[1]).filter((item): item is string => item !== undefined).map(Number)) + 1
}
