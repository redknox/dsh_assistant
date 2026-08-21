import { REVIEW_POLICY_VERSION, type ReviewFinding, type ReviewPackage } from './types.js'

function openPriorBlockers(declared: readonly ReviewFinding[]): readonly ReviewFinding[] {
  return declared.filter((item) => item.severity === 'BLOCKER' && item.status === 'open')
}

/** Host-owned proof that a known invariant is satisfied on this revision. Silence is not proof. */
export function hostResolutionEvidence(pkg: ReviewPackage, item: ReviewFinding): string | undefined {
  const digest = pkg.candidate.digest
  switch (item.claim) {
    case 'cancelled-context-reuse':
      return pkg.cancelledContextReuse === false
        ? `Host check: cancelledContextReuse is false on ${digest}.`
        : undefined
    case 'dependent-reconciliation-context':
      return pkg.independentReconciliation === true
        ? `Host check: independentContext is true on ${digest}.`
        : undefined
    case 'fixture-semantics-as-contract':
      return pkg.contractKind === 'real-provider-contract' && pkg.idempotencyStrategy !== 'fixture-only'
        ? `Host check: real-provider-contract evidence on ${digest}.`
        : undefined
    case 'blind-write-on-timeout':
      return pkg.riskModel?.retryPolicy.writes !== undefined && pkg.riskModel.retryPolicy.writes !== 'blind-on-timeout'
        ? `Host check: writes are not blind-on-timeout on ${digest}.`
        : undefined
    case 'rollback-overclaim':
      return pkg.riskModel !== undefined
        && (pkg.riskModel.rollback.compensatesExternal !== true || Boolean(pkg.riskModel.rollback.compensation))
        ? `Host check: rollback does not overclaim compensation on ${digest}.`
        : undefined
    case 'reliability-gate-not-passed': {
      const required = pkg.riskClass === 'R1' || pkg.riskClass === 'R3'
      return pkg.reliabilityPassed === true || (!required && pkg.reliabilityPassed !== false)
        ? `Host check: Reliability Gate passed on ${digest}.`
        : undefined
    }
    case 'validation-not-passed':
      return pkg.validationPassed === true ? `Host check: validation passed on ${digest}.` : undefined
    case 'generated-r4':
      return pkg.generated && (pkg.riskClass === 'R4' || pkg.reliabilityDerivedClass === 'R4')
        ? undefined
        : `Host check: generated candidate is not R4 on ${digest}.`
    case 'candidate-not-sealed':
      return pkg.candidate.sealed ? `Host check: candidate is sealed on ${digest}.` : undefined
    case 'missing-digest':
      return pkg.candidate.digest !== '' ? `Host check: digest is present on ${digest}.` : undefined
    case 'review-policy-version':
      return pkg.policyVersion === REVIEW_POLICY_VERSION
        ? `Host check: policy version ${REVIEW_POLICY_VERSION} on ${digest}.`
        : undefined
    default:
      return undefined
  }
}

export function bindResolutionToDigest(
  findings: readonly ReviewFinding[],
  pkg: ReviewPackage,
): readonly ReviewFinding[] {
  const digest = pkg.candidate.digest
  return findings.map((item) => {
    if (item.status !== 'resolved' || item.reviewedDigest === digest) return item
    if (!item.blocking) return item
    const host = hostResolutionEvidence(pkg, item)
    if (host) {
      return { ...item, reviewedDigest: digest, status: 'resolved', evidence: host }
    }
    return {
      ...item,
      status: 'open' as const,
      reviewedDigest: digest,
      evidence: `Stale resolution evidence on ${item.reviewedDigest} cannot close ${digest}.`,
    }
  })
}

/**
 * Prior open BLOCKERs stay open unless current-revision evidence proves resolution.
 * Reviewer silence is not resolution evidence.
 */
export function resolveCarriedFindings(
  declared: readonly ReviewFinding[],
  current: readonly ReviewFinding[],
  pkg: ReviewPackage,
): readonly ReviewFinding[] {
  const digest = pkg.candidate.digest
  const currentById = new Map(current.map((item) => [item.id, item]))
  const out: ReviewFinding[] = []
  for (const prior of openPriorBlockers(declared)) {
    const now = currentById.get(prior.id)
    if (now?.status === 'open') continue
    if (now?.status === 'resolved' && now.reviewedDigest === digest) continue
    const host = hostResolutionEvidence(pkg, prior)
    if (host) {
      out.push({
        ...prior,
        reviewedDigest: digest,
        status: 'resolved',
        evidence: host,
      })
      continue
    }
    out.push({
      ...prior,
      reviewedDigest: digest,
      status: 'open',
      evidence: `${prior.evidence} Remains open: no current-revision resolution evidence on ${digest}.`,
    })
  }
  return out
}
