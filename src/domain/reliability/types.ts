export const RISK_CLASSES = ['R0', 'R1', 'R2', 'R3', 'R4'] as const
export type RiskClass = (typeof RISK_CLASSES)[number]

export const FAILURE_MODES = [
  'input-invalid',
  'permission-denied',
  'auth-failure',
  'provider-4xx',
  'rate-limit',
  'provider-5xx',
  'timeout-before-side-effect',
  'timeout-after-side-effect',
  'caller-cancelled',
  'partial-success',
  'duplicate-request',
  'stale-state',
  'concurrent-change',
  'network-partition',
  'reconciliation-failed',
  'credential-expired',
  'schema-drift',
  'provider-contract-drift',
  'local-persistence-failure',
  'restart-during-operation',
  'rollback-failure',
] as const
export type FailureMode = (typeof FAILURE_MODES)[number]

export const SIDE_EFFECT_OUTCOMES = ['not-applied', 'applied', 'unknown', 'reconciled'] as const
export type SideEffectOutcome = (typeof SIDE_EFFECT_OUTCOMES)[number]

export const IDEMPOTENCY_STRATEGIES = [
  'none',
  'provider-native-key',
  'deterministic-resource-id',
  'compare-and-set',
  'transaction-id',
  'read-after-uncertain-write',
  'provider-operation-lookup',
  'fixture-only',
] as const
export type IdempotencyStrategy = (typeof IDEMPOTENCY_STRATEGIES)[number]

export const CONTRACT_KINDS = ['not-applicable', 'real-provider-contract', 'test-double'] as const
export type ContractKind = (typeof CONTRACT_KINDS)[number]

export const ADVERSARIAL_SCENARIOS = [
  'happy-path',
  'fail-before-side-effect',
  'fail-after-side-effect',
  'duplicate-delivery',
  'caller-cancellation',
  'reconciliation-unavailable',
  'credential-failure',
  'rate-limit',
  'stale-proposal',
  'restart-boundary',
  'rollback-interaction',
] as const
export type AdversarialScenario = (typeof ADVERSARIAL_SCENARIOS)[number]

export const RELIABILITY_CHECKS = [
  'risk-model-present',
  'risk-class-consistent',
  'control-plane-not-escalated',
  'side-effects-classified',
  'trust-boundaries-declared',
  'failure-modes-covered',
  'real-contract-evidence-present',
  'retry-policy-valid',
  'idempotency-reconciliation-valid',
  'adversarial-tests-covered',
  'secret-safety-valid',
  'rollback-semantics-valid',
] as const
export type ReliabilityCheckName = (typeof RELIABILITY_CHECKS)[number]

export interface TrustBoundaries {
  readonly credentialOwner: string
  readonly networkOwner: string
  readonly candidateNetworkAuthority: string
  readonly filesystemAuthority: string
  readonly processAuthority: string
  readonly persistenceAuthority: string
  readonly approvalAuthority: string
  readonly activationAuthority: string
  readonly recoveryAuthority: string
}

export interface RetryPolicy {
  readonly reads: 'none' | 'bounded'
  readonly writes: 'never-on-unknown' | 'only-if-idempotent' | 'blind-on-timeout'
  readonly budget?: number
}

export interface IdempotencyClaim {
  readonly strategy: IdempotencyStrategy
  readonly contractKind: ContractKind
  readonly evidence: string
}

export interface ReconciliationPolicy {
  readonly strategy: string
  readonly independentContext: boolean
  readonly cancelledContextReuse: boolean
}

export interface RollbackSemantics {
  readonly runtimeUnmount: boolean
  readonly compensatesExternal: boolean
  readonly compensation?: string
}

export interface SideEffectClaim {
  readonly action: string
  readonly outcomes: readonly SideEffectOutcome[]
}

export interface ScenarioOmission {
  readonly scenario: AdversarialScenario
  readonly reason: string
}

export interface RiskModel {
  readonly capability: string
  readonly declaredClass?: RiskClass
  readonly externalSystems: readonly string[]
  readonly trustBoundaries: TrustBoundaries
  readonly sideEffects: readonly SideEffectClaim[]
  readonly credentialBoundaries: readonly string[]
  readonly networkBoundaries: readonly string[]
  readonly persistence: readonly string[]
  readonly failureModes: readonly FailureMode[]
  readonly uncertainOutcomes: readonly string[]
  readonly retryPolicy: RetryPolicy
  readonly idempotency: IdempotencyClaim
  readonly reconciliation: ReconciliationPolicy
  readonly rollback: RollbackSemantics
  readonly observability: readonly string[]
  readonly validationScenarios: readonly AdversarialScenario[]
  readonly omittedScenarios: readonly ScenarioOmission[]
  readonly unresolvedRisks: readonly string[]
}

export interface ReliabilityCheck {
  readonly name: ReliabilityCheckName
  readonly passed: boolean
  readonly detail: string
}

export interface ReliabilityGateResult {
  readonly derivedClass: RiskClass
  readonly effectiveClass: RiskClass
  readonly synthesized: boolean
  readonly model: RiskModel
  readonly checks: readonly ReliabilityCheck[]
  readonly passed: boolean
  readonly unresolved: readonly string[]
}
