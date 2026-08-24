import { evaluateActivationCompatibility, type OwnerExecutionFacts } from '../activation-compatibility/index.js'
import { finding } from './finding.js'
import { REVIEW_POLICY_VERSION, type ReviewFinding, type ReviewPackage, type ReviewReport } from './types.js'

export function activationCompatibilityFindings(
  pkg: ReviewPackage,
  facts?: {
    readonly origin?: string
    readonly provenanceKind?: string
    readonly services?: readonly string[]
    readonly providers?: readonly string[]
    readonly capabilities?: readonly string[]
    readonly activeOwner?: OwnerExecutionFacts
  },
): readonly ReviewFinding[] {
  const result = evaluateActivationCompatibility({
    owner: pkg.candidate.owner,
    provenanceKind: facts?.provenanceKind ?? (pkg.generated === true ? 'generated' : 'managed'),
    origin: facts?.origin ?? (pkg.generated === true ? 'assistant' : undefined),
    resolutionKind: pkg.resolutionKind,
    resolutionCapability: pkg.resolutionCapability,
    capabilities: facts?.capabilities,
    services: facts?.services,
    providers: facts?.providers,
    activeOwner: facts?.activeOwner,
  })
  return result.denials.map((denial) => gate(
    pkg.candidate.digest,
    denial.reason,
    'activation.compatibility',
    denial.detail,
    'Do not request approval. Use a replaceable generated owner or a trusted host product change.',
  ))
}

export function deterministicPrechecks(
  pkg: ReviewPackage,
  facts?: Parameters<typeof activationCompatibilityFindings>[1],
): readonly ReviewFinding[] {
  const digest = pkg.candidate.digest
  const out: ReviewFinding[] = []
  if (pkg.builderClaims?.reviewPassed === true || pkg.builderClaims?.reviewComplete === true) {
    out.push(finding({
      reviewedDigest: digest,
      severity: 'NOTE',
      category: 'self-certification',
      claim: 'builder-claimed-review-success',
      location: 'builderClaims',
      evidence: 'Candidate/builder metadata asserted review success.',
      whyItMatters: 'Builder cannot certify its own work.',
      requiredRemediation: 'Ignore candidate-controlled reviewPassed; host review remains authoritative.',
      status: 'resolved',
      blocking: false,
    }))
  }
  if (!pkg.candidate.sealed) {
    out.push(gate(digest, 'candidate-not-sealed', 'candidate.sealed', 'Review target is not a sealed revision.', 'Seal the candidate before independent review.'))
  }
  if (pkg.candidate.digest === '') {
    out.push(gate(digest, 'missing-digest', 'candidate.digest', 'Review package has no candidate digest.', 'Validate and seal so a digest exists.'))
  }
  if (pkg.policyVersion !== REVIEW_POLICY_VERSION) {
    out.push(gate(
      digest,
      'review-policy-version',
      'policyVersion',
      `Package policy ${pkg.policyVersion} is not ${REVIEW_POLICY_VERSION}.`,
      'Rebuild the review package with the current host policy version.',
    ))
  }
  if (pkg.validationPassed !== true) {
    out.push(gate(digest, 'validation-not-passed', 'validation', 'Deterministic validation did not pass.', 'Fix validation failures before review completion.'))
  }
  const reliabilityRequired = pkg.riskClass === 'R1' || pkg.riskClass === 'R3'
  if (pkg.reliabilityPassed === false || (reliabilityRequired && pkg.reliabilityPassed !== true)) {
    out.push(gate(
      digest,
      'reliability-gate-not-passed',
      'reliability.gate',
      'Mandatory M3 Reliability Gate did not pass.',
      'Satisfy the Reliability Gate for this risk class. Reviewer output cannot waive it.',
    ))
  }
  out.push(...activationCompatibilityFindings(pkg, facts))
  if (pkg.generated && (pkg.riskClass === 'R4' || pkg.reliabilityDerivedClass === 'R4')) {
    out.push(finding({
      reviewedDigest: digest,
      severity: 'BLOCKER',
      category: 'protected-invariant',
      claim: 'generated-r4',
      location: 'riskClass',
      evidence: 'Generated Self-Extension derived R4 control-plane authority.',
      whyItMatters: 'Generated code cannot reviewer-approve recovery/approval authority.',
      requiredRemediation: 'Remove control-plane capabilities from the generated candidate.',
      status: 'open',
    }))
  }
  return out
}

export function lineageOmissions(
  inherited: readonly ReviewFinding[],
  declared: readonly ReviewFinding[],
  digest: string,
): readonly ReviewFinding[] {
  const declaredIds = new Set(declared.map((item) => item.id))
  return inherited
    .filter((item) => item.severity === 'BLOCKER' && item.status === 'open' && !declaredIds.has(item.id))
    .map((item) => finding({
      reviewedDigest: digest,
      severity: 'BLOCKER',
      category: 'lineage',
      claim: `omitted-blocker:${item.id}`,
      location: 'priorFindings',
      evidence: `Previous BLOCKER ${item.id} (${item.claim}) was omitted from this re-review package.`,
      whyItMatters: 'A blocking finding cannot disappear merely because its record was omitted.',
      requiredRemediation: 'Carry the finding forward until the current revision is shown to satisfy the invariant.',
      status: 'open',
    }))
}

function gate(digest: string, claim: string, location: string, evidence: string, remediation: string): ReviewFinding {
  return finding({
    reviewedDigest: digest,
    severity: 'BLOCKER',
    category: 'deterministic-gate',
    claim,
    location,
    evidence,
    whyItMatters: 'Reviewer can add scrutiny but cannot subtract mandatory gates or float the review target.',
    requiredRemediation: remediation,
    status: 'open',
  })
}

export function openBlockers(findings: readonly ReviewFinding[]): readonly ReviewFinding[] {
  return findings.filter((item) => item.blocking && item.status === 'open')
}

export function reportState(findings: readonly ReviewFinding[]): ReviewReport['state'] {
  return openBlockers(findings).length > 0 ? 'changes-required' : 'review-complete'
}
