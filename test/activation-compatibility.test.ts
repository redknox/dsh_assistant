import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  ACTIVATION_COMPATIBILITY_REASONS,
  evaluateActivationCompatibility,
  HOST_OWNED_IRREPLACEABLE_OWNERS,
} from '../src/domain/activation-compatibility/index.js'
import type { ResolutionReview } from '../src/domain/resolution/index.js'
import { productHomeLayout } from '../src/product/home.js'
import { bootAssistantControl } from '../src/runtime/boot.js'

function review(kind: ResolutionReview['kind'], capability: string, owner?: string): ResolutionReview {
  return {
    kind,
    capability,
    need: 'activation compatibility',
    recommendation: kind,
    rationale: 'test',
    implications: [],
    assumptions: [],
    unresolved: [],
    steps: [],
    registryFacts: { exact: { kind: 'unknown', capability }, domainOwners: [], conflicts: [] },
    ...(owner === undefined ? {} : { target: { owner, version: '0.1.0' } }),
  }
}

const TOOL = `export function apply(ctx) {
  ctx.tools.register({
    name: 'probe_tool',
    parameters: {},
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute() { return 'ok' },
  })
}
`

async function materialize(ctx: Awaited<ReturnType<typeof bootAssistantControl>>['ctx'], input: {
  readonly owner: string
  readonly version?: string
  readonly capability: string
  readonly kind?: ResolutionReview['kind']
  readonly services?: readonly string[]
  readonly providers?: readonly string[]
  readonly origin?: 'assistant' | 'human'
  readonly provenanceKind?: 'managed' | 'generated'
}) {
  const created = ctx.candidateWorkspace.create({
    review: review(input.kind ?? 'evolve-owner', input.capability, input.kind === 'new-plugin' ? undefined : input.owner),
    owner: input.owner,
    version: input.version ?? '0.1.1',
    provenance: {
      kind: input.provenanceKind ?? (input.owner.startsWith('generated/') ? 'generated' : 'managed'),
      origin: input.origin ?? 'assistant',
    },
    manifest: {
      capabilities: [input.capability],
      tools: ['probe_tool'],
      services: [...(input.services ?? [])],
      providers: [...(input.providers ?? [])],
      entryPoints: ['src/plugin.js'],
    },
  })
  ctx.candidateWorkspace.writeFile(created.id, 'package.json', `${JSON.stringify({ name: 'probe', type: 'module', main: 'src/plugin.js' })}\n`)
  ctx.candidateWorkspace.writeFile(created.id, 'src/plugin.js', TOOL)
  const report = ctx.candidateValidation.validate(created.id)
  const sealed = ctx.candidateWorkspace.seal(created.id)
  ctx.independentReview.reviewCandidate(sealed.id)
  return { created, sealed, report }
}

describe('activation compatibility', () => {
  it('classifies isolated services as structurally ineligible', () => {
    const result = evaluateActivationCompatibility({
      owner: 'generated/text-slugify',
      provenanceKind: 'generated',
      origin: 'assistant',
      services: ['assistantControl'],
    })
    assert.equal(result.ok, false)
    assert.ok(result.denials.some((item) => item.reason === ACTIVATION_COMPATIBILITY_REASONS.isolatedServices))
  })

  it('rejects tool-only evolve of every host-owned irreplaceable owner before approval', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl({ home: mkdtempSync(path.join(tmpdir(), 'tars-compat-')) })
    try {
      assert.ok(HOST_OWNED_IRREPLACEABLE_OWNERS.has('managed/ui-control-surface'))
      for (const owner of HOST_OWNED_IRREPLACEABLE_OWNERS) {
        const capability = owner.includes('ui')
          ? 'ui.markdown'
          : owner.includes('memory')
            ? 'memory.export'
            : owner.includes('jobs')
              ? 'jobs.schedule'
              : owner.includes('trust')
                ? 'policy.audit'
                : owner.includes('knowledge')
                  ? 'knowledge.export'
                  : 'calendar.freebusy'
        const { sealed, report } = await materialize(ctx, { owner, capability })
        assert.equal(report.passed, false, owner)
        assert.ok(report.stages.some((item) => item.name === 'activation.compatibility' && item.status === 'failed'), owner)
        const eligibility = ctx.extensionGovernance.requestEligibility(sealed.id)
        assert.equal(eligibility.ok, false, owner)
        assert.ok(eligibility.denials.some((item) => (
          item.reason === ACTIVATION_COMPATIBILITY_REASONS.hostOwnedNotReplaceable
          || item.reason === ACTIVATION_COMPATIBILITY_REASONS.hostProductChange
          || item.reason === 'not-validated'
        )), owner)
        assert.throws(() => ctx.extensionGovernance.requestApproval(sealed.id))
        const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
        await assert.rejects(() => recoveryRoot.activate(sealed.id, human))
        assert.equal(ctx.candidateWorkspace.get(sealed.id).sealed, true)
        assert.equal(ctx.candidateWorkspace.get(sealed.id).digest, sealed.digest)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a legal independent generated tool activatable', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl({ home: mkdtempSync(path.join(tmpdir(), 'tars-slug-')) })
    try {
      const { sealed, report } = await materialize(ctx, {
        owner: 'generated/text-slugify',
        version: '0.1.0',
        capability: 'text.slugify',
        kind: 'new-plugin',
      })
      assert.equal(report.passed, true, report.stages.filter((item) => item.status === 'failed').map((item) => item.summary).join('; '))
      const requested = ctx.extensionGovernance.requestApproval(sealed.id)
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
      recoveryRoot.recordApproval(human, {
        candidateId: sealed.id,
        fingerprint: requested.fingerprint,
        decision: 'approved-for-exact-diff',
      })
      const status = await recoveryRoot.activate(sealed.id, human)
      assert.equal(status.state, 'active', status.lastFailure?.diagnostics)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('writes a bounded activation diagnostic to the product log without leaking paths', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'tars-compat-log-'))
    const { ctx, recoveryRoot } = await bootAssistantControl({ home })
    try {
      const { sealed } = await materialize(ctx, {
        owner: 'managed/ui-control-surface',
        capability: 'ui.markdown',
        services: ['assistantControl'],
      })
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
      await assert.rejects(() => recoveryRoot.activate(sealed.id, human))
      const log = readFileSync(productHomeLayout(home).logFile, 'utf8')
      assert.match(log, /activation-denied|activation-failed/)
      assert.match(log, /managed--ui-control-surface@0\.1\.1|host-owned-owner-not-replaceable|isolated-runtime-forbids-services/)
      assert.doesNotMatch(log, /\/Users\//)
      assert.doesNotMatch(log, /api[_-]?key|token=|secret=/i)
      writeFileSync(path.join(sealed.workspaceRoot, 'src/plugin.js'), `${TOOL}\n// leftover\n`)
      assert.equal(ctx.candidateWorkspace.get(sealed.id).digest, sealed.digest)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
