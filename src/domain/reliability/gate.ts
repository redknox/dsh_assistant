import type { CandidateManifest } from '../candidate/types.js'
import { deriveRiskClass, riskRank } from './classify.js'
import { coveredOrOmitted, synthesizeR0, synthesizeR2 } from './defaults.js'
import type {
  ReliabilityCheck,
  ReliabilityCheckName,
  ReliabilityGateResult,
  RiskClass,
  RiskModel,
} from './types.js'

const R3_FAILURES = [
  'timeout-before-side-effect',
  'timeout-after-side-effect',
  'duplicate-request',
  'caller-cancelled',
  'reconciliation-failed',
  'auth-failure',
  'rate-limit',
] as const

const R3_SCENARIOS = [
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

const R2_SCENARIOS = ['happy-path', 'fail-before-side-effect', 'restart-boundary', 'rollback-interaction'] as const
const R1_SCENARIOS = ['happy-path', 'credential-failure', 'rate-limit'] as const

function check(name: ReliabilityCheckName, passed: boolean, detail: string): ReliabilityCheck {
  return { name, passed, detail }
}

/** A fake may simulate a provider. It may not define provider semantics. */
export function hasRealContractEvidence(model: RiskModel): boolean {
  return model.idempotency.contractKind === 'real-provider-contract'
    && model.idempotency.strategy !== 'fixture-only'
    && model.idempotency.evidence.trim() !== ''
}

function requiredFor(risk: RiskClass): readonly ReliabilityCheckName[] {
  const base: ReliabilityCheckName[] = ['risk-model-present', 'risk-class-consistent', 'control-plane-not-escalated', 'retry-policy-valid']
  if (risk === 'R0') return base
  if (risk === 'R1') return [...base, 'trust-boundaries-declared', 'secret-safety-valid', 'real-contract-evidence-present', 'adversarial-tests-covered']
  if (risk === 'R2') {
    return [...base, 'side-effects-classified', 'trust-boundaries-declared', 'adversarial-tests-covered', 'rollback-semantics-valid']
  }
  return [
    ...base,
    'side-effects-classified',
    'trust-boundaries-declared',
    'failure-modes-covered',
    'real-contract-evidence-present',
    'idempotency-reconciliation-valid',
    'adversarial-tests-covered',
    'secret-safety-valid',
    'rollback-semantics-valid',
  ]
}

function evaluateChecks(manifest: CandidateManifest, derived: RiskClass, model: RiskModel, synthesized: boolean): ReliabilityCheck[] {
  const declared = model.declaredClass
  const downgrade = declared !== undefined && riskRank(declared) < riskRank(derived)
  const generated = manifest.provenance.kind === 'generated' || manifest.provenance.kind === 'third-party'
  const requiredScenarios = derived === 'R3' ? R3_SCENARIOS : derived === 'R2' ? R2_SCENARIOS : derived === 'R1' ? R1_SCENARIOS : ['happy-path'] as const
  const missingScenarios = coveredOrOmitted(model, requiredScenarios)
  const mutatingWrite = model.sideEffects.some((item) => item.outcomes.length > 0)
  const unknownDeclared = model.sideEffects.some((item) => item.outcomes.includes('unknown'))
    || model.uncertainOutcomes.length > 0
  const missingFailures = derived === 'R3' ? R3_FAILURES.filter((item) => !model.failureModes.includes(item)) : []
  const arbitraryNet = model.trustBoundaries.candidateNetworkAuthority === 'arbitrary-fetch'
    || model.trustBoundaries.candidateNetworkAuthority === '*'
  const credentialed = manifest.secrets.length > 0 || manifest.effects.secrets.length > 0
  const controlPlaneOwned = [model.trustBoundaries.approvalAuthority, model.trustBoundaries.activationAuthority, model.trustBoundaries.recoveryAuthority]
    .some((item) => item !== 'recovery-root' && item !== 'host')

  return [
    check('risk-model-present', !synthesized || derived === 'R0' || derived === 'R2', synthesized && derived !== 'R0' && derived !== 'R2'
      ? 'Credentialed/external-risk candidates must carry an explicit Risk Model.'
      : synthesized ? `Synthesized an explicit ${derived} Risk Model.` : 'Risk Model is present.'),
    check('risk-class-consistent', !downgrade, downgrade
      ? `Declared ${declared} is below derived ${derived}; candidates cannot self-downgrade.`
      : `Effective class is ${declared !== undefined && riskRank(declared) > riskRank(derived) ? declared : derived}.`),
    check('control-plane-not-escalated', !(generated && derived === 'R4') && !controlPlaneOwned,
      generated && derived === 'R4'
        ? 'Generated Self-Extension must not escalate into R4 control-plane authority.'
        : controlPlaneOwned
          ? 'Approval/activation/recovery authority must stay on the Recovery Root.'
          : 'Control-plane authority remains on the Recovery Root.'),
    check('side-effects-classified', derived < 'R2' || (mutatingWrite && (derived !== 'R3' || unknownDeclared)),
      derived === 'R3' && !unknownDeclared
        ? 'Credentialed writes must classify applied / not-applied / unknown outcomes.'
        : 'Side-effect outcomes are classified.'),
    check('trust-boundaries-declared', model.trustBoundaries.approvalAuthority === 'recovery-root'
      && model.trustBoundaries.activationAuthority === 'recovery-root'
      && model.trustBoundaries.recoveryAuthority === 'recovery-root',
    'Trust boundaries for approval/activation/recovery are declared.'),
    check('failure-modes-covered', missingFailures.length === 0,
      missingFailures.length > 0
        ? `Missing mandatory failure modes: ${missingFailures.join(', ')}.`
        : 'Required failure modes are declared.'),
    check('real-contract-evidence-present', hasRealContractEvidence(model),
      hasRealContractEvidence(model)
        ? 'Provider/runtime contract evidence is present.'
        : 'Fixture-only or test-double behavior is not provider-contract evidence.'),
    check('retry-policy-valid', model.retryPolicy.writes !== 'blind-on-timeout',
      model.retryPolicy.writes === 'blind-on-timeout'
        ? 'Blind write retry after timeout is rejected for non-idempotent/uncertain writes.'
        : 'Write retries stay side-effect-safe.'),
    check('idempotency-reconciliation-valid', derived < 'R3' || (
      model.reconciliation.independentContext
      && model.reconciliation.cancelledContextReuse === false
      && model.reconciliation.strategy !== ''
    ), model.reconciliation.cancelledContextReuse
      ? 'Cancelled/expired caller context cannot satisfy reconciliation.'
      : 'Idempotency and independent reconciliation context are documented.'),
    check('adversarial-tests-covered', missingScenarios.length === 0,
      missingScenarios.length > 0
        ? `Missing adversarial coverage or omission justification: ${missingScenarios.join(', ')}.`
        : 'Adversarial scenarios are covered or explicitly omitted.'),
    check('secret-safety-valid', (!credentialed || model.trustBoundaries.credentialOwner === 'host') && !arbitraryNet,
      arbitraryNet
        ? 'Candidate network authority cannot widen to arbitrary fetch.'
        : credentialed && model.trustBoundaries.credentialOwner !== 'host'
          ? 'Credentials must stay at the host-owned transport boundary.'
          : 'Credential and network authority stay host-bounded.'),
    check('rollback-semantics-valid', !model.rollback.compensatesExternal || (model.rollback.compensation !== undefined && model.rollback.compensation !== ''),
      model.rollback.compensatesExternal && !model.rollback.compensation
        ? 'Runtime rollback must not claim external undo without a compensating action.'
        : 'Rollback is documented as runtime unmount, not remote compensation, unless a compensating action exists.'),
  ]
}

export function evaluateReliability(manifest: CandidateManifest): ReliabilityGateResult {
  const derived = deriveRiskClass(manifest)
  const synthesized = manifest.riskModel === undefined
  const model = manifest.riskModel ?? (derived === 'R2'
    ? synthesizeR2(manifest.resolutionCapability)
    : synthesizeR0(manifest.resolutionCapability))
  const effective = model.declaredClass !== undefined && riskRank(model.declaredClass) > riskRank(derived)
    ? model.declaredClass
    : derived
  const checks = evaluateChecks(manifest, derived, model, synthesized)
  const required = new Set(requiredFor(effective === 'R4' ? derived : effective))
  const applicable = checks.filter((item) => required.has(item.name))
  const passed = applicable.every((item) => item.passed) && !(synthesized && derived !== 'R0' && derived !== 'R2')
  return {
    derivedClass: derived,
    effectiveClass: effective,
    synthesized,
    model,
    checks: applicable,
    passed,
    unresolved: model.unresolvedRisks,
  }
}

export function reliabilitySummary(result: ReliabilityGateResult): string {
  if (result.passed) return `Reliability gate passed for ${result.effectiveClass}.`
  const failed = result.checks.filter((item) => !item.passed).map((item) => `${item.name}: ${item.detail}`)
  return `Reliability gate failed for ${result.effectiveClass}. ${failed.join(' ')}`
}
