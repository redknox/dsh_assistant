import { Service, type Context } from '@deepseek-ai/cordis'
import {
  PolicyReviewerProvider,
  ReviewService,
  type IndependentReview,
  type ReviewPackage,
  type ReviewPackageExtras,
  type ReviewerProvider,
} from '../domain/review/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    independentReview: IndependentReview
  }
}

export class IndependentReviewService extends Service implements IndependentReview {
  constructor(ctx: Context, private readonly inner: IndependentReview) {
    super(ctx, 'independentReview')
  }

  review(pkg: ReviewPackage) { return this.inner.review(pkg) }
  reviewCandidate(id: string, extras?: ReviewPackageExtras) { return this.inner.reviewCandidate(id, extras) }
  status(candidate: { readonly id: string; readonly digest?: string }) { return this.inner.status(candidate) }
  lastReport(candidateId: string) { return this.inner.lastReport(candidateId) }
}

export interface ReviewPluginConfig {
  readonly provider?: ReviewerProvider
  readonly restore?: readonly import('../domain/review/types.js').ReviewReport[]
  readonly persist?: (reports: readonly import('../domain/review/types.js').ReviewReport[]) => void
  readonly hostLineage?: boolean
  readonly lineageUnavailable?: boolean
}

export const name = 'dsh-assistant-review'
export const inject = ['candidateWorkspace']

/** Host-managed independent review. Never approves, installs, or activates. */
export async function apply(ctx: Context, config: ReviewPluginConfig = {}) {
  const service = new ReviewService(
    config.provider ?? new PolicyReviewerProvider(),
    (id) => ctx.candidateWorkspace.get(id),
    {
      restore: config.restore,
      persist: config.persist,
      hostLineage: config.hostLineage,
      lineageUnavailable: config.lineageUnavailable,
    },
  )
  await ctx.plugin(class extends IndependentReviewService {
    constructor(scope: Context) {
      super(scope, service)
    }
  })
}
