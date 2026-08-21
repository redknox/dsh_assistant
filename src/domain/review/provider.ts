import { finding } from './finding.js'
import type { ReviewFinding, ReviewPackage, ReviewPolicy, ReviewerProvider } from './types.js'

/** Host-managed adversarial checklist. Same model may back this later; context is always a fresh Review Package. */
export class PolicyReviewerProvider implements ReviewerProvider {
  constructor(private readonly extra: (pkg: ReviewPackage) => readonly ReviewFinding[] = () => []) {}

  semanticReview(pkg: ReviewPackage, policy: ReviewPolicy): readonly ReviewFinding[] {
    const digest = pkg.candidate.digest
    const extras = this.extra(pkg)
    if (policy.riskClass === 'R0') {
      return [
        finding({
          reviewedDigest: digest,
          severity: 'NOTE',
          category: 'acceptance-contract',
          claim: 'lightweight-r0-review',
          location: 'policy',
          evidence: 'R0 local/deterministic candidate; lightweight contract/regression review only.',
          whyItMatters: 'Review depth scales with risk class; R0 must not be forced through R3 ceremony.',
          requiredRemediation: 'None.',
          status: 'resolved',
          blocking: false,
        }),
        ...extras,
      ]
    }
    const out: ReviewFinding[] = []
    if (policy.riskClass === 'R1' || policy.riskClass === 'R3') {
      if (pkg.contractKind === 'test-double' || pkg.idempotencyStrategy === 'fixture-only') {
        out.push(finding({
          reviewedDigest: digest,
          severity: 'BLOCKER',
          category: 'provider-contract',
          claim: 'fixture-semantics-as-contract',
          location: 'idempotency',
          evidence: `contractKind=${String(pkg.contractKind)} strategy=${String(pkg.idempotencyStrategy)}`,
          whyItMatters: 'Fixture behavior must not exceed the real provider contract.',
          requiredRemediation: 'Cite a real-provider-contract with non-fixture evidence.',
          status: 'open',
        }))
      }
    }
    if (policy.riskClass === 'R2' || policy.riskClass === 'R3') {
      if (pkg.riskModel?.rollback.compensatesExternal === true && !pkg.riskModel.rollback.compensation) {
        out.push(finding({
          reviewedDigest: digest,
          severity: 'BLOCKER',
          category: 'rollback-recovery',
          claim: 'rollback-overclaim',
          location: 'rollback',
          evidence: 'Rollback claims external compensation without a compensation description.',
          whyItMatters: 'Rollback claims must not exceed what rollback actually does.',
          requiredRemediation: 'Set compensatesExternal false or describe the compensating action.',
          status: 'open',
        }))
      }
    }
    if (policy.riskClass === 'R3') {
      if (pkg.cancelledContextReuse === true) {
        out.push(finding({
          reviewedDigest: digest,
          severity: 'BLOCKER',
          category: 'retry-idempotency',
          claim: 'cancelled-context-reuse',
          location: 'reconciliation.cancelledContextReuse',
          evidence: 'Uncertain-write reconciliation reuses a cancelled context.',
          whyItMatters: 'A cancelled signal is not a reconciliation budget.',
          requiredRemediation: 'Reconcile with an independent context and cancelledContextReuse: false.',
          status: 'open',
        }))
      }
      if (pkg.independentReconciliation === false) {
        out.push(finding({
          reviewedDigest: digest,
          severity: 'BLOCKER',
          category: 'retry-idempotency',
          claim: 'dependent-reconciliation-context',
          location: 'reconciliation.independentContext',
          evidence: 'Reconciliation is not independent of the original cancelled attempt.',
          whyItMatters: 'Unknown write outcomes need a fresh reconciliation context.',
          requiredRemediation: 'Set independentContext: true and do not reuse the cancelled AbortSignal.',
          status: 'open',
        }))
      }
      if (pkg.riskModel?.retryPolicy.writes === 'blind-on-timeout') {
        out.push(finding({
          reviewedDigest: digest,
          severity: 'BLOCKER',
          category: 'retry-idempotency',
          claim: 'blind-write-on-timeout',
          location: 'retryPolicy.writes',
          evidence: 'Writes retry blindly after timeout.',
          whyItMatters: 'A timeout after a possible side effect is unknown, not safe to retry.',
          requiredRemediation: 'Use never-on-unknown or only-if-idempotent with real-provider evidence.',
          status: 'open',
        }))
      }
      out.push(finding({
        reviewedDigest: digest,
        severity: 'NOTE',
        category: 'failure-mode',
        claim: 'r3-adversarial-policy-applied',
        location: 'policy',
        evidence: 'Full adversarial side-effect / uncertain-outcome / retry / reconciliation review ran.',
        whyItMatters: 'R3 ceremony is required for credentialed external mutation.',
        requiredRemediation: 'None.',
        status: 'resolved',
        blocking: false,
      }))
    }
    return [...out, ...extras]
  }
}

/** Semantic reviewer that always says the design looks fine. Deterministic prechecks still apply. */
export class PermissiveReviewerProvider implements ReviewerProvider {
  semanticReview(): readonly ReviewFinding[] {
    return []
  }
}
