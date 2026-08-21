import type { AdversarialScenario, RiskModel, TrustBoundaries } from './types.js'
import { ADVERSARIAL_SCENARIOS } from './types.js'

export const HOST_CONTROL_BOUNDARIES: TrustBoundaries = {
  credentialOwner: 'host',
  networkOwner: 'host',
  candidateNetworkAuthority: 'none',
  filesystemAuthority: 'none',
  processAuthority: 'none',
  persistenceAuthority: 'host',
  approvalAuthority: 'recovery-root',
  activationAuthority: 'recovery-root',
  recoveryAuthority: 'recovery-root',
}

export function omitHighRiskScenarios(reason: string): RiskModel['omittedScenarios'] {
  return ADVERSARIAL_SCENARIOS
    .filter((item) => item !== 'happy-path')
    .map((scenario) => ({ scenario, reason }))
}

export function synthesizeLocal(capability: string, risk: 'R0' | 'R2'): RiskModel {
  const mutating = risk === 'R2'
  const covered = mutating
    ? ['happy-path', 'fail-before-side-effect', 'restart-boundary', 'rollback-interaction'] as const
    : ['happy-path'] as const
  return {
    capability,
    declaredClass: risk,
    externalSystems: [],
    trustBoundaries: {
      ...HOST_CONTROL_BOUNDARIES,
      filesystemAuthority: mutating ? 'host-or-confined' : 'none',
    },
    sideEffects: mutating ? [{ action: capability, outcomes: ['not-applied', 'applied'] }] : [],
    credentialBoundaries: [],
    networkBoundaries: [],
    persistence: mutating ? ['local'] : [],
    failureModes: mutating ? ['input-invalid', 'local-persistence-failure'] : ['input-invalid'],
    uncertainOutcomes: [],
    retryPolicy: { reads: 'none', writes: 'never-on-unknown' },
    idempotency: {
      strategy: 'none',
      contractKind: 'not-applicable',
      evidence: mutating ? 'Local mutation; no remote provider contract.' : 'R0 has no external mutation.',
    },
    reconciliation: { strategy: 'not-applicable', independentContext: true, cancelledContextReuse: false },
    rollback: { runtimeUnmount: true, compensatesExternal: false },
    observability: ['validation-report'],
    validationScenarios: [...covered],
    omittedScenarios: omitHighRiskScenarios(
      mutating
        ? 'Local mutation; no credentialed remote side effect.'
        : 'R0 local/deterministic capability; no external mutation.',
    ).filter((item) => !(covered as readonly string[]).includes(item.scenario)),
    unresolvedRisks: [],
  }
}

export function synthesizeR0(capability: string): RiskModel {
  return synthesizeLocal(capability, 'R0')
}

export function synthesizeR2(capability: string): RiskModel {
  return synthesizeLocal(capability, 'R2')
}

export function coveredOrOmitted(model: RiskModel, required: readonly AdversarialScenario[]): readonly AdversarialScenario[] {
  const covered = new Set<AdversarialScenario>([
    ...model.validationScenarios,
    ...model.omittedScenarios.map((item) => item.scenario),
  ])
  return required.filter((item) => !covered.has(item))
}
