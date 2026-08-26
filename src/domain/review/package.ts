import { deriveRiskClass } from '../reliability/classify.js'
import type { CandidateRecord } from '../candidate/types.js'
import { REVIEW_PACKAGE_KEYS, REVIEW_POLICY_VERSION, type ReviewPackage, type ReviewPackageExtras } from './types.js'

const FORBIDDEN_KEYS = ['builderScratch', 'chainOfThought', 'hiddenState', 'privateScratch'] as const

/** Host-built review input. Never trusts candidate-supplied reviewPassed. */
export function reviewPackageFromCandidate(record: CandidateRecord, extras: ReviewPackageExtras = {}): ReviewPackage {
  const reliability = record.validation?.reliability
  const riskModel = extras.riskModel ?? record.manifest.riskModel ?? reliability?.model
  const claimed = (record.manifest as CandidateRecord['manifest'] & { reviewPassed?: unknown }).reviewPassed
  return {
    policyVersion: extras.policyVersion ?? REVIEW_POLICY_VERSION,
    candidate: {
      id: record.id,
      owner: record.owner,
      version: record.version,
      digest: record.digest ?? '',
      sealed: record.sealed,
      parentRevision: extras.parentRevision,
    },
    resolutionKind: extras.resolutionKind ?? record.manifest.resolutionKind,
    resolutionCapability: extras.resolutionCapability ?? record.manifest.resolutionCapability,
    riskClass: extras.riskClass ?? reliability?.derivedClass ?? deriveRiskClass(record.manifest),
    riskModel,
    reliabilityPassed: extras.reliabilityPassed ?? reliability?.passed,
    reliabilityDerivedClass: extras.reliabilityDerivedClass ?? reliability?.derivedClass,
    validationPassed: extras.validationPassed ?? record.validation?.passed === true,
    validationStages: extras.validationStages ?? (record.validation?.stages ?? []).map((item) => ({
      name: item.name,
      status: item.status,
    })),
    permissionDiff: extras.permissionDiff,
    effectDiff: extras.effectDiff,
    contractKind: extras.contractKind ?? riskModel?.idempotency.contractKind,
    idempotencyStrategy: extras.idempotencyStrategy ?? riskModel?.idempotency.strategy,
    cancelledContextReuse: extras.cancelledContextReuse ?? riskModel?.reconciliation.cancelledContextReuse,
    independentReconciliation: extras.independentReconciliation ?? riskModel?.reconciliation.independentContext,
    generated: extras.generated ?? (
      record.provenance.kind === 'generated' || record.provenance.kind === 'third-party'
    ),
    priorFindings: extras.priorFindings ?? [],
    builderClaims: extras.builderClaims ?? (claimed !== undefined ? { reviewPassed: claimed } : undefined),
  }
}

export function hiddenReviewKeys(pkg: ReviewPackage): readonly string[] {
  return Object.keys(pkg).filter((key) => (
    (FORBIDDEN_KEYS as readonly string[]).includes(key)
    || !(REVIEW_PACKAGE_KEYS as readonly string[]).includes(key)
  ))
}
