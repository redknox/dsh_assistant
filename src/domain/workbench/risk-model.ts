import {
  ADVERSARIAL_SCENARIOS,
  CONTRACT_KINDS,
  FAILURE_MODES,
  IDEMPOTENCY_STRATEGIES,
  RISK_CLASSES,
  SIDE_EFFECT_OUTCOMES,
  type AdversarialScenario,
  type ContractKind,
  type FailureMode,
  type IdempotencyStrategy,
  type RiskClass,
  type RiskModel,
  type SideEffectOutcome,
} from '../reliability/types.js'
import { WorkbenchContractError } from './errors.js'

const RISK_MODEL_KEYS = [
  'capability',
  'declaredClass',
  'externalSystems',
  'trustBoundaries',
  'sideEffects',
  'credentialBoundaries',
  'networkBoundaries',
  'persistence',
  'failureModes',
  'uncertainOutcomes',
  'retryPolicy',
  'idempotency',
  'reconciliation',
  'rollback',
  'observability',
  'validationScenarios',
  'omittedScenarios',
  'unresolvedRisks',
] as const

const TRUST_KEYS = [
  'credentialOwner',
  'networkOwner',
  'candidateNetworkAuthority',
  'filesystemAuthority',
  'processAuthority',
  'persistenceAuthority',
  'approvalAuthority',
  'activationAuthority',
  'recoveryAuthority',
] as const

const RETRY_READS = ['none', 'bounded'] as const
const RETRY_WRITES = ['never-on-unknown', 'only-if-idempotent', 'blind-on-timeout'] as const

/** Runtime-validate a model-supplied Risk Model. Unknown fields and missing contracts fail closed. */
export function parseWorkbenchRiskModel(value: unknown): RiskModel {
  const input = asObject(value, 'riskModel')
  assertAllowedKeys(input, RISK_MODEL_KEYS, 'riskModel')
  const retry = asObject(required(input.retryPolicy, 'riskModel.retryPolicy'), 'riskModel.retryPolicy')
  assertAllowedKeys(retry, ['reads', 'writes', 'budget'], 'riskModel.retryPolicy')
  const idempotency = asObject(required(input.idempotency, 'riskModel.idempotency'), 'riskModel.idempotency')
  assertAllowedKeys(idempotency, ['strategy', 'contractKind', 'evidence'], 'riskModel.idempotency')
  const reconciliation = asObject(required(input.reconciliation, 'riskModel.reconciliation'), 'riskModel.reconciliation')
  assertAllowedKeys(reconciliation, ['strategy', 'independentContext', 'cancelledContextReuse'], 'riskModel.reconciliation')
  const rollback = asObject(required(input.rollback, 'riskModel.rollback'), 'riskModel.rollback')
  assertAllowedKeys(rollback, ['runtimeUnmount', 'compensatesExternal', 'compensation'], 'riskModel.rollback')
  const trust = asObject(required(input.trustBoundaries, 'riskModel.trustBoundaries'), 'riskModel.trustBoundaries')
  assertAllowedKeys(trust, TRUST_KEYS, 'riskModel.trustBoundaries')
  return {
    capability: asString(required(input.capability, 'riskModel.capability'), 'riskModel.capability'),
    ...(input.declaredClass === undefined
      ? {}
      : { declaredClass: asEnum(input.declaredClass, RISK_CLASSES, 'riskModel.declaredClass') }),
    externalSystems: asStringArray(required(input.externalSystems, 'riskModel.externalSystems'), 'riskModel.externalSystems'),
    trustBoundaries: Object.fromEntries(TRUST_KEYS.map((key) => [key, asString(required(trust[key], `riskModel.trustBoundaries.${key}`), `riskModel.trustBoundaries.${key}`)])) as unknown as RiskModel['trustBoundaries'],
    sideEffects: asArray(required(input.sideEffects, 'riskModel.sideEffects'), 'riskModel.sideEffects').map((item, index) => parseSideEffect(item, index)),
    credentialBoundaries: asStringArray(required(input.credentialBoundaries, 'riskModel.credentialBoundaries'), 'riskModel.credentialBoundaries'),
    networkBoundaries: asStringArray(required(input.networkBoundaries, 'riskModel.networkBoundaries'), 'riskModel.networkBoundaries'),
    persistence: asStringArray(required(input.persistence, 'riskModel.persistence'), 'riskModel.persistence'),
    failureModes: asEnumArray(required(input.failureModes, 'riskModel.failureModes'), FAILURE_MODES, 'riskModel.failureModes'),
    uncertainOutcomes: asStringArray(required(input.uncertainOutcomes, 'riskModel.uncertainOutcomes'), 'riskModel.uncertainOutcomes'),
    retryPolicy: {
      reads: asEnum(required(retry.reads, 'riskModel.retryPolicy.reads'), RETRY_READS, 'riskModel.retryPolicy.reads'),
      writes: asEnum(required(retry.writes, 'riskModel.retryPolicy.writes'), RETRY_WRITES, 'riskModel.retryPolicy.writes'),
      ...(retry.budget === undefined ? {} : { budget: asInteger(retry.budget, 'riskModel.retryPolicy.budget') }),
    },
    idempotency: {
      strategy: asEnum(required(idempotency.strategy, 'riskModel.idempotency.strategy'), IDEMPOTENCY_STRATEGIES, 'riskModel.idempotency.strategy'),
      contractKind: asEnum(required(idempotency.contractKind, 'riskModel.idempotency.contractKind'), CONTRACT_KINDS, 'riskModel.idempotency.contractKind'),
      evidence: asString(required(idempotency.evidence, 'riskModel.idempotency.evidence'), 'riskModel.idempotency.evidence'),
    },
    reconciliation: {
      strategy: asString(required(reconciliation.strategy, 'riskModel.reconciliation.strategy'), 'riskModel.reconciliation.strategy'),
      independentContext: asBoolean(required(reconciliation.independentContext, 'riskModel.reconciliation.independentContext'), 'riskModel.reconciliation.independentContext'),
      cancelledContextReuse: asBoolean(required(reconciliation.cancelledContextReuse, 'riskModel.reconciliation.cancelledContextReuse'), 'riskModel.reconciliation.cancelledContextReuse'),
    },
    rollback: {
      runtimeUnmount: asBoolean(required(rollback.runtimeUnmount, 'riskModel.rollback.runtimeUnmount'), 'riskModel.rollback.runtimeUnmount'),
      compensatesExternal: asBoolean(required(rollback.compensatesExternal, 'riskModel.rollback.compensatesExternal'), 'riskModel.rollback.compensatesExternal'),
      ...(rollback.compensation === undefined
        ? {}
        : { compensation: asString(rollback.compensation, 'riskModel.rollback.compensation') }),
    },
    observability: asStringArray(required(input.observability, 'riskModel.observability'), 'riskModel.observability'),
    validationScenarios: asEnumArray(required(input.validationScenarios, 'riskModel.validationScenarios'), ADVERSARIAL_SCENARIOS, 'riskModel.validationScenarios'),
    omittedScenarios: asArray(required(input.omittedScenarios, 'riskModel.omittedScenarios'), 'riskModel.omittedScenarios').map((item, index) => parseOmission(item, index)),
    unresolvedRisks: asStringArray(required(input.unresolvedRisks, 'riskModel.unresolvedRisks'), 'riskModel.unresolvedRisks'),
  }
}

function parseSideEffect(value: unknown, index: number): RiskModel['sideEffects'][number] {
  const input = asObject(value, `riskModel.sideEffects[${index}]`)
  assertAllowedKeys(input, ['action', 'outcomes'], `riskModel.sideEffects[${index}]`)
  return {
    action: asString(required(input.action, `riskModel.sideEffects[${index}].action`), `riskModel.sideEffects[${index}].action`),
    outcomes: asEnumArray(required(input.outcomes, `riskModel.sideEffects[${index}].outcomes`), SIDE_EFFECT_OUTCOMES, `riskModel.sideEffects[${index}].outcomes`),
  }
}

function parseOmission(value: unknown, index: number): RiskModel['omittedScenarios'][number] {
  const input = asObject(value, `riskModel.omittedScenarios[${index}]`)
  assertAllowedKeys(input, ['scenario', 'reason'], `riskModel.omittedScenarios[${index}]`)
  return {
    scenario: asEnum(required(input.scenario, `riskModel.omittedScenarios[${index}].scenario`), ADVERSARIAL_SCENARIOS, `riskModel.omittedScenarios[${index}].scenario`),
    reason: asString(required(input.reason, `riskModel.omittedScenarios[${index}].reason`), `riskModel.omittedScenarios[${index}].reason`),
  }
}

function required(value: unknown, label: string): unknown {
  if (value === undefined) throw new WorkbenchContractError(`${label} is required`)
  return value
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkbenchContractError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertAllowedKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new WorkbenchContractError(`${label} has unknown field ${key}`)
  }
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new WorkbenchContractError(`${label} must be a non-empty string`)
  return value
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new WorkbenchContractError(`${label} must be a boolean`)
  return value
}

function asInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new WorkbenchContractError(`${label} must be a non-negative integer`)
  }
  return value
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new WorkbenchContractError(`${label} must be an array`)
  return value
}

function asStringArray(value: unknown, label: string): string[] {
  return asArray(value, label).map((item, index) => asString(item, `${label}[${index}]`))
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new WorkbenchContractError(`${label} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function asEnumArray<T extends string>(value: unknown, allowed: readonly T[], label: string): T[] {
  return asArray(value, label).map((item, index) => asEnum(item, allowed, `${label}[${index}]`))
}

export function riskModelToolSchema() {
  const strings = { type: 'array' as const, items: { type: 'string' as const } }
  const string = { type: 'string' as const }
  const bool = { type: 'boolean' as const }
  return {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      capability: string,
      declaredClass: { type: 'string' as const, enum: [...RISK_CLASSES] },
      externalSystems: strings,
      trustBoundaries: {
        type: 'object' as const,
        additionalProperties: false,
        properties: Object.fromEntries(TRUST_KEYS.map((key) => [key, string])),
      },
      sideEffects: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            action: string,
            outcomes: { type: 'array' as const, items: { type: 'string' as const, enum: [...SIDE_EFFECT_OUTCOMES] } },
          },
        },
      },
      credentialBoundaries: strings,
      networkBoundaries: strings,
      persistence: strings,
      failureModes: { type: 'array' as const, items: { type: 'string' as const, enum: [...FAILURE_MODES] } },
      uncertainOutcomes: strings,
      retryPolicy: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          reads: { type: 'string' as const, enum: [...RETRY_READS] },
          writes: { type: 'string' as const, enum: [...RETRY_WRITES] },
          budget: { type: 'integer' as const },
        },
      },
      idempotency: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          strategy: { type: 'string' as const, enum: [...IDEMPOTENCY_STRATEGIES] },
          contractKind: { type: 'string' as const, enum: [...CONTRACT_KINDS] },
          evidence: string,
        },
      },
      reconciliation: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          strategy: string,
          independentContext: bool,
          cancelledContextReuse: bool,
        },
      },
      rollback: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          runtimeUnmount: bool,
          compensatesExternal: bool,
          compensation: string,
        },
      },
      observability: strings,
      validationScenarios: { type: 'array' as const, items: { type: 'string' as const, enum: [...ADVERSARIAL_SCENARIOS] } },
      omittedScenarios: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            scenario: { type: 'string' as const, enum: [...ADVERSARIAL_SCENARIOS] },
            reason: string,
          },
        },
      },
      unresolvedRisks: strings,
    },
  }
}

export type { RiskClass, FailureMode, SideEffectOutcome, IdempotencyStrategy, ContractKind, AdversarialScenario }
