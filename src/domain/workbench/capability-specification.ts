import { createHash } from 'node:crypto'
import { parseCapabilityId, parsePermission } from '../registry/normalize.js'
import { REMOTE_SIDE_EFFECTS, type OperationalEffects } from '../candidate/types.js'
import { WorkbenchContractError } from './errors.js'

export const CAPABILITY_SPECIFICATION_STAMP = 'capability-specification.json'
export const CAPABILITY_SPECIFICATION_VERSION = 'capability-specification/v1'

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
}

export interface CapabilitySpecification {
  readonly id: string
  readonly version: typeof CAPABILITY_SPECIFICATION_VERSION
  readonly revision: number
  readonly source: 'explicit' | 'legacy'
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

export function defineCapabilitySpecification(
  id: string,
  input: CapabilitySpecificationInput,
  source: CapabilitySpecification['source'] = 'explicit',
): CapabilitySpecification {
  const capability = parseCapabilityId(input.capability)
  const goal = boundedText(input.goal, 'goal')
  const nonGoals = uniqueTexts(input.nonGoals ?? [], 'nonGoals')
  const inputs = (input.inputs ?? []).map((item, index) => ({
    name: boundedText(item.name, `inputs[${index}].name`, 120),
    description: boundedText(item.description, `inputs[${index}].description`),
    required: item.required === true,
  }))
  const businessRules = uniqueTexts(input.businessRules ?? [], 'businessRules')
  const permissions = [...new Set((input.permissions ?? []).map(parsePermission))].sort()
  const effects = normalizeOperationalEffects(input.effects ?? {})
  const acceptanceExamples = (input.acceptanceExamples ?? []).map((example, index) => ({
    name: boundedText(example.name, `acceptanceExamples[${index}].name`, 160),
    given: uniqueTexts(example.given, `acceptanceExamples[${index}].given`),
    when: boundedText(example.when, `acceptanceExamples[${index}].when`),
    then: uniqueTexts(example.then, `acceptanceExamples[${index}].then`),
  }))
  const unresolved = uniqueTexts(input.unresolved ?? [], 'unresolved')
  if (source === 'explicit' && businessRules.length === 0) unresolved.push('At least one business rule is required.')
  if (source === 'explicit' && acceptanceExamples.length === 0) unresolved.push('At least one acceptance example is required.')
  const body = {
    id,
    version: CAPABILITY_SPECIFICATION_VERSION as typeof CAPABILITY_SPECIFICATION_VERSION,
    revision: 1,
    source,
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
  return { ...body, digest: digestSpecification(body) }
}

export function capabilitySpecificationStamp(specification: CapabilitySpecification): string {
  return `${JSON.stringify(specification, null, 2)}\n`
}

export function assertCapabilitySpecification(value: unknown): CapabilitySpecification {
  if (!isObject(value)) throw new WorkbenchContractError('capability specification must be an object')
  if (typeof value.id !== 'string' || !/^spec-(?:\d+|legacy-[A-Za-z0-9._-]+)$/.test(value.id)) {
    throw new WorkbenchContractError('capability specification has an invalid id')
  }
  if (value.version !== CAPABILITY_SPECIFICATION_VERSION || value.revision !== 1) {
    throw new WorkbenchContractError('capability specification has an unsupported version or revision')
  }
  if (value.source !== 'explicit' && value.source !== 'legacy') {
    throw new WorkbenchContractError('capability specification has an invalid source')
  }
  const rebuilt = defineCapabilitySpecification(value.id, value as unknown as CapabilitySpecificationInput, value.source)
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
