import { existsSync, readFileSync } from 'node:fs'
import { writeJsonAtomic } from '../persistence/atomic.js'
import { RESOLUTION_KINDS, type ResolutionReview } from '../resolution/types.js'
import type { WorkbenchPersistState, WorkbenchPlan } from '../workbench/types.js'
import { PersistenceIntegrityError, PersistenceSchemaError } from './errors.js'
import { SELF_EXTENSION_SCHEMA_VERSION, type SelfExtensionHome } from './home.js'

export interface WorkbenchFile {
  readonly schemaVersion: number
  readonly nextPlan: number
  readonly plans: readonly WorkbenchPlan[]
  readonly bindings: WorkbenchPersistState['bindings']
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

function parsePlan(value: unknown, index: number): WorkbenchPlan {
  if (!isObject(value)) throw new PersistenceIntegrityError(`workbench plan ${index} must be an object`)
  if (typeof value.id !== 'string' || value.id === '') {
    throw new PersistenceIntegrityError(`workbench plan ${index} is missing id`)
  }
  return { id: value.id, review: parseReview(value.review, value.id) }
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
  return {
    candidateId: value.candidateId,
    planId: value.planId,
    ...(typeof value.parentId === 'string' ? { parentId: value.parentId } : {}),
    ...(typeof value.parentDigest === 'string' ? { parentDigest: value.parentDigest } : {}),
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
  const plans = parsed.plans.map((item, index) => parsePlan(item, index))
  const planIds = new Set(plans.map((item) => item.id))
  const bindings = parsed.bindings.map((item, index) => parseBinding(item, index))
  for (const binding of bindings) {
    if (!planIds.has(binding.planId)) {
      throw new PersistenceIntegrityError(`workbench binding ${binding.candidateId} references unknown plan ${binding.planId}`)
    }
  }
  return {
    schemaVersion: SELF_EXTENSION_SCHEMA_VERSION,
    nextPlan: parsed.nextPlan,
    plans,
    bindings,
  }
}

/** Host-owned Workbench plans and lineage bindings. Corrupt files fail closed. */
export class DurableWorkbenchStore {
  private state: WorkbenchPersistState = { nextPlan: 1, plans: [], bindings: [] }

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
      nextPlan: state.nextPlan,
      plans: state.plans,
      bindings: state.bindings,
    }
    parseWorkbenchFile(file)
    this.state = snapshotOf(file)
    writeJsonAtomic(this.home.workbenchPath, file)
  }
}

function snapshotOf(file: WorkbenchFile): WorkbenchPersistState {
  return { nextPlan: file.nextPlan, plans: file.plans, bindings: file.bindings }
}
