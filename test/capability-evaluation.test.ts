import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  CAPABILITY_EVALUATION_RUNNER,
  CAPABILITY_EVALUATION_SUITE_STAMP,
  CapabilityEvaluationHarness,
} from '../src/domain/evaluation/index.js'
import { CandidateService } from '../src/domain/candidate/index.js'
import { InMemoryRegistryPersistence, RegistryService, bootstrapCoreInventory } from '../src/domain/registry/index.js'
import { defineCapabilitySpecification, reviseCapabilitySpecification } from '../src/domain/workbench/capability-specification.js'

describe('Capability Specification conversation origin', () => {
  it('preserves the originating conversation across immutable revisions', () => {
    const first = defineCapabilitySpecification('spec-1', {
      capability: 'text.echo',
      goal: 'Echo text.',
      businessRules: ['Preserve text.'],
      acceptanceExamples: [{ name: 'echo', given: [], when: 'called', then: ['same text'] }],
      origin: { sessionId: 'conversation-product-ui' },
    })

    const revised = reviseCapabilitySpecification('spec-2', first, { goal: 'Echo text exactly.' })

    assert.deepEqual(first.origin, { sessionId: 'conversation-product-ui' })
    assert.deepEqual(revised.origin, first.origin)
  })
})

describe('Capability Evaluation Harness', () => {
  it('prepares digest-bound executable fixtures from business acceptance examples', () => {
    const specification = expenseSpecification()
    const prepared = new CapabilityEvaluationHarness().prepare(specification)
    const suite = JSON.parse(prepared[CAPABILITY_EVALUATION_SUITE_STAMP] ?? '') as {
      specificationId: string
      specificationDigest: string
      cases: readonly { name: string; input: unknown; expected: unknown }[]
    }
    assert.equal(suite.specificationId, specification.id)
    assert.equal(suite.specificationDigest, specification.digest)
    assert.equal(suite.cases.length, 3)
    assert.deepEqual(suite.cases[1]?.expected, { decision: 'review', reasons: ['amount-over-limit'] })
    assert.match(prepared[CAPABILITY_EVALUATION_RUNNER] ?? '', /TARS_NG_CAPABILITY_EVALUATION/)
  })

  it('rejects partial or non-JSON Evaluation Fixtures at the specification seam', () => {
    assert.throws(() => defineCapabilitySpecification('spec-1', {
      capability: 'expense.risk.review',
      goal: 'Review one expense claim.',
      businessRules: ['Claims over 1000 require review.'],
      acceptanceExamples: [{
        name: 'partial fixture',
        given: ['A claim exists.'],
        when: 'The claim is reviewed.',
        then: ['A decision is returned.'],
        fixture: { input: { amount: 10 } } as never,
      }],
    }), /fixture.*input.*expected/i)
    assert.throws(() => defineCapabilitySpecification('spec-1', {
      capability: 'expense.risk.review',
      goal: 'Review one expense claim.',
      businessRules: ['Claims over 1000 require review.'],
      acceptanceExamples: [{
        name: 'invalid fixture',
        given: ['A claim exists.'],
        when: 'The claim is reviewed.',
        then: ['A decision is returned.'],
        fixture: { input: { amount: Number.NaN }, expected: { decision: 'clear' } },
      }],
    }), /JSON/i)
  })

  it('executes an expense-risk candidate in isolation and returns case-level evidence', () => {
    const root = candidateRoot(expensePlugin())
    const harness = new CapabilityEvaluationHarness()
    for (const [relative, content] of Object.entries(harness.prepare(expenseSpecification()))) {
      write(root, relative, content)
    }
    const report = harness.evaluate({ candidateId: 'generated--expense-risk@0.1.0', workspaceRoot: root })
    assert.equal(report.status, 'passed', JSON.stringify(report))
    assert.equal(report.executed, 3)
    assert.equal(report.cases.every((item) => item.status === 'passed'), true)
  })

  it('returns the expected and actual business output when a fixture fails', () => {
    const root = candidateRoot(expensePlugin(true))
    const harness = new CapabilityEvaluationHarness()
    for (const [relative, content] of Object.entries(harness.prepare(expenseSpecification()))) {
      write(root, relative, content)
    }
    const report = harness.evaluate({ candidateId: 'generated--expense-risk@0.1.0', workspaceRoot: root })
    assert.equal(report.status, 'failed')
    const failed = report.cases.find((item) => item.status === 'failed')
    assert.equal(failed?.name, 'over limit')
    assert.deepEqual(failed?.expected, { decision: 'review', reasons: ['amount-over-limit'] })
    assert.deepEqual(failed?.actual, { decision: 'clear', reasons: [] })
  })

  it('binds the business report into ordinary Candidate Validation evidence', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tars-ng-evaluation-candidate-'))
    const registry = new RegistryService(new InMemoryRegistryPersistence())
    bootstrapCoreInventory((input) => registry.register(input))
    const workspace = new CandidateService(registry, root)
    const prepared = new CapabilityEvaluationHarness().prepare(expenseSpecification())
    const candidate = workspace.create({
      review: {
        kind: 'new-plugin',
        capability: 'expense.risk.review',
        need: 'Recommend manual review without authoritative approval.',
        recommendation: 'Create a bounded pure decision capability.',
        rationale: 'No active owner exists.',
        implications: [], assumptions: [], unresolved: [], steps: [],
        registryFacts: { exact: { kind: 'unknown', capability: 'expense.risk.review' }, domainOwners: [], conflicts: [] },
      },
      owner: 'generated/expense-risk',
      version: '0.1.0',
      manifest: {
        capabilities: ['expense.risk.review'],
        tools: ['expense_risk_review'],
        entryPoints: ['src/plugin.js'],
        runtimeContractVersion: 'generated-extension-api/v1',
      },
      files: { 'src/plugin.js': expensePlugin(), ...prepared },
    })
    const validation = workspace.validate(candidate.id)
    assert.equal(validation.evaluation?.status, 'passed', JSON.stringify(validation.evaluation))
    assert.equal(validation.stages.find((item) => item.name === 'business.acceptance')?.status, 'passed')
  })
})

function expenseSpecification() {
  return defineCapabilitySpecification('spec-1', {
    capability: 'expense.risk.review',
    goal: 'Recommend whether one reimbursement claim needs manual review.',
    nonGoals: ['Do not approve, reject, post, or pay a claim.'],
    inputs: [
      { name: 'amount', description: 'Claim amount in CNY.', required: true },
      { name: 'hasReceipt', description: 'Whether receipt evidence is present.', required: true },
    ],
    businessRules: [
      'Claims over 1000 require manual review.',
      'Claims without receipt evidence require manual review.',
    ],
    acceptanceExamples: [
      {
        name: 'ordinary claim',
        given: ['Amount is 500 CNY.', 'Receipt evidence is present.'],
        when: 'The claim is reviewed.',
        then: ['The recommendation is clear.'],
        fixture: { input: { amount: 500, hasReceipt: true }, expected: { decision: 'clear', reasons: [] } },
      },
      {
        name: 'over limit',
        given: ['Amount is 1200 CNY.', 'Receipt evidence is present.'],
        when: 'The claim is reviewed.',
        then: ['Manual review is recommended for amount-over-limit.'],
        fixture: { input: { amount: 1200, hasReceipt: true }, expected: { decision: 'review', reasons: ['amount-over-limit'] } },
      },
      {
        name: 'missing evidence',
        given: ['Amount is 300 CNY.', 'Receipt evidence is missing.'],
        when: 'The claim is reviewed.',
        then: ['Manual review is recommended for missing-receipt.'],
        fixture: { input: { amount: 300, hasReceipt: false }, expected: { decision: 'review', reasons: ['missing-receipt'] } },
      },
    ],
  })
}

function candidateRoot(source: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tars-ng-evaluation-'))
  write(root, 'candidate.manifest.json', `${JSON.stringify({
    entryPoints: ['src/plugin.js'],
    tools: ['expense_risk_review'],
  }, null, 2)}\n`)
  write(root, 'src/plugin.js', source)
  return root
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function expensePlugin(wrongOverLimit = false): string {
  return `export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'expense_risk_review',
    async execute(args) {
      const reasons = []
      if (Number(args.amount) > 1000${wrongOverLimit ? ' && false' : ''}) reasons.push('amount-over-limit')
      if (args.hasReceipt !== true) reasons.push('missing-receipt')
      return { decision: reasons.length ? 'review' : 'clear', reasons }
    },
  })
  ctx.effect(() => dispose)
}
`
}
