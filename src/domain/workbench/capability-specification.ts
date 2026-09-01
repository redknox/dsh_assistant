import { createHash } from 'node:crypto'
import { parseCapabilityId, parsePermission } from '../registry/normalize.js'
import { REMOTE_SIDE_EFFECTS, type OperationalEffects } from '../candidate/types.js'
import { normalizeEvaluationFixture, type EvaluationFixture } from '../evaluation/index.js'
import { WorkbenchContractError } from './errors.js'

export const CAPABILITY_SPECIFICATION_STAMP = 'capability-specification.json'
export const CAPABILITY_SPECIFICATION_VERSION = 'capability-specification/v1'
export const CAPABILITY_SPECIFICATION_MAX_BYTES = 64 * 1024
const MISSING_BUSINESS_RULE = 'At least one business rule is required.'
const MISSING_ACCEPTANCE_EXAMPLE = 'At least one acceptance example is required.'

export interface CapabilitySpecificationInput {
  readonly capability: string
  readonly goal: string
  readonly nonGoals?: readonly string[]
  readonly inputs?: readonly CapabilitySpecificationInputItem[]
  readonly businessRules?: readonly string[]
  readonly permissions?: readonly string[]
  readonly effects?: Partial<OperationalEffects>
  readonly acceptanceExamples?: readonly CapabilityAcceptanceExample[]
  readonly unresolved?: readonly string[]
  readonly origin?: CapabilitySpecificationOrigin
}

export interface CapabilitySpecificationOrigin {
  readonly sessionId: string
}

export interface CapabilitySpecificationPatch {
  readonly goal?: string
  readonly nonGoals?: readonly string[]
  readonly inputs?: readonly CapabilitySpecificationInputItem[]
  readonly businessRules?: readonly string[]
  readonly permissions?: readonly string[]
  readonly effects?: Partial<OperationalEffects>
  readonly acceptanceExamples?: readonly CapabilityAcceptanceExample[]
  readonly unresolved?: readonly string[]
}

export interface CapabilitySpecificationInputItem {
  readonly name: string
  readonly description: string
  readonly required: boolean
}

export interface CapabilityAcceptanceExample {
  readonly name: string
  readonly given: readonly string[]
  readonly when: string
  readonly then: readonly string[]
  readonly fixture?: EvaluationFixture
}

export interface CapabilitySpecification {
  readonly id: string
  readonly version: typeof CAPABILITY_SPECIFICATION_VERSION
  readonly revision: number
  readonly supersedesId?: string
  readonly source: 'explicit' | 'legacy'
  readonly origin?: CapabilitySpecificationOrigin
  readonly digest: string
  readonly status: 'ready' | 'needs-clarification'
  readonly capability: string
  readonly goal: string
  readonly nonGoals: readonly string[]
  readonly inputs: readonly CapabilitySpecificationInputItem[]
  readonly businessRules: readonly string[]
  readonly permissions: readonly string[]
  readonly effects: OperationalEffects
  readonly acceptanceExamples: readonly CapabilityAcceptanceExample[]
  readonly unresolved: readonly string[]
}

export interface CapabilitySpecificationDiff {
  readonly from: { readonly id: string; readonly revision: number; readonly digest: string }
  readonly to: { readonly id: string; readonly revision: number; readonly digest: string }
  readonly changedFields: readonly string[]
  readonly changes: Readonly<Record<string, { readonly before: unknown; readonly after: unknown }>>
}

export function defineCapabilitySpecification(
  id: string,
  input: CapabilitySpecificationInput,
  source: CapabilitySpecification['source'] = 'explicit',
  revision: { readonly number: number; readonly supersedesId?: string } = { number: 1 },
): CapabilitySpecification {
  if (!Number.isInteger(revision.number) || revision.number < 1) {
    throw new WorkbenchContractError('capability specification revision must be a positive integer')
  }
  if (revision.number === 1 && revision.supersedesId !== undefined) {
    throw new WorkbenchContractError('the first capability specification revision cannot supersede another revision')
  }
  if (revision.number > 1 && revision.supersedesId === undefined) {
    throw new WorkbenchContractError('a capability specification revision must identify the revision it supersedes')
  }
  const capability = parseCapabilityId(input.capability)
  const goal = boundedText(input.goal, 'goal')
  const nonGoals = uniqueTexts(input.nonGoals ?? [], 'nonGoals')
  if (!Array.isArray(input.inputs ?? []) || (input.inputs ?? []).length > 40) {
    throw new WorkbenchContractError('inputs must contain at most 40 items')
  }
  const inputs = (input.inputs ?? []).map((item, index) => ({
    name: boundedText(item.name, `inputs[${index}].name`, 120),
    description: boundedText(item.description, `inputs[${index}].description`),
    required: item.required === true,
  }))
  const businessRules = uniqueTexts(input.businessRules ?? [], 'businessRules')
  const permissions = [...new Set((input.permissions ?? []).map(parsePermission))].sort()
  const effects = normalizeOperationalEffects(input.effects ?? {})
  if (!Array.isArray(input.acceptanceExamples ?? []) || (input.acceptanceExamples ?? []).length > 40) {
    throw new WorkbenchContractError('acceptanceExamples must contain at most 40 items')
  }
  const acceptanceExamples = (input.acceptanceExamples ?? []).map((example, index) => {
    const then = uniqueTexts(example.then, `acceptanceExamples[${index}].then`)
    if (then.length === 0) throw new WorkbenchContractError(`acceptanceExamples[${index}].then must not be empty`)
    return {
      name: boundedText(example.name, `acceptanceExamples[${index}].name`, 160),
      given: uniqueTexts(example.given, `acceptanceExamples[${index}].given`),
      when: boundedText(example.when, `acceptanceExamples[${index}].when`),
      then,
      ...(example.fixture === undefined ? {} : { fixture: normalizeFixture(example.fixture, `acceptanceExamples[${index}]`) }),
    }
  })
  const unresolved = uniqueTexts(input.unresolved ?? [], 'unresolved')
  const origin = input.origin === undefined
    ? undefined
    : { sessionId: boundedText(input.origin.sessionId, 'origin.sessionId', 240) }
  if (source === 'explicit' && businessRules.length === 0) unresolved.push(MISSING_BUSINESS_RULE)
  if (source === 'explicit' && acceptanceExamples.length === 0) unresolved.push(MISSING_ACCEPTANCE_EXAMPLE)
  const body = {
    id,
    version: CAPABILITY_SPECIFICATION_VERSION as typeof CAPABILITY_SPECIFICATION_VERSION,
    revision: revision.number,
    ...(revision.supersedesId === undefined ? {} : { supersedesId: revision.supersedesId }),
    source,
    ...(origin === undefined ? {} : { origin }),
    status: unresolved.length === 0 ? 'ready' as const : 'needs-clarification' as const,
    capability,
    goal,
    nonGoals,
    inputs,
    businessRules,
    permissions,
    effects,
    acceptanceExamples,
    unresolved: [...new Set(unresolved)],
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > CAPABILITY_SPECIFICATION_MAX_BYTES) {
    throw new WorkbenchContractError(`capability specification exceeds ${CAPABILITY_SPECIFICATION_MAX_BYTES} bytes`)
  }
  return { ...body, digest: digestSpecification(body) }
}

function normalizeFixture(value: unknown, label: string): EvaluationFixture {
  try {
    return normalizeEvaluationFixture(value, label)
  } catch (error) {
    throw new WorkbenchContractError(error instanceof Error ? error.message : `${label} fixture is invalid`)
  }
}

export function reviseCapabilitySpecification(
  id: string,
  previous: CapabilitySpecification,
  patch: CapabilitySpecificationPatch,
): CapabilitySpecification {
  if (previous.source !== 'explicit') {
    throw new WorkbenchContractError('legacy capability specifications cannot be revised; define an explicit specification')
  }
  return defineCapabilitySpecification(id, {
    capability: previous.capability,
    goal: patch.goal ?? previous.goal,
    nonGoals: patch.nonGoals ?? previous.nonGoals,
    inputs: patch.inputs ?? previous.inputs,
    businessRules: patch.businessRules ?? previous.businessRules,
    permissions: patch.permissions ?? previous.permissions,
    effects: patch.effects ?? previous.effects,
    acceptanceExamples: patch.acceptanceExamples ?? previous.acceptanceExamples,
    unresolved: patch.unresolved ?? previous.unresolved.filter((item) => item !== MISSING_BUSINESS_RULE && item !== MISSING_ACCEPTANCE_EXAMPLE),
    origin: previous.origin,
  }, 'explicit', { number: previous.revision + 1, supersedesId: previous.id })
}

export function compareCapabilitySpecifications(
  from: CapabilitySpecification,
  to: CapabilitySpecification,
): CapabilitySpecificationDiff {
  if (from.capability !== to.capability) {
    throw new WorkbenchContractError('capability specification comparison requires the same capability identity')
  }
  const fields = ['status', 'goal', 'nonGoals', 'inputs', 'businessRules', 'permissions', 'effects', 'acceptanceExamples', 'unresolved'] as const
  const changes: Record<string, { before: unknown; after: unknown }> = {}
  for (const field of fields) {
    if (JSON.stringify(from[field]) === JSON.stringify(to[field])) continue
    changes[field] = { before: from[field], after: to[field] }
  }
  return {
    from: { id: from.id, revision: from.revision, digest: from.digest },
    to: { id: to.id, revision: to.revision, digest: to.digest },
    changedFields: Object.keys(changes),
    changes,
  }
}

export function capabilitySpecificationStamp(specification: CapabilitySpecification): string {
  return `${JSON.stringify(specification, null, 2)}\n`
}

export function assertCapabilitySpecification(value: unknown): CapabilitySpecification {
  if (!isObject(value)) throw new WorkbenchContractError('capability specification must be an object')
  if (typeof value.id !== 'string' || !/^spec-(?:\d+|legacy-[A-Za-z0-9._-]+)$/.test(value.id)) {
    throw new WorkbenchContractError('capability specification has an invalid id')
  }
  if (value.version !== CAPABILITY_SPECIFICATION_VERSION || typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 1) {
    throw new WorkbenchContractError('capability specification has an unsupported version or revision')
  }
  if (value.source !== 'explicit' && value.source !== 'legacy') {
    throw new WorkbenchContractError('capability specification has an invalid source')
  }
  if (value.supersedesId !== undefined && typeof value.supersedesId !== 'string') {
    throw new WorkbenchContractError('capability specification has an invalid supersedesId')
  }
  const rebuilt = defineCapabilitySpecification(
    value.id,
    value as unknown as CapabilitySpecificationInput,
    value.source,
    { number: value.revision, ...(typeof value.supersedesId === 'string' ? { supersedesId: value.supersedesId } : {}) },
  )
  if (value.digest !== rebuilt.digest || value.status !== rebuilt.status) {
    throw new WorkbenchContractError(`capability specification ${value.id} digest or status is corrupt`)
  }
  return rebuilt
}

function digestSpecification(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function normalizeOperationalEffects(effects: Partial<OperationalEffects>): OperationalEffects {
  if (typeof effects !== 'object' || effects === null || Array.isArray(effects)) {
    throw new WorkbenchContractError('effects must be an object')
  }
  const network = uniqueTexts(effects.network ?? [], 'effects.network').sort()
  const secrets = uniqueTexts(effects.secrets ?? [], 'effects.secrets').sort()
  const remote = effects.remoteSideEffect
  if (remote !== undefined && !(REMOTE_SIDE_EFFECTS as readonly string[]).includes(remote)) {
    throw new WorkbenchContractError(`effects.remoteSideEffect must be one of ${REMOTE_SIDE_EFFECTS.join(', ')}`)
  }
  return {
    filesystem: uniqueTexts(effects.filesystem ?? [], 'effects.filesystem').sort(),
    network,
    process: uniqueTexts(effects.process ?? [], 'effects.process').sort(),
    secrets,
    externalSystems: uniqueTexts(effects.externalSystems ?? [], 'effects.externalSystems').sort(),
    remoteSideEffect: remote ?? (network.length > 0 || secrets.length > 0 ? 'mutate' : 'none'),
  }
}

function uniqueTexts(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values) || values.length > 40) throw new WorkbenchContractError(`${label} must contain at most 40 items`)
  return [...new Set(values.map((value, index) => boundedText(value, `${label}[${index}]`)))]
}

function boundedText(value: string, label: string, max = 2_000): string {
  if (typeof value !== 'string' || value.trim() === '') throw new WorkbenchContractError(`${label} must be a non-empty string`)
  const text = value.trim()
  if (text.length > max) throw new WorkbenchContractError(`${label} exceeds ${max} characters`)
  return text
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
