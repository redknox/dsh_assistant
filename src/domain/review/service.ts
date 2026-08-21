import type { CandidateRecord } from '../candidate/types.js'
import { reviewPackageFromCandidate } from './package.js'
import { formatReviewReport } from './format.js'
import { bindResolutionToDigest, inheritedOpenBlockers, resolveCarriedFindings, resolveHostParent } from './lineage.js'
import { deterministicPrechecks, lineageOmissions, reportState } from './precheck.js'
import { PolicyReviewerProvider } from './provider.js'
import type {
  IndependentReview,
  ReviewFinding,
  ReviewPackage,
  ReviewPackageExtras,
  ReviewReport,
  ReviewState,
  ReviewerProvider,
} from './types.js'
import { REVIEW_POLICY_VERSION } from './types.js'

export class ReviewService implements IndependentReview {
  private readonly byCandidate = new Map<string, ReviewReport>()
  private readonly byDigest = new Map<string, ReviewReport>()

  constructor(
    private readonly semantic: ReviewerProvider = new PolicyReviewerProvider(),
    private readonly loadCandidate?: (id: string) => CandidateRecord,
  ) {}

  review(pkg: ReviewPackage): ReviewReport {
    const policy = { version: pkg.policyVersion, riskClass: pkg.riskClass }
    const prechecks = deterministicPrechecks(pkg)
    const semantic = this.semantic.semanticReview(pkg, policy)
    const current = bindResolutionToDigest(dedupe([...prechecks, ...semantic]), pkg)
    const parent = resolveHostParent(pkg, {
      previousForCandidate: (id) => this.byCandidate.get(id),
      reportForDigest: (digest) => this.byDigest.get(digest),
    })
    const inherited = inheritedOpenBlockers(parent.report, pkg.priorFindings)
    const omissions = lineageOmissions(inherited, pkg.priorFindings, pkg.candidate.digest)
    const carried = resolveCarriedFindings(inherited, current, pkg)
    const findings = dedupe([
      ...current,
      ...carried,
      ...omissions,
      ...(parent.invalidParent ? [parent.invalidParent] : []),
    ])
    const state = reportState(findings)
    const report: ReviewReport = {
      candidateId: pkg.candidate.id,
      digest: pkg.candidate.digest,
      policyVersion: REVIEW_POLICY_VERSION,
      riskClass: pkg.riskClass,
      state,
      findings,
      approvalStatus: 'NOT APPROVED',
      summary: '',
    }
    const withSummary = { ...report, summary: formatReviewReport(report) }
    this.byCandidate.set(pkg.candidate.id, withSummary)
    if (pkg.candidate.digest) this.byDigest.set(pkg.candidate.digest, withSummary)
    return withSummary
  }

  reviewCandidate(id: string, extras: ReviewPackageExtras = {}): ReviewReport {
    if (!this.loadCandidate) {
      throw new Error('reviewCandidate requires a candidate workspace binding')
    }
    return this.review(reviewPackageFromCandidate(this.loadCandidate(id), extras))
  }

  status(candidate: { readonly id: string; readonly digest?: string }): ReviewState {
    const last = this.byCandidate.get(candidate.id)
    if (!last) return 'not-reviewed'
    if (candidate.digest !== undefined && candidate.digest !== last.digest) return 'stale'
    return last.state
  }

  lastReport(candidateId: string): ReviewReport | undefined {
    return this.byCandidate.get(candidateId)
  }
}

function dedupe(findings: readonly ReviewFinding[]): readonly ReviewFinding[] {
  const seen = new Map<string, ReviewFinding>()
  for (const item of findings) {
    const existing = seen.get(item.id)
    if (!existing || (existing.status === 'resolved' && item.status === 'open')) {
      seen.set(item.id, item)
    }
  }
  return [...seen.values()]
}
