import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CandidateService } from '../src/domain/candidate/index.js'
import {
  finding,
  hiddenReviewKeys,
  PermissiveReviewerProvider,
  PolicyReviewerProvider,
  REVIEW_POLICY_VERSION,
  ReviewService,
  reviewPackageFromCandidate,
  type ReviewPackage,
} from '../src/domain/review/index.js'
import { googleCalendarWriteRiskModel } from '../src/domain/reliability/index.js'
import {
  InMemoryRegistryPersistence,
  RegistryService,
  bootstrapCoreInventory,
} from '../src/domain/registry/index.js'
import type { ResolutionReview } from '../src/domain/resolution/index.js'
import * as candidatePlugin from '../src/plugins/candidate-plugin.js'
import * as registryPlugin from '../src/plugins/registry-plugin.js'
import * as reviewPlugin from '../src/plugins/review-plugin.js'
import { DurableReviewLineage, PersistenceIntegrityError, selfExtensionPaths } from '../src/domain/self-extension/index.js'
import { bootAssistantControl } from '../src/runtime/boot.js'

function resolution(overrides: Partial<ResolutionReview> = {}): ResolutionReview {
  return {
    kind: 'new-plugin',
    capability: 'v02.probe.ping',
    need: 'probe',
    recommendation: 'new plugin',
    rationale: 'gap',
    implications: [],
    assumptions: [],
    unresolved: [],
    steps: [],
    registryFacts: { exact: { kind: 'unknown', capability: 'v02.probe.ping' }, domainOwners: [], conflicts: [] },
    ...overrides,
  }
}

function workspace() {
  const registry = new RegistryService(new InMemoryRegistryPersistence())
  bootstrapCoreInventory((input) => registry.register(input))
  return new CandidateService(registry, mkdtempSync(path.join(tmpdir(), 'dsh-rev-')))
}

function pkg(overrides: Partial<ReviewPackage> & { digest?: string; id?: string; parentRevision?: string } = {}): ReviewPackage {
  const { digest, id, parentRevision, candidate, ...rest } = overrides
  return {
    policyVersion: REVIEW_POLICY_VERSION,
    candidate: candidate ?? {
      id: id ?? 'generated-example-0.1.0',
      owner: 'generated/example',
      version: '0.1.0',
      digest: digest ?? 'digest-a',
      sealed: true,
      parentRevision,
    },
    riskClass: 'R0',
    validationPassed: true,
    validationStages: [{ name: 'reliability.gate', status: 'passed' }],
    reliabilityPassed: true,
    generated: true,
    priorFindings: [],
    ...rest,
  }
}

function r3(overrides: Partial<ReviewPackage> & { digest?: string; id?: string; parentRevision?: string } = {}): ReviewPackage {
  const model = googleCalendarWriteRiskModel()
  return pkg({
    riskClass: 'R3',
    riskModel: model,
    reliabilityDerivedClass: 'R3',
    contractKind: model.idempotency.contractKind,
    idempotencyStrategy: model.idempotency.strategy,
    cancelledContextReuse: model.reconciliation.cancelledContextReuse,
    independentReconciliation: model.reconciliation.independentContext,
    ...overrides,
  })
}

function trustFinding(digest: string, status: 'open' | 'resolved') {
  return finding({
    reviewedDigest: digest,
    severity: 'BLOCKER',
    category: 'trust-boundary',
    claim: 'forged-discovery-trust',
    location: 'discovery.provenance',
    evidence: status === 'resolved'
      ? `Trust is host-stamped on ${digest}.`
      : 'Trust stamp can be self-asserted from candidate metadata.',
    whyItMatters: 'A trust boundary must come from the host provider, not raw metadata.',
    requiredRemediation: 'Stamp trust from the discovery provider.',
    status,
  })
}

describe('independent review', () => {
  it('A. ignores builder self-certification as authority', () => {
    const service = new ReviewService()
    const failed = service.review(pkg({
      validationPassed: false,
      builderClaims: { reviewPassed: true, reviewComplete: true },
    }))
    assert.equal(failed.state, 'changes-required')
    assert.equal(failed.approvalStatus, 'NOT APPROVED')
    assert.ok(failed.findings.some((item) => item.claim === 'builder-claimed-review-success'))
    assert.ok(failed.findings.some((item) => item.claim === 'validation-not-passed' && item.status === 'open'))

    const passed = service.review(pkg({
      id: 'generated-example-ok',
      digest: 'digest-ok',
      builderClaims: { reviewPassed: true },
    }))
    assert.equal(passed.state, 'review-complete')
    assert.equal(passed.approvalStatus, 'NOT APPROVED')
    assert.match(passed.summary, /NOT APPROVED/)
  })

  it('B. binds review to an exact digest and goes stale on change', () => {
    const store = workspace()
    const created = store.create({
      review: resolution(),
      owner: 'generated/v02-probe',
      version: '0.1.0',
      manifest: { capabilities: ['v02.probe.ping'] },
    })
    store.validate(created.id)
    const sealed = store.seal(created.id)
    const service = new ReviewService(new PolicyReviewerProvider(), (id) => store.get(id))
    const report = service.reviewCandidate(sealed.id)
    assert.equal(report.state, 'review-complete')
    assert.equal(report.digest, sealed.digest)
    assert.equal(service.status({ id: sealed.id, digest: sealed.digest }), 'review-complete')
    assert.equal(service.status({ id: sealed.id, digest: `${sealed.digest}-mutated` }), 'stale')
  })

  it('C. keeps review-complete blocked while a BLOCKER is open', () => {
    const report = new ReviewService().review(r3({ cancelledContextReuse: true }))
    assert.equal(report.state, 'changes-required')
    assert.ok(report.findings.some((item) => item.claim === 'cancelled-context-reuse' && item.blocking && item.status === 'open'))
    assert.match(report.summary, /CHANGES REQUIRED/)
    assert.match(report.summary, /NOT APPROVED/)
  })

  it('D. repair creates a new revision that the old review cannot certify', () => {
    const service = new ReviewService()
    const first = service.review(r3({
      id: 'generated-calendar-0.2.0',
      digest: 'rev-a',
      cancelledContextReuse: true,
    }))
    assert.equal(first.state, 'changes-required')
    assert.equal(service.status({ id: 'generated-calendar-0.2.0', digest: 'rev-b' }), 'stale')
    const second = service.review(r3({
      id: 'generated-calendar-0.2.0',
      digest: 'rev-b',
      parentRevision: 'rev-a',
      cancelledContextReuse: false,
      priorFindings: first.findings.filter((item) => item.blocking),
    }))
    assert.equal(second.digest, 'rev-b')
    assert.notEqual(second.digest, first.digest)
    assert.equal(second.state, 'review-complete')
    assert.ok(second.findings.some((item) => item.claim === 'cancelled-context-reuse' && item.status === 'resolved'))
    assert.match(second.findings.find((item) => item.claim === 'cancelled-context-reuse')?.evidence ?? '', /Host check/)
    assert.equal(service.status({ id: 'generated-calendar-0.2.0', digest: 'rev-a' }), 'stale')
    assert.equal(second.approvalStatus, 'NOT APPROVED')
  })

  it('E. re-reviews current artifacts, not Builder text that claims a fix', () => {
    const service = new ReviewService()
    const first = service.review(r3({ digest: 'rev-a', cancelledContextReuse: true }))
    const second = service.review(r3({
      digest: 'rev-b',
      parentRevision: 'rev-a',
      cancelledContextReuse: true,
      priorFindings: first.findings.filter((item) => item.blocking),
      builderClaims: { findingFixed: true, cancelledContextReuse: false },
    }))
    assert.equal(second.state, 'changes-required')
    const open = second.findings.find((item) => item.claim === 'cancelled-context-reuse')
    assert.equal(open?.status, 'open')
    assert.equal(open?.reviewedDigest, 'rev-b')
  })

  it('F. cannot waive a failed Reliability Gate', () => {
    const report = new ReviewService(new PermissiveReviewerProvider()).review(r3({
      reliabilityPassed: false,
      builderClaims: { looksFine: true },
    }))
    assert.equal(report.state, 'changes-required')
    assert.ok(report.findings.some((item) => item.claim === 'reliability-gate-not-passed' && item.status === 'open'))
  })

  it('G. cannot reviewer-approve generated R4 control-plane escalation', () => {
    const report = new ReviewService(new PermissiveReviewerProvider()).review(pkg({
      riskClass: 'R4',
      reliabilityDerivedClass: 'R4',
      reliabilityPassed: true,
      validationPassed: true,
    }))
    assert.equal(report.state, 'changes-required')
    assert.ok(report.findings.some((item) => item.claim === 'generated-r4' && item.status === 'open'))
  })

  it('H. review package is explicit artifacts only', () => {
    const input = r3()
    assert.deepEqual(hiddenReviewKeys(input), [])
    assert.equal('chainOfThought' in input, false)
    assert.equal('builderScratch' in input, false)
    assert.equal('hiddenState' in input, false)
  })

  it('I. allows the same reviewer implementation with a fresh sealed package', () => {
    const provider = new PolicyReviewerProvider()
    const service = new ReviewService(provider)
    const first = service.review(pkg({ id: 'one', digest: 'd1' }))
    const second = service.review(pkg({ id: 'two', digest: 'd2' }))
    assert.equal(first.state, 'review-complete')
    assert.equal(second.state, 'review-complete')
    assert.notEqual(first.digest, second.digest)
  })

  it('J. review-complete does not activate or approve', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl()
    try {
      const created = ctx.candidateWorkspace.create({
        review: resolution({
          kind: 'evolve-owner',
          capability: 'calendar.read',
          need: 'filter',
          target: { owner: 'managed/integrations', version: '0.1.0' },
        }),
        owner: 'managed/integrations',
        version: '0.2.0',
        baseVersion: '0.1.0',
        manifest: {
          capabilities: ['calendar.read', 'calendar.freebusy'],
          permissions: ['local.fake.suite'],
        },
      })
      ctx.candidateWorkspace.writeFile(created.id, 'src/ok.ts', 'export const value: string = "ok"\n')
      ctx.candidateValidation.validate(created.id)
      const sealed = ctx.candidateWorkspace.seal(created.id)
      const before = ctx.capabilityRegistry.get('managed/integrations', '0.1.0')
      const report = ctx.independentReview.reviewCandidate(sealed.id)
      assert.equal(report.state, 'review-complete')
      assert.equal(report.approvalStatus, 'NOT APPROVED')
      assert.deepEqual(ctx.capabilityRegistry.get('managed/integrations', '0.1.0'), before)
      assert.equal(ctx.capabilityRegistry.get('managed/integrations', '0.2.0'), undefined)
      assert.equal(ctx.extensionActivation.status().state, 'idle')
      assert.ok(ctx.extensionGovernance.eligibility(sealed.id).denials.some((item) => item.reason === 'approval-required'))
      assert.equal('issueAuthority' in ctx.independentReview, false)
      assert.equal(recoveryRoot.activation().status().state, 'idle')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('K. previous BLOCKER cannot disappear by omission', () => {
    const service = new ReviewService()
    const first = service.review(r3({ digest: 'rev-a', cancelledContextReuse: true }))
    const second = service.review(r3({
      id: 'generated-example-0.2.0',
      digest: 'rev-b',
      parentRevision: 'rev-a',
      cancelledContextReuse: false,
      priorFindings: [],
    }))
    assert.equal(second.state, 'changes-required')
    assert.ok(second.findings.some((item) => item.category === 'lineage' && item.claim.startsWith('omitted-blocker:')))
    assert.ok(first.findings.some((item) => item.claim === 'cancelled-context-reuse'))
  })

  it('L. re-review may emit new findings after the original blocker is fixed', () => {
    const provider = new PolicyReviewerProvider((input) => {
      if (input.candidate.digest !== 'rev-b') return []
      return [finding({
        reviewedDigest: input.candidate.digest,
        severity: 'BLOCKER',
        category: 'trust-boundary',
        claim: 'forged-discovery-trust',
        location: 'discovery.provenance',
        evidence: 'Trust stamp can be self-asserted from candidate metadata.',
        whyItMatters: 'A trust boundary must come from the host provider, not raw metadata.',
        requiredRemediation: 'Stamp trust from the discovery provider.',
        status: 'open',
      })]
    })
    const service = new ReviewService(provider)
    const first = service.review(r3({ digest: 'rev-a', cancelledContextReuse: true }))
    const second = service.review(r3({
      digest: 'rev-b',
      parentRevision: 'rev-a',
      cancelledContextReuse: false,
      priorFindings: first.findings.filter((item) => item.blocking),
    }))
    assert.equal(second.state, 'changes-required')
    assert.ok(second.findings.some((item) => item.claim === 'cancelled-context-reuse' && item.status === 'resolved'))
    assert.match(second.findings.find((item) => item.claim === 'cancelled-context-reuse')?.evidence ?? '', /Host check/)
    assert.ok(second.findings.some((item) => item.claim === 'forged-discovery-trust' && item.status === 'open'))
  })

  it('does not treat a permissive reviewer silence as BLOCKER resolution', () => {
    const prior = trustFinding('rev-a', 'open')
    const report = new ReviewService(new PermissiveReviewerProvider()).review(r3({
      digest: 'rev-b',
      priorFindings: [prior],
    }))
    assert.equal(report.state, 'changes-required')
    const carried = report.findings.find((item) => item.claim === 'forged-discovery-trust')
    assert.equal(carried?.status, 'open')
    assert.equal(carried?.reviewedDigest, 'rev-b')
  })

  it('resolves a prior BLOCKER only with evidence bound to the current digest', () => {
    const provider = new PolicyReviewerProvider((input) => [
      trustFinding(input.candidate.digest, input.candidate.digest === 'rev-b' ? 'resolved' : 'open'),
    ])
    const service = new ReviewService(provider)
    const first = service.review(r3({ digest: 'rev-a' }))
    assert.equal(first.state, 'changes-required')
    const second = service.review(r3({
      digest: 'rev-b',
      parentRevision: 'rev-a',
      priorFindings: first.findings.filter((item) => item.blocking),
    }))
    const resolved = second.findings.find((item) => item.claim === 'forged-discovery-trust')
    assert.equal(resolved?.status, 'resolved')
    assert.equal(resolved?.reviewedDigest, 'rev-b')
    assert.equal(second.state, 'review-complete')
  })

  it('rejects stale resolution evidence on a newer revision', () => {
    const provider = new PolicyReviewerProvider((input) => {
      if (input.candidate.digest === 'rev-a') return [trustFinding('rev-a', 'open')]
      return [trustFinding('rev-a', 'resolved')]
    })
    const service = new ReviewService(provider)
    const first = service.review(r3({ digest: 'rev-a' }))
    const second = service.review(r3({
      digest: 'rev-c',
      parentRevision: 'rev-a',
      priorFindings: first.findings.filter((item) => item.blocking),
    }))
    assert.equal(second.state, 'changes-required')
    const item = second.findings.find((entry) => entry.claim === 'forged-discovery-trust')
    assert.equal(item?.status, 'open')
    assert.equal(item?.reviewedDigest, 'rev-c')
    assert.match(item?.evidence ?? '', /Stale resolution/)
  })

  it('does not let caller-controlled priorFindings rewrite an inherited BLOCKER to resolved', () => {
    const provider = new PolicyReviewerProvider((input) => (
      input.candidate.digest === 'rev-a' ? [trustFinding('rev-a', 'open')] : []
    ))
    const service = new ReviewService(provider)
    const first = service.review(r3({ digest: 'rev-a' }))
    const inherited = first.findings.find((item) => item.claim === 'forged-discovery-trust')
    assert.equal(inherited?.status, 'open')
    const second = service.review(r3({
      digest: 'rev-b',
      parentRevision: 'rev-a',
      priorFindings: inherited ? [{ ...inherited, status: 'resolved' }] : [],
    }))
    assert.equal(second.state, 'changes-required')
    const carried = second.findings.find((item) => item.claim === 'forged-discovery-trust')
    assert.equal(carried?.status, 'open')
    assert.equal(carried?.reviewedDigest, 'rev-b')
  })

  it('does not let a fake parentRevision drop inherited BLOCKERs', () => {
    const provider = new PolicyReviewerProvider((input) => (
      input.candidate.digest === 'rev-a' ? [trustFinding('rev-a', 'open')] : []
    ))
    const service = new ReviewService(provider)
    const first = service.review(r3({ digest: 'rev-a' }))
    assert.equal(first.state, 'changes-required')
    const second = service.review(r3({
      digest: 'rev-b',
      parentRevision: 'not-a-real-digest',
      priorFindings: [],
    }))
    assert.equal(second.state, 'changes-required')
    assert.ok(second.findings.some((item) => item.claim === 'forged-discovery-trust' && item.status === 'open'))
    assert.ok(second.findings.some((item) => item.claim === 'invalid-parent-revision' && item.status === 'open'))
  })

  it('M. review depth follows risk class', () => {
    const service = new ReviewService()
    const light = service.review(pkg())
    const heavy = service.review(r3({ cancelledContextReuse: true }))
    assert.ok(light.findings.some((item) => item.claim === 'lightweight-r0-review'))
    assert.equal(light.findings.some((item) => item.claim === 'r3-adversarial-policy-applied'), false)
    assert.equal(light.findings.some((item) => item.category === 'retry-idempotency' && item.status === 'open'), false)
    assert.ok(heavy.findings.some((item) => item.claim === 'r3-adversarial-policy-applied'))
    assert.ok(heavy.findings.some((item) => item.claim === 'cancelled-context-reuse'))
  })

  it('N. reviews Calendar R3 using M3 risk-model artifacts', () => {
    const model = googleCalendarWriteRiskModel()
    const report = new ReviewService().review(r3())
    assert.equal(report.riskClass, 'R3')
    assert.equal(report.state, 'review-complete')
    assert.equal(model.idempotency.contractKind, 'real-provider-contract')
    assert.equal(model.reconciliation.cancelledContextReuse, false)
    assert.equal(model.reconciliation.independentContext, true)
    assert.match(report.summary, /Review: COMPLETE/)
    assert.match(report.summary, /Approval status: NOT APPROVED/)
  })

  it('strips candidate-controlled reviewPassed when building a host package', () => {
    const store = workspace()
    const created = store.create({
      review: resolution(),
      owner: 'generated/v02-probe',
      version: '0.1.0',
      manifest: { capabilities: ['v02.probe.ping'] },
    })
    store.validate(created.id)
    const sealed = store.seal(created.id)
    const forged = {
      ...sealed,
      manifest: { ...sealed.manifest, reviewPassed: true },
    }
    const built = reviewPackageFromCandidate(forged)
    const report = new ReviewService().review(built)
    assert.equal(built.builderClaims?.reviewPassed, true)
    assert.equal(report.state, 'review-complete')
    assert.equal(report.approvalStatus, 'NOT APPROVED')
  })

  it('recovers inherited BLOCKERs after recreating the service from durable lineage', () => {
    const home = selfExtensionPaths(mkdtempSync(path.join(tmpdir(), 'dsh-rev-lineage-')))
    const provider = new PolicyReviewerProvider((input) => (
      input.candidate.digest === 'rev-a' ? [trustFinding('rev-a', 'open')] : []
    ))
    const firstStore = new DurableReviewLineage(home)
    const first = new ReviewService(provider, undefined, {
      restore: firstStore.restore(),
      persist: (reports) => firstStore.save(reports),
      hostLineage: true,
    })
    const initial = first.review(r3({ digest: 'rev-a' }))
    assert.equal(initial.state, 'changes-required')
    const secondStore = new DurableReviewLineage(home)
    const second = new ReviewService(provider, undefined, {
      restore: secondStore.restore(),
      persist: (reports) => secondStore.save(reports),
      hostLineage: true,
    })
    const report = second.review(r3({ digest: 'rev-b', priorFindings: [] }))
    assert.equal(report.state, 'changes-required')
    assert.ok(report.findings.some((item) => item.claim === 'forged-discovery-trust' && item.status === 'open'))
  })

  it('does not treat caller priorFindings as lineage when host lineage is required', () => {
    const report = new ReviewService(new PermissiveReviewerProvider(), undefined, { hostLineage: true }).review(r3({
      digest: 'rev-b',
      priorFindings: [trustFinding('rev-a', 'open')],
    }))
    assert.equal(report.findings.some((item) => item.claim === 'forged-discovery-trust'), false)
  })

  it('fails closed when durable review lineage is unavailable', () => {
    const report = new ReviewService(undefined, undefined, { lineageUnavailable: true }).review(pkg())
    assert.equal(report.state, 'changes-required')
    assert.ok(report.findings.some((item) => item.claim === 'review-lineage-unavailable'))
  })

  it('fails closed on corrupt durable review lineage', () => {
    const home = selfExtensionPaths(mkdtempSync(path.join(tmpdir(), 'dsh-rev-corrupt-')))
    mkdirSync(home.root, { recursive: true })
    writeFileSync(home.reviewLineagePath, '{not-json')
    assert.throws(() => new DurableReviewLineage(home), PersistenceIntegrityError)
  })
})

describe('independent review plugin', () => {
  it('exposes host review without install or approval authority', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(registryPlugin)
    await ctx.plugin(candidatePlugin, { workspaceRoot: mkdtempSync(path.join(tmpdir(), 'dsh-rev-plug-')) })
    await ctx.plugin(reviewPlugin)
    try {
      assert.ok(ctx.independentReview)
      assert.equal(ctx.independentReview.status({ id: 'missing' }), 'not-reviewed')
      assert.equal('recordApproval' in ctx.independentReview, false)
      assert.equal('activate' in ctx.independentReview, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
