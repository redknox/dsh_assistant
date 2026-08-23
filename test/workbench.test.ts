import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { CandidateService } from '../src/domain/candidate/index.js'
import {
  WORKBENCH_MAX_FILE_BYTES,
  WORKBENCH_MAX_FILE_COUNT,
  WORKBENCH_MAX_LIST_DEPTH,
  WORKBENCH_MAX_TRAVERSAL_ENTRIES,
  WORKBENCH_MAX_WORKSPACE_BYTES,
  WorkbenchContractError,
  WorkbenchService,
  type WorkbenchPersistState,
} from '../src/domain/workbench/index.js'
import { RecoveryRoot } from '../src/domain/governance/index.js'
import { InMemoryRegistryPersistence, RegistryService, bootstrapCoreInventory } from '../src/domain/registry/index.js'
import { ResolutionService } from '../src/domain/resolution/index.js'
import { PolicyReviewerProvider, ReviewService, finding, reviewPackageFromCandidate } from '../src/domain/review/index.js'
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

  it('D. repair uses host parent digest and keeps inherited blockers until remediated', () => {
    const openBlocker = (digest: string) => finding({
      reviewedDigest: digest,
      severity: 'BLOCKER',
      category: 'acceptance-contract',
      claim: 'needs-repair',
      location: 'policy',
      evidence: 'forced blocker',
      whyItMatters: 'must remain until remediated',
      requiredRemediation: 'fix it',
      status: 'open',
    })
    const inherited = isolatedWorkbench(new PolicyReviewerProvider((pkg) => [openBlocker(pkg.candidate.digest)]))
    const created = authorIsolated(inherited)
    const report = inherited.workbench.review(created)
    assert.equal(report.state, 'changes-required')
    assert.ok(inherited.governance.requestEligibility(created).denials.some((item) => item.reason === 'review-changes-required'))
    const repaired = inherited.workbench.repair(created)
    assert.notEqual(repaired.id, created)
    assert.equal(inherited.workspace.get(created).sealed, true)
    assert.throws(() => inherited.workbench.writeFile(created, 'src/plugin.js', 'mutated'), WorkbenchContractError)
    assert.equal(repaired.parentId, created)
    assert.equal(repaired.parentDigest, inherited.workspace.get(created).digest)
    const carried = inherited.workbench.review(repaired.id)
    assert.equal(carried.state, 'changes-required')
    assert.ok(carried.findings.some((item) => item.claim === 'needs-repair' && item.blocking && item.status === 'open'))
    assert.equal(carried.findings.some((item) => item.claim === 'invalid-parent-revision'), false)

    const omittedSetup = isolatedWorkbench(new PolicyReviewerProvider((pkg) => (
      pkg.candidate.parentRevision ? [] : [openBlocker(pkg.candidate.digest)]
    )))
    const omittedParent = authorIsolated(omittedSetup)
    omittedSetup.workbench.review(omittedParent)
    const omittedChild = omittedSetup.workbench.repair(omittedParent)
    const omitted = omittedSetup.workbench.review(omittedChild.id)
    assert.equal(omitted.state, 'changes-required')
    assert.ok(omitted.findings.some((item) => item.claim === 'needs-repair' && item.status === 'open'))

    const forged = isolatedWorkbench(new PolicyReviewerProvider((pkg) => (
      pkg.candidate.parentRevision
        ? [finding({
          reviewedDigest: pkg.candidate.digest,
          severity: 'BLOCKER',
          category: 'acceptance-contract',
          claim: 'unrelated-forged',
          location: 'policy',
          evidence: 'forged close',
          whyItMatters: 'wrong claim cannot drop the parent blocker',
          requiredRemediation: 'fix the original claim',
          status: 'resolved',
        })]
        : [openBlocker(pkg.candidate.digest)]
    )))
    const forgedParent = authorIsolated(forged)
    forged.workbench.review(forgedParent)
    const forgedChild = forged.workbench.repair(forgedParent)
    const forgedReport = forged.workbench.review(forgedChild.id)
    assert.equal(forgedReport.state, 'changes-required')
    assert.ok(forgedReport.findings.some((item) => item.claim === 'needs-repair' && item.status === 'open'))

    const closing = isolatedWorkbench(new PolicyReviewerProvider((pkg) => (
      pkg.candidate.parentRevision
        ? [finding({
          reviewedDigest: pkg.candidate.digest,
          severity: 'BLOCKER',
          category: 'acceptance-contract',
          claim: 'needs-repair',
          location: 'policy',
          evidence: 'remediated on this digest',
          whyItMatters: 'current-revision evidence',
          requiredRemediation: 'none',
          status: 'resolved',
        })]
        : [openBlocker(pkg.candidate.digest)]
    )))
    const closeParent = authorIsolated(closing)
    closing.workbench.review(closeParent)
    const closeChild = closing.workbench.repair(closeParent)
    closing.workbench.validate(closeChild.id)
    closing.workbench.seal(closeChild.id)
    const closed = closing.workbench.review(closeChild.id)
    assert.equal(closed.state, 'review-complete')
    assert.equal(closed.findings.some((item) => item.claim === 'invalid-parent-revision'), false)
    assert.equal(closed.findings.some((item) => item.claim === 'needs-repair' && item.status === 'open'), false)
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
      const projected = view.candidates?.find((item) => item.id === id)
      assert.equal(projected?.canRequestApproval, true)
      assert.equal(projected?.owner, 'generated/r0-workbench-ping')
      assert.ok(projected?.diff?.capabilities.added.includes('r0.workbench.ping'))
      assert.ok(projected?.effectSummary?.includes('remote-side-effect none') || projected?.effectSummary?.some((item) => item.startsWith('remote-side-effect')))
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

  it('denies request when the active base is upgraded or disabled', () => {
    const upgraded = isolatedWorkbench()
    const evolve = new ResolutionService(upgraded.registry).review({
      capability: 'calendar.read',
      need: 'richer attendee filtering',
      behavior: 'attendee-filter',
    })
    const plan = upgraded.workbench.rememberPlan(evolve)
    const created = upgraded.workbench.create({
      planId: plan.planId,
      manifest: { capabilities: ['calendar.read'], tools: ['calendar_list_events'] },
    })
    upgraded.workbench.writeFile(created.id, 'src/ok.ts', 'export const value: string = "ok"\n')
    upgraded.workbench.validate(created.id)
    upgraded.workbench.seal(created.id)
    upgraded.workbench.review(created.id)
    const current = upgraded.registry.get('managed/integrations', '0.1.0')
    assert.ok(current)
    upgraded.registry.transitionStatus('managed/integrations', '0.1.0', 'disabled')
    upgraded.registry.register({
      ...current,
      version: '0.3.0',
      status: 'active',
    })
    const afterUpgrade = upgraded.governance.requestEligibility(created.id)
    assert.equal(afterUpgrade.ok, false)
    assert.ok(afterUpgrade.denials.some((item) => item.reason === 'base-changed'))

    const disabled = isolatedWorkbench()
    const disabledPlan = disabled.workbench.rememberPlan(new ResolutionService(disabled.registry).review({
      capability: 'calendar.read',
      need: 'richer attendee filtering',
      behavior: 'attendee-filter',
    }))
    const disabledCandidate = disabled.workbench.create({
      planId: disabledPlan.planId,
      manifest: { capabilities: ['calendar.read'], tools: ['calendar_list_events'] },
    })
    disabled.workbench.writeFile(disabledCandidate.id, 'src/ok.ts', 'export const value: string = "ok"\n')
    disabled.workbench.validate(disabledCandidate.id)
    disabled.workbench.seal(disabledCandidate.id)
    disabled.workbench.review(disabledCandidate.id)
    disabled.registry.transitionStatus('managed/integrations', '0.1.0', 'disabled')
    const afterDisable = disabled.governance.requestEligibility(disabledCandidate.id)
    assert.equal(afterDisable.ok, false)
    assert.ok(afterDisable.denials.some((item) => item.reason === 'base-changed'))
  })

  it('rejects tampered, symlink, and over-budget repair copies', () => {
    const blocker = new PolicyReviewerProvider((pkg) => [finding({
      reviewedDigest: pkg.candidate.digest,
      severity: 'BLOCKER',
      category: 'acceptance-contract',
      claim: 'needs-repair',
      location: 'policy',
      evidence: 'forced',
      whyItMatters: 'repair path',
      requiredRemediation: 'fix',
      status: 'open',
    })])
    const tampered = isolatedWorkbench(blocker)
    const tamperedId = authorIsolated(tampered)
    tampered.workbench.review(tamperedId)
    writeFileSync(path.join(tampered.workspace.get(tamperedId).workspaceRoot, 'src/plugin.js'), 'tampered\n')
    assertRepairLeavesState(tampered, () => tampered.workbench.repair(tamperedId), /digest/)

    const linked = isolatedWorkbench(blocker)
    const linkedId = authorIsolated(linked)
    linked.workbench.review(linkedId)
    const hostSecret = path.join(mkdtempSync(path.join(tmpdir(), 'dsh-wb-secret-')), 'secret.txt')
    writeFileSync(hostSecret, 'host-secret\n')
    symlinkSync(hostSecret, path.join(linked.workspace.get(linkedId).workspaceRoot, 'leaked.txt'))
    assertRepairLeavesState(linked, () => linked.workbench.repair(linkedId), /symlink|digest/)

    const deep = isolatedWorkbench(blocker)
    const deepDraft = draftIsolated(deep)
    const deepDir = path.join(deep.workspace.get(deepDraft).workspaceRoot, ...Array.from({ length: WORKBENCH_MAX_LIST_DEPTH + 1 }, (_, i) => `d${i}`))
    mkdirSync(deepDir, { recursive: true })
    writeFileSync(path.join(deepDir, 'file.txt'), 'too-deep\n')
    deep.workbench.validate(deepDraft)
    deep.workbench.seal(deepDraft)
    deep.workbench.review(deepDraft)
    assertRepairLeavesState(deep, () => deep.workbench.repair(deepDraft), WorkbenchContractError)

    const counted = isolatedWorkbench(blocker)
    const countedDraft = draftIsolated(counted)
    for (let i = 0; i < WORKBENCH_MAX_FILE_COUNT; i += 1) {
      counted.workspace.writeFile(countedDraft, `extra-${i}.txt`, 'x\n')
    }
    counted.workbench.validate(countedDraft)
    counted.workbench.seal(countedDraft)
    counted.workbench.review(countedDraft)
    assertRepairLeavesState(counted, () => counted.workbench.repair(countedDraft), WorkbenchContractError)

    const heavy = isolatedWorkbench(blocker)
    const heavyDraft = draftIsolated(heavy)
    heavy.workspace.writeFile(heavyDraft, 'blob.bin', 'x'.repeat(WORKBENCH_MAX_WORKSPACE_BYTES + 1))
    heavy.workbench.validate(heavyDraft)
    heavy.workbench.seal(heavyDraft)
    heavy.workbench.review(heavyDraft)
    assertRepairLeavesState(heavy, () => heavy.workbench.repair(heavyDraft), WorkbenchContractError)
  })

  it('rolls back a failed repair copy and can retry the same parent', () => {
    const blocker = new PolicyReviewerProvider((pkg) => [finding({
      reviewedDigest: pkg.candidate.digest,
      severity: 'BLOCKER',
      category: 'acceptance-contract',
      claim: 'needs-repair',
      location: 'policy',
      evidence: 'forced',
      whyItMatters: 'repair path',
      requiredRemediation: 'fix',
      status: 'open',
    })])
    const setup = isolatedWorkbench(blocker)
    const parentId = authorIsolated(setup)
    setup.workbench.review(parentId)
    const before = snapshotWorkbench(setup)
    const original = setup.workspace.writeFile.bind(setup.workspace)
    setup.workspace.writeFile = (id: string, relativePath: string, content: string) => {
      if (id !== parentId) throw new WorkbenchContractError('injected copy failure')
      return original(id, relativePath, content)
    }
    assert.throws(() => setup.workbench.repair(parentId), /injected copy failure/)
    setup.workspace.writeFile = original
    assert.deepEqual(snapshotWorkbench(setup), before)
    const repaired = setup.workbench.repair(parentId)
    assert.notEqual(repaired.id, parentId)
    assert.equal(setup.workspace.list().some((item) => item.id === repaired.id), true)
    assert.equal(existsSync(setup.workspace.get(repaired.id).workspaceRoot), true)
  })

  it('denies request after invalid validation or a stale review', () => {
    const setup = isolatedWorkbench()
    const id = draftIsolated(setup)
    setup.workbench.writeFile(id, 'src/bad.ts', 'export const n: number = "nope"\n')
    setup.workbench.validate(id)
    setup.workbench.seal(id)
    const invalid = setup.governance.requestEligibility(id)
    assert.equal(invalid.ok, false)
    assert.ok(invalid.denials.some((item) => item.reason === 'not-validated'))

    const stale = isolatedWorkbench()
    const staleId = authorIsolated(stale)
    stale.workbench.review(staleId)
    const record = stale.workspace.get(staleId)
    const pkg = reviewPackageFromCandidate(record)
    stale.independent.review({
      ...pkg,
      candidate: { ...pkg.candidate, digest: `${record.digest}-mutated` },
    })
    const staleGate = stale.governance.requestEligibility(staleId)
    assert.equal(staleGate.ok, false)
    assert.ok(staleGate.denials.some((item) => item.reason === 'review-stale'))
  })

  it('restores host plans and parent digest across a real home restart', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-wb-home-'))
    const first = await bootAssistantControl({ home })
    let planId = ''
    let candidateId = ''
    let parentDigest = ''
    try {
      candidateId = authorR0(first.ctx)
      planId = first.ctx.candidateWorkbench.inspect(candidateId).planId ?? ''
      first.ctx.candidateWorkbench.validate(candidateId)
      first.ctx.candidateWorkbench.seal(candidateId)
      first.ctx.candidateWorkbench.review(candidateId)
      parentDigest = first.ctx.candidateWorkspace.get(candidateId).digest ?? ''
      assert.ok(planId)
      assert.ok(parentDigest)
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({ home })
    try {
      const view = second.ctx.candidateWorkbench.inspect(candidateId)
      assert.equal(view.planId, planId)
      const plan = second.ctx.candidateWorkbench.getPlan(planId)
      assert.equal(plan.review.capability, 'r0.workbench.ping')
      assert.equal(plan.review.kind, 'new-plugin')
      assert.notEqual(plan.review.registryFacts, undefined)
      const snapshot = gatherWorkspaceSnapshot({ ctx: second.ctx, sessionId: 'wb-restart' })
      const projected = projectMissionControl(snapshot).candidates?.find((item) => item.id === candidateId)
      assert.equal(projected?.owner, 'generated/r0-workbench-ping')
      assert.ok(projected?.diff)
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('fails closed when durable workbench state is corrupt', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-wb-corrupt-'))
    const first = await bootAssistantControl({ home })
    try {
      authorR0(first.ctx)
    } finally {
      await first.ctx.fiber.dispose()
    }
    writeFileSync(path.join(home, 'self-extension', 'workbench.json'), '{not-json')
    const broken = await bootAssistantControl({ home })
    try {
      assert.equal(broken.diagnostics.persistence, 'corrupt')
      assert.equal(broken.diagnostics.safeMode, true)
    } finally {
      await broken.ctx.fiber.dispose()
    }
  })

  it('restores repair lineage from persisted workbench state', () => {
    let stored: WorkbenchPersistState | undefined
    const blocker = new PolicyReviewerProvider((pkg) => [finding({
      reviewedDigest: pkg.candidate.digest,
      severity: 'BLOCKER',
      category: 'acceptance-contract',
      claim: 'needs-repair',
      location: 'policy',
      evidence: 'forced',
      whyItMatters: 'lineage',
      requiredRemediation: 'fix',
      status: 'open',
    })])
    const first = isolatedWorkbench(blocker, { persist: (state) => { stored = state } })
    const parentId = authorIsolated(first)
    first.workbench.review(parentId)
    const child = first.workbench.repair(parentId)
    assert.ok(stored)
    const restored = new WorkbenchService(
      new ResolutionService(first.registry),
      first.workspace,
      first.workspace,
      first.independent,
      first.governance,
      { restore: stored },
    )
    const view = restored.inspect(child.id)
    assert.equal(view.parentDigest, first.workspace.get(parentId).digest)
    assert.equal(view.planId, first.workbench.inspect(parentId).planId)
    const report = restored.review(child.id)
    assert.equal(report.findings.some((item) => item.claim === 'invalid-parent-revision'), false)
    assert.ok(report.findings.some((item) => item.claim === 'needs-repair'))
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

function snapshotWorkbench(setup: ReturnType<typeof isolatedWorkbench>) {
  const records = setup.workspace.list()
  const area = records[0] === undefined ? undefined : path.dirname(records[0].workspaceRoot)
  return {
    ids: records.map((item) => item.id).sort(),
    state: structuredClone(setup.workbench.exportState()),
    dirs: area === undefined || !existsSync(area) ? [] : readdirSync(area).sort(),
  }
}

function assertRepairLeavesState(
  setup: ReturnType<typeof isolatedWorkbench>,
  act: () => unknown,
  error: RegExp | typeof WorkbenchContractError,
): void {
  const before = snapshotWorkbench(setup)
  assert.throws(act, error)
  assert.deepEqual(snapshotWorkbench(setup), before)
  assert.throws(act, error)
  assert.deepEqual(snapshotWorkbench(setup), before)
}

function draftIsolated(setup: ReturnType<typeof isolatedWorkbench>): string {
  const created = setup.workbench.create({
    planId: setup.workbench.rememberPlan(setup.review).planId,
    manifest: { capabilities: ['r0.workbench.ping'], tools: ['r0_workbench_ping'], entryPoints: ['src/plugin.js'] },
  })
  setup.workbench.writeFile(created.id, 'src/plugin.js', R0_SOURCE)
  setup.workbench.writeFile(created.id, 'package.json', `${JSON.stringify({ name: 'dsh-r0', type: 'module', main: 'src/plugin.js' }, null, 2)}\n`)
  return created.id
}

function authorIsolated(setup: ReturnType<typeof isolatedWorkbench>): string {
  const id = draftIsolated(setup)
  setup.workbench.validate(id)
  setup.workbench.seal(id)
  return id
}

function isolatedWorkbench(provider?: PolicyReviewerProvider, options: { persist?: (state: WorkbenchPersistState) => void } = {}) {
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
  const workbench = new WorkbenchService(
    new ResolutionService(registry),
    workspace,
    workspace,
    independent,
    root.service,
    { persist: options.persist },
  )
  return { workbench, workspace, review, governance: root.service, registry, independent }
}
