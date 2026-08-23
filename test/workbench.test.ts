import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { CandidateService } from '../src/domain/candidate/index.js'
import {
  WORKBENCH_MAX_FILE_BYTES,
  WORKBENCH_MAX_FILE_COUNT,
  WORKBENCH_MAX_TRAVERSAL_ENTRIES,
  WorkbenchContractError,
  WorkbenchService,
} from '../src/domain/workbench/index.js'
import { RecoveryRoot } from '../src/domain/governance/index.js'
import { InMemoryRegistryPersistence, RegistryService, bootstrapCoreInventory } from '../src/domain/registry/index.js'
import { ResolutionService } from '../src/domain/resolution/index.js'
import { PolicyReviewerProvider, ReviewService, finding } from '../src/domain/review/index.js'
import { projectMissionControl } from '../src/domain/workspace/index.js'
import { bootAssistantControl, bootSafeModeRuntime } from '../src/runtime/boot.js'
import { gatherWorkspaceSnapshot } from '../src/domain/workspace/gather.js'

const R0_SOURCE = `export const name = 'generated-r0-workbench'
export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'r0_workbench_ping',
    description: 'Workbench R0 ping',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) { return String(args.text ?? '').toUpperCase() },
  })
  ctx.effect(() => dispose)
}
`

async function tool(ctx: { tools: { execute(input: unknown): Promise<{ isError: boolean; value?: unknown }> } }, name: string, args: Record<string, unknown> = {}) {
  return ctx.tools.execute({
    callId: CallId(`wb-${name}-${Math.random().toString(16).slice(2)}`),
    name,
    arguments: args,
    signal: AbortSignal.timeout(15000),
  })
}

function parse(result: { isError: boolean; value?: unknown }) {
  assert.equal(result.isError, false, String(result.value))
  return JSON.parse(String(result.value)) as Record<string, unknown>
}

describe('candidate workbench', () => {
  it('A. resolution ownership is host-derived and non-change kinds do not create workspaces', async () => {
    const { ctx } = await bootAssistantControl()
    try {
      const reuse = parse(await tool(ctx, 'plan_capability_change', { capability: 'calendar.read', need: 'see my calendar' }))
      assert.equal(reuse.kind, 'reuse')
      assert.equal(reuse.canCreate, false)
      const created = await tool(ctx, 'create_candidate', { planId: reuse.planId })
      assert.equal(created.isError, true)

      const evolve = ctx.capabilityResolution.review({
        capability: 'calendar.read',
        need: 'richer attendee filtering',
        behavior: 'attendee-filter',
      })
      assert.equal(evolve.kind, 'evolve-owner')
      const plan = ctx.candidateWorkbench.rememberPlan(evolve)
      const candidate = ctx.candidateWorkbench.create({ planId: plan.planId })
      assert.equal(candidate.owner, 'managed/integrations')
      assert.equal(candidate.provenance.origin, 'assistant')
      assert.throws(() => ctx.candidateWorkbench.create({
        planId: plan.planId,
        owner: 'generated/shadow',
      } as never), WorkbenchContractError)

      const incomplete = ctx.capabilityResolution.review({
        capability: 'r0.workbench.unknown',
        need: 'brand new',
      })
      assert.equal(incomplete.kind, 'insufficient-information')
      const blocked = ctx.candidateWorkbench.rememberPlan(incomplete)
      assert.throws(() => ctx.candidateWorkbench.create({ planId: blocked.planId }), /does not create/)

      const fresh = ctx.capabilityResolution.review({
        capability: 'r0.workbench.ping',
        need: 'uppercase text',
        inventory: { complete: true, seams: [] },
      })
      assert.equal(fresh.kind, 'new-plugin')
      const generated = ctx.candidateWorkbench.create({ planId: ctx.candidateWorkbench.rememberPlan(fresh).planId })
      assert.equal(generated.owner, 'generated/r0-workbench-ping')
      assert.equal(generated.provenance.kind, 'generated')
      assert.equal(generated.provenance.origin, 'assistant')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('B. model-like tools stay inside the candidate workspace and reject unsafe writes', async () => {
    const { ctx } = await bootAssistantControl()
    try {
      const plan = ctx.candidateWorkbench.rememberPlan(ctx.capabilityResolution.review({
        capability: 'r0.workbench.ping',
        need: 'uppercase text',
        inventory: { complete: true, seams: [] },
      }))
      const created = parse(await tool(ctx, 'create_candidate', {
        planId: plan.planId,
        capabilities: ['r0.workbench.ping'],
        tools: ['r0_workbench_ping'],
        entryPoints: ['src/plugin.js'],
      }))
      const id = String(created.id)
      await tool(ctx, 'write_candidate_file', { candidateId: id, path: 'src/plugin.js', content: R0_SOURCE })
      await tool(ctx, 'write_candidate_file', {
        candidateId: id,
        path: 'package.json',
        content: `${JSON.stringify({ name: 'dsh-generated-r0-workbench', type: 'module', main: 'src/plugin.js' }, null, 2)}\n`,
      })
      assert.equal(await tool(ctx, 'read_candidate_file', { candidateId: id, path: 'src/plugin.js' }).then((item) => String(item.value)), R0_SOURCE)
      assert.equal((await tool(ctx, 'write_candidate_file', { candidateId: id, path: '../secret.js', content: 'nope' })).isError, true)
      assert.equal((await tool(ctx, 'write_candidate_file', { candidateId: id, path: '/etc/passwd', content: 'nope' })).isError, true)
      assert.equal((await tool(ctx, 'write_candidate_file', {
        candidateId: id,
        path: 'big.md',
        content: 'x'.repeat(WORKBENCH_MAX_FILE_BYTES + 1),
      })).isError, true)
      const tooMany = isolatedWorkbench()
      const flood = tooMany.workbench.create({ planId: tooMany.workbench.rememberPlan(tooMany.review).planId })
      for (let i = 0; i < WORKBENCH_MAX_FILE_COUNT - 1; i += 1) {
        tooMany.workbench.writeFile(flood.id, `f${i}.txt`, 'ok\n')
      }
      assert.throws(() => tooMany.workbench.writeFile(flood.id, 'overflow.txt', 'nope\n'), WorkbenchContractError)
      const empty = isolatedWorkbench()
      const listed = empty.workbench.create({ planId: empty.workbench.rememberPlan(empty.review).planId })
      for (let i = 0; i < WORKBENCH_MAX_TRAVERSAL_ENTRIES + 1; i += 1) mkdirSync(path.join(empty.workspace.get(listed.id).workspaceRoot, `d${i}`))
      assert.throws(() => empty.workbench.listFiles(listed.id), WorkbenchContractError)
      assert.equal(ctx.tools.get('remember_plan'), undefined)
      assert.doesNotMatch(JSON.stringify(ctx.tools.get('write_candidate_file') ?? {}), /"argv"|npm run|postinstall/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('C. approval request is gated on current-digest review-complete', async () => {
    const { ctx } = await bootAssistantControl()
    try {
      const id = authorR0(ctx)
      assert.equal((await tool(ctx, 'request_extension_approval', { candidateId: id })).isError, true)
      parse(await tool(ctx, 'validate_candidate', { candidateId: id }))
      parse(await tool(ctx, 'seal_candidate', { candidateId: id }))
      const unreviewed = await tool(ctx, 'request_extension_approval', { candidateId: id })
      assert.equal(unreviewed.isError, true)
      assert.match(JSON.stringify(unreviewed), /review-required|Independent Review/)
      const reviewed = parse(await tool(ctx, 'review_candidate', { candidateId: id }))
      assert.equal(reviewed.state, 'review-complete')
      assert.equal(reviewed.approvalStatus, 'NOT APPROVED')
      const requested = parse(await tool(ctx, 'request_extension_approval', { candidateId: id }))
      assert.equal(requested.decision, 'approval-requested')
      assert.equal(ctx.capabilityRegistry.get('generated/r0-workbench-ping', '0.1.0'), undefined)
      assert.equal(ctx.tools.get('r0_workbench_ping'), undefined)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('D. repair keeps the sealed parent and inherited blockers', () => {
    const blocker = finding({
      reviewedDigest: 'pending',
      severity: 'BLOCKER',
      category: 'acceptance-contract',
      claim: 'needs-repair',
      location: 'policy',
      evidence: 'forced blocker',
      whyItMatters: 'must remain until remediated',
      requiredRemediation: 'fix it',
      status: 'open',
    })
    const setup = isolatedWorkbench(new PolicyReviewerProvider(() => [blocker]))
    const created = setup.workbench.create({
      planId: setup.workbench.rememberPlan(setup.review).planId,
      manifest: { capabilities: ['r0.workbench.ping'], tools: ['r0_workbench_ping'], entryPoints: ['src/plugin.js'] },
    })
    setup.workbench.writeFile(created.id, 'src/plugin.js', R0_SOURCE)
    setup.workbench.writeFile(created.id, 'package.json', `${JSON.stringify({ name: 'dsh-r0', type: 'module', main: 'src/plugin.js' }, null, 2)}\n`)
    setup.workbench.validate(created.id)
    setup.workbench.seal(created.id)
    const report = setup.workbench.review(created.id)
    assert.equal(report.state, 'changes-required')
    assert.equal(setup.governance.requestEligibility(created.id).ok, false)
    assert.ok(setup.governance.requestEligibility(created.id).denials.some((item) => item.reason === 'review-changes-required'))
    const repaired = setup.workbench.repair(created.id)
    assert.notEqual(repaired.id, created.id)
    assert.equal(setup.workspace.get(created.id).sealed, true)
    assert.throws(() => setup.workspace.writeFile(created.id, 'src/plugin.js', 'mutated'), /sealed|Sealed/)
    assert.equal(repaired.parentId, created.id)
    const again = setup.workbench.review(repaired.id)
    assert.equal(again.state, 'changes-required')
    assert.ok(again.findings.some((item) => item.claim === 'needs-repair' && item.blocking))
  })

  it('E. scripted slice reaches an Approval Card, isolated activation, and rollback', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl()
    try {
      const id = authorR0(ctx)
      parse(await tool(ctx, 'validate_candidate', { candidateId: id }))
      parse(await tool(ctx, 'seal_candidate', { candidateId: id }))
      parse(await tool(ctx, 'review_candidate', { candidateId: id }))
      const requested = parse(await tool(ctx, 'request_extension_approval', { candidateId: id }))
      assert.equal(requested.decision, 'approval-requested')
      const snapshot = gatherWorkspaceSnapshot({ ctx, sessionId: 'wb-e' })
      const view = projectMissionControl(snapshot)
      const card = view.approvals.find((item) => item.kind === 'self-extension' && item.candidateId === id)
      assert.ok(card)
      assert.equal(view.candidates?.find((item) => item.id === id)?.canRequestApproval, true)
      assert.equal(ctx.capabilityRegistry.get('generated/r0-workbench-ping', '0.1.0'), undefined)
      assert.throws(() => ctx.extensionGovernance.recordUntrustedApproval({ approved: true }))
      assert.equal('activate' in ctx.extensionGovernance, false)
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
      recoveryRoot.recordApproval(human, {
        candidateId: id,
        fingerprint: String(requested.fingerprint),
        decision: 'approved-for-exact-diff',
      })
      const activated = await recoveryRoot.activate(id, human)
      assert.equal(activated.state, 'active', activated.lastFailure?.diagnostics)
      const ping = await tool(ctx, 'r0_workbench_ping', { text: 'ok' })
      assert.equal(String(ping.value), 'OK')
      const rolled = await recoveryRoot.rollback(human)
      assert.equal(rolled.state, 'rolled-back')
      assert.equal(ctx.tools.get('r0_workbench_ping'), undefined)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits authoring and request tools in Safe Mode', async () => {
    const { ctx } = await bootSafeModeRuntime()
    try {
      assert.equal(ctx.tools.get('create_candidate'), undefined)
      assert.equal(ctx.tools.get('write_candidate_file'), undefined)
      assert.equal(ctx.tools.get('request_extension_approval'), undefined)
      assert.ok(ctx.tools.get('inspect_extension_governance'))
      assert.equal(ctx.get('candidateWorkbench'), undefined)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

function authorR0(ctx: Awaited<ReturnType<typeof bootAssistantControl>>['ctx']): string {
  const plan = ctx.candidateWorkbench.rememberPlan(ctx.capabilityResolution.review({
    capability: 'r0.workbench.ping',
    need: 'uppercase text',
    inventory: { complete: true, seams: [] },
  }))
  const created = ctx.candidateWorkbench.create({
    planId: plan.planId,
    manifest: { capabilities: ['r0.workbench.ping'], tools: ['r0_workbench_ping'], entryPoints: ['src/plugin.js'] },
  })
  ctx.candidateWorkbench.writeFile(created.id, 'src/plugin.js', R0_SOURCE)
  ctx.candidateWorkbench.writeFile(created.id, 'package.json', `${JSON.stringify({ name: 'dsh-generated-r0-workbench', type: 'module', main: 'src/plugin.js' }, null, 2)}\n`)
  return created.id
}

function isolatedWorkbench(provider?: PolicyReviewerProvider) {
  const registry = new RegistryService(new InMemoryRegistryPersistence())
  bootstrapCoreInventory((input) => registry.register(input))
  const workspace = new CandidateService(registry, mkdtempSync(path.join(tmpdir(), 'dsh-wb-')))
  const review = new ResolutionService(registry).review({
    capability: 'r0.workbench.ping',
    need: 'uppercase text',
    inventory: { complete: true, seams: [] },
  })
  const independent = new ReviewService(provider, (id) => workspace.get(id), { hostLineage: true })
  const root = new RecoveryRoot(registry, workspace, undefined, { independentReview: independent })
  const workbench = new WorkbenchService(new ResolutionService(registry), workspace, workspace, independent, root.service)
  return { workbench, workspace, review, governance: root.service }
}
