import type { CandidateRecord } from '../candidate/types.js'
import { reviewPackageFromCandidate } from './package.js'
import { formatReviewReport } from './format.js'
import {
  bindResolutionToDigest,
  inheritedOpenBlockers,
  lineageUnavailableFinding,
  resolveCarriedFindings,
  resolveHostParent,
} from './lineage.js'
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

export interface ReviewServiceOptions {
  readonly restore?: readonly ReviewReport[]
  readonly persist?: (reports: readonly ReviewReport[]) => void
  /** When true, inherited blockers come only from host reports, never caller priorFindings. */
  readonly hostLineage?: boolean
  /** Durable lineage was expected but missing or corrupt. */
  readonly lineageUnavailable?: boolean
}

export class ReviewService implements IndependentReview {
  private readonly byCandidate = new Map<string, ReviewReport>()
  private readonly byDigest = new Map<string, ReviewReport>()

  constructor(
    private readonly semantic: ReviewerProvider = new PolicyReviewerProvider(),
    private readonly loadCandidate?: (id: string) => CandidateRecord,
    private readonly options: ReviewServiceOptions = {},
  ) {
    for (const report of options.restore ?? []) this.remember(report)
  }

  review(pkg: ReviewPackage): ReviewReport {
    if (this.options.lineageUnavailable) {
      return this.finish(pkg, [lineageUnavailableFinding(pkg.candidate.digest)], false)
    }
    const policy = { version: pkg.policyVersion, riskClass: pkg.riskClass }
    const prechecks = deterministicPrechecks(pkg)
    const semantic = this.semantic.semanticReview(pkg, policy)
    const current = bindResolutionToDigest(dedupe([...prechecks, ...semantic]), pkg)
    const parent = resolveHostParent(pkg, {
      previousForCandidate: (id) => this.byCandidate.get(id),
      reportForDigest: (digest) => this.byDigest.get(digest),
    })
    const inherited = inheritedOpenBlockers(parent.report, pkg.priorFindings, this.options.hostLineage !== true)
    const omissions = lineageOmissions(inherited, pkg.priorFindings, pkg.candidate.digest)
    const carried = resolveCarriedFindings(inherited, current, pkg)
    const findings = dedupe([
      ...current,
      ...carried,
      ...omissions,
      ...(parent.invalidParent ? [parent.invalidParent] : []),
    ])
    return this.finish(pkg, findings, true)
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

  private finish(pkg: ReviewPackage, findings: readonly ReviewFinding[], persist: boolean): ReviewReport {
    const report: ReviewReport = {
      candidateId: pkg.candidate.id,
      digest: pkg.candidate.digest,
      policyVersion: REVIEW_POLICY_VERSION,
      riskClass: pkg.riskClass,
      state: reportState(findings),
      findings,
      approvalStatus: 'NOT APPROVED',
      summary: '',
    }
    const withSummary = { ...report, summary: formatReviewReport(report) }
    if (persist) {
      this.remember(withSummary)
      this.options.persist?.([...this.byDigest.values()])
    }
    return withSummary
  }

  private remember(report: ReviewReport): void {
    this.byCandidate.set(report.candidateId, report)
    if (report.digest) this.byDigest.set(report.digest, report)
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
