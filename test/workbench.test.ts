import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { CandidateService } from '../src/domain/candidate/index.js'
import {
  GENERATED_EXTENSION_API_V1,
  WORKBENCH_MAX_FILE_BYTES,
  WORKBENCH_MAX_FILE_COUNT,
  WORKBENCH_MAX_LIST_DEPTH,
  WORKBENCH_MAX_TRAVERSAL_ENTRIES,
  WORKBENCH_MAX_WORKSPACE_BYTES,
  WorkbenchContractError,
  WorkbenchRepairRollbackError,
  WorkbenchService,
  parseWorkbenchRiskModel,
  projectValidationDiagnostics,
  type WorkbenchPersistState,
} from '../src/domain/workbench/index.js'
import { WORKBENCH_CONVERSATION_GUIDANCE } from '../src/plugins/workbench-plugin.js'
import { googleCalendarWriteRiskModel } from '../src/domain/reliability/index.js'
import { RecoveryRoot } from '../src/domain/governance/index.js'
import { CatalogDiscovery } from '../src/domain/discovery/index.js'
import { InMemoryRegistryPersistence, RegistryService, bootstrapCoreInventory } from '../src/domain/registry/index.js'
import { ResolutionService } from '../src/domain/resolution/index.js'
import { PolicyReviewerProvider, ReviewService, finding, reviewPackageFromCandidate } from '../src/domain/review/index.js'
import { gatherWorkspaceSnapshot, projectMissionControl } from '../src/domain/workspace/index.js'
import { PRODUCT_TOOL_NAMES } from '../src/product/bundle.js'
import { bootAssistantControl, bootSafeModeRuntime } from '../src/runtime/boot.js'

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
      assert.doesNotMatch(JSON.stringify(ctx.tools.get('set_candidate_manifest') ?? {}), /"argv"|"script"/)
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
      const approvedView = projectMissionControl(gatherWorkspaceSnapshot({ ctx, sessionId: 'wb-e' }))
      assert.equal(approvedView.approvals.some((item) => item.candidateId === id), false)
      const activationCard = approvedView.activations.find((item) => item.candidateId === id)
      assert.ok(activationCard)
      assert.equal(activationCard.status, 'APPROVED_NOT_ACTIVE')
      const inspected = ctx.candidateWorkbench.inspect(id)
      assert.equal('approvalStatus' in (inspected.review ?? {}), false)
      assert.equal(inspected.governanceApproval, 'approved-for-exact-diff')
      assert.equal(inspected.activationState, 'inactive')
      assert.doesNotMatch(JSON.stringify(inspected), /NOT APPROVED/)
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

  it('retires a stale Activation Card after the approved digest changes', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl()
    try {
      const id = authorR0(ctx)
      parse(await tool(ctx, 'validate_candidate', { candidateId: id }))
      parse(await tool(ctx, 'seal_candidate', { candidateId: id }))
      parse(await tool(ctx, 'review_candidate', { candidateId: id }))
      const requested = parse(await tool(ctx, 'request_extension_approval', { candidateId: id }))
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
      recoveryRoot.recordApproval(human, {
        candidateId: id,
        fingerprint: String(requested.fingerprint),
        decision: 'approved-for-exact-diff',
      })
      const approved = projectMissionControl(gatherWorkspaceSnapshot({ ctx, sessionId: 'wb-stale' }))
      assert.equal(approved.activations.some((item) => item.candidateId === id && item.status === 'APPROVED_NOT_ACTIVE'), true)
      writeFileSync(path.join(ctx.candidateWorkspace.get(id).workspaceRoot, 'src/plugin.js'), `${R0_SOURCE}\nexport const mutated = true\n`)
      assert.ok(ctx.extensionGovernance.eligibility(id).denials.some((item) => item.reason === 'digest-mismatch'))
      const stale = projectMissionControl(gatherWorkspaceSnapshot({ ctx, sessionId: 'wb-stale' }))
      assert.equal(stale.activations.some((item) => item.candidateId === id), false)
      assert.equal(stale.candidates?.find((item) => item.id === id)?.extensionLifecycle, 'SUPERSEDED')
      assert.equal(ctx.candidateWorkbench.inspect(id).activationState, 'inactive')
      assert.doesNotMatch(JSON.stringify(stale.activations), /APPROVED_NOT_ACTIVE/)
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

  it('copies the preflight snapshot even if the sealed parent is mutated during repair', () => {
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
    const parentRoot = setup.workspace.get(parentId).workspaceRoot
    const originalWrite = setup.workspace.writeFile.bind(setup.workspace)
    setup.workspace.writeFile = (id: string, relativePath: string, content: string) => {
      if (id !== parentId) {
        writeFileSync(path.join(parentRoot, 'src/plugin.js'), `MUTATED-${'x'.repeat(1024)}\n`)
        writeFileSync(path.join(parentRoot, 'package.json'), `${'y'.repeat(2048)}\n`)
      }
      return originalWrite(id, relativePath, content)
    }
    const repaired = setup.workbench.repair(parentId)
    setup.workspace.writeFile = originalWrite
    assert.equal(setup.workbench.readFile(repaired.id, 'src/plugin.js'), R0_SOURCE)
    assert.match(setup.workbench.readFile(repaired.id, 'package.json'), /dsh-r0/)
    assert.notEqual(setup.workspace.readFile(parentId, 'src/plugin.js'), R0_SOURCE)
  })

  it('does not pretend a leftover repair child was rolled back when discard fails', () => {
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
    const originalWrite = setup.workspace.writeFile.bind(setup.workspace)
    const originalDiscard = setup.workspace.discard.bind(setup.workspace)
    let childWrites = 0
    setup.workspace.writeFile = (id: string, relativePath: string, content: string) => {
      if (id !== parentId) {
        childWrites += 1
        if (childWrites > 1) throw new WorkbenchContractError('injected copy failure')
      }
      return originalWrite(id, relativePath, content)
    }
    setup.workspace.discard = () => {
      throw new Error('disk full')
    }
    assert.throws(() => setup.workbench.repair(parentId), (error: unknown) => {
      assert.ok(error instanceof WorkbenchRepairRollbackError)
      assert.match(error.message, /leftover candidate/)
      assert.match(error.message, /disk full/)
      assert.match(error.message, /injected copy failure/)
      assert.equal(setup.workspace.list().some((item) => item.id === error.leftoverCandidateId), true)
      assert.equal(setup.workbench.exportState().bindings.some((item) => item.candidateId === error.leftoverCandidateId && item.leftover === true), true)
      assert.equal(setup.workbench.list().candidates.find((item) => item.id === error.leftoverCandidateId)?.leftover, true)
      return true
    })
    setup.workspace.writeFile = originalWrite
    setup.workspace.discard = originalDiscard
  })

  it('rejects malformed Risk Models instead of casting model JSON', async () => {
    const valid = googleCalendarWriteRiskModel()
    assert.doesNotThrow(() => parseWorkbenchRiskModel(valid))
    assert.throws(() => parseWorkbenchRiskModel({ ...valid, sideEffects: undefined }), /sideEffects is required/)
    assert.throws(() => parseWorkbenchRiskModel({ ...valid, declaredClass: 'R9' }), /declaredClass/)
    assert.throws(() => parseWorkbenchRiskModel({ ...valid, trustBoundaries: [] }), /trustBoundaries must be an object/)
    assert.throws(() => parseWorkbenchRiskModel({ ...valid, extra: true }), /unknown field extra/)
    const { ctx } = await bootAssistantControl()
    try {
      const plan = ctx.candidateWorkbench.rememberPlan(ctx.capabilityResolution.review({
        capability: 'r0.workbench.ping',
        need: 'uppercase text',
        inventory: { complete: true, seams: [] },
      }))
      const created = parse(await tool(ctx, 'create_candidate', { planId: plan.planId, capabilities: ['r0.workbench.ping'] }))
      const missing = { ...valid } as Record<string, unknown>
      delete missing.sideEffects
      const omitted = await tool(ctx, 'set_candidate_manifest', { candidateId: created.id, riskModel: missing })
      assert.equal(omitted.isError, true)
      assert.match(JSON.stringify(omitted), /sideEffects/)
      const wrongEnum = await tool(ctx, 'set_candidate_manifest', {
        candidateId: created.id,
        riskModel: { ...valid, retryPolicy: { ...valid.retryPolicy, writes: 'always' } },
      })
      assert.equal(wrongEnum.isError, true)
      assert.match(JSON.stringify(wrongEnum), /retryPolicy.writes|writes/)
      const wrongContainer = await tool(ctx, 'set_candidate_manifest', {
        candidateId: created.id,
        riskModel: { ...valid, sideEffects: 'not-an-array' },
      })
      assert.equal(wrongContainer.isError, true)
      assert.match(JSON.stringify(wrongContainer), /sideEffects/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('patches allowlisted manifest fields without wiping omitted governance declarations', async () => {
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
      stampContract(ctx.candidateWorkspace, id)
      parse(await tool(ctx, 'set_candidate_manifest', {
        candidateId: id,
        permissions: ['local.fake.suite'],
        runtimeSeams: ['integrations.calendar'],
        services: ['calendar'],
        providers: ['google-calendar'],
        secrets: ['CALENDAR_TOKEN'],
        configRequired: ['GOOGLE_CALENDAR_ACCOUNT'],
        effects: {
          filesystem: ['workspace/notes'],
          network: ['https://www.googleapis.com/calendar/v3'],
          process: ['child_process'],
          secrets: ['CALENDAR_TOKEN'],
          externalSystems: ['google-calendar-v3'],
          remoteSideEffect: 'mutate',
        },
        riskModel: googleCalendarWriteRiskModel(),
      }))
      parse(await tool(ctx, 'set_candidate_manifest', {
        candidateId: id,
        capabilities: ['r0.workbench.ping'],
      }))
      const manifest = ctx.candidateWorkspace.get(id).manifest
      assert.deepEqual([...manifest.secrets], ['CALENDAR_TOKEN'])
      assert.deepEqual([...manifest.providers], ['google-calendar'])
      assert.deepEqual([...manifest.effects.filesystem], ['workspace/notes'])
      assert.deepEqual([...manifest.effects.network], ['https://www.googleapis.com/calendar/v3'])
      assert.deepEqual([...manifest.effects.process], ['child_process'])
      assert.equal(manifest.effects.remoteSideEffect, 'mutate')
      assert.equal(manifest.riskModel?.declaredClass, 'R3')
      await tool(ctx, 'write_candidate_file', { candidateId: id, path: 'src/plugin.js', content: R0_SOURCE })
      await tool(ctx, 'write_candidate_file', {
        candidateId: id,
        path: 'package.json',
        content: `${JSON.stringify({ name: 'dsh-generated-r0-workbench', type: 'module', main: 'src/plugin.js' }, null, 2)}\n`,
      })
      const validated = parse(await tool(ctx, 'validate_candidate', { candidateId: id }))
      assert.equal(validated.validation && (validated.validation as { passed: boolean }).passed, true, JSON.stringify(validated.validation))
      parse(await tool(ctx, 'seal_candidate', { candidateId: id }))
      const reviewed = parse(await tool(ctx, 'review_candidate', { candidateId: id }))
      assert.equal(reviewed.state, 'review-complete', JSON.stringify(reviewed))
      const requested = parse(await tool(ctx, 'request_extension_approval', { candidateId: id }))
      assert.equal(requested.decision, 'approval-requested')
      const projected = projectMissionControl(gatherWorkspaceSnapshot({ ctx, sessionId: 'wb-manifest' }))
        .candidates?.find((item) => item.id === id)
      assert.ok(projected?.effectSummary?.includes('remote-side-effect mutate'))
      assert.ok(projected?.effectSummary?.includes('workspace/notes'))
      assert.ok(projected?.effectSummary?.includes('https://www.googleapis.com/calendar/v3'))
      assert.ok(projected?.effectSummary?.includes('child_process'))
      assert.ok(projected?.effectSummary?.some((item) => item.includes('CALENDAR_TOKEN') || item.includes('secret-access')))
      assert.ok(projected?.effectSummary?.includes('google-calendar-v3'))
    } finally {
      await ctx.fiber.dispose()
    }
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
      assert.equal(ctx.tools.get('scaffold_candidate'), undefined)
      assert.equal(ctx.tools.get('write_candidate_file'), undefined)
      assert.equal(ctx.tools.get('request_extension_approval'), undefined)
      assert.ok(ctx.tools.get('inspect_extension_governance'))
      assert.ok(ctx.tools.get('inspect_authoring_contract'))
      assert.ok(ctx.tools.get('list_workbench'))
      assert.ok(ctx.tools.get('inspect_candidate'))
      assert.ok(ctx.get('candidateWorkbench'))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('A. host contract and scaffold stay inactive and refuse overwrite', async () => {
    const { ctx } = await bootAssistantControl()
    try {
      const assembly = await ctx.systemPrompt.assemble()
      assert.match(assembly.sections.map((item) => item.text).join('\n'), /resolve first/)
      assert.match(WORKBENCH_CONVERSATION_GUIDANCE, /Never treat "build this" as approve/)
      const bad = await tool(ctx, 'inspect_authoring_contract', { version: 'generated-extension-api/v99' })
      assert.equal(bad.isError, true)
      const contract = parse(await tool(ctx, 'inspect_authoring_contract', {}))
      assert.equal(contract.id, GENERATED_EXTENSION_API_V1)
      assert.deepEqual(contract.brokerOps, [])
      const plan = parse(await tool(ctx, 'plan_capability_change', {
        capability: 'text.slugify',
        need: 'lowercase URL-safe slug',
      }))
      assert.equal(plan.kind, 'new-plugin')
      const created = parse(await tool(ctx, 'create_candidate', { planId: plan.planId }))
      const id = String(created.id)
      const unscaffolded = parse(await tool(ctx, 'validate_candidate', { candidateId: id }))
      assert.equal((unscaffolded.validation as { passed: boolean }).passed, false)
      assert.ok(((unscaffolded.validation as { failed: string[] }).failed).includes('runtime.contract'))
      parse(await tool(ctx, 'scaffold_candidate', {
        candidateId: id,
        toolName: 'text_slugify',
        toolDescription: 'Lowercase URL-safe slug',
      }))
      const again = await tool(ctx, 'scaffold_candidate', { candidateId: id, toolName: 'other_tool' })
      assert.equal(again.isError, true)
      assert.match(JSON.stringify(again), /overwrite/)
      const pkg = JSON.parse(ctx.candidateWorkbench.readFile(id, 'package.json')) as { scripts?: unknown; dependencies?: unknown }
      assert.equal(pkg.scripts, undefined)
      assert.equal(pkg.dependencies, undefined)
      assert.equal((await tool(ctx, 'write_candidate_file', {
        candidateId: id,
        path: 'generated-extension-api.json',
        content: `${JSON.stringify({ version: 'generated-extension-api/v99' })}\n`,
      })).isError, true)
      ctx.candidateWorkspace.writeFile(id, 'package.json', `${JSON.stringify({
        name: 'generated-text-slugify',
        type: 'module',
        main: 'src/plugin.js',
        dependencies: { leftpad: '1.0.0' },
        scripts: { test: 'node --test' },
      }, null, 2)}\n`)
      const deps = parse(await tool(ctx, 'validate_candidate', { candidateId: id }))
      assert.equal((deps.validation as { passed: boolean }).passed, false)
      assert.ok(((deps.validation as { failed: string[] }).failed).includes('package.inspect'))
      const current = ctx.candidateWorkspace.get(id).manifest
      ctx.candidateWorkspace.setManifest(id, { ...current, runtimeContractVersion: 'generated-extension-api/v99' })
      const failed = parse(await tool(ctx, 'validate_candidate', { candidateId: id }))
      assert.equal((failed.validation as { passed: boolean }).passed, false)
      assert.ok(((failed.validation as { failed: string[] }).failed).includes('runtime.contract'))
      assert.equal(ctx.capabilityRegistry.get('generated/text-slugify', '0.1.0'), undefined)
      const inventory = JSON.stringify([...PRODUCT_TOOL_NAMES, ...Object.keys(ctx.tools)])
      assert.doesNotMatch(inventory, /approve_extension|activate_extension|rollback_extension|shell|sandbox-root/)
      const missing = isolatedWorkbench()
      const blocked = missing.workbench.plan({ capability: 'text.slugify', need: 'slug' })
      assert.equal(blocked.kind, 'insufficient-information')
      const closed = isolatedUnavailableDiscovery().workbench.plan({ capability: 'text.slugify', need: 'slug' })
      assert.equal(closed.kind, 'insufficient-information')
      const incomplete = isolatedUnavailableDiscovery('incomplete').workbench.plan({ capability: 'text.slugify', need: 'slug' })
      assert.equal(incomplete.kind, 'insufficient-information')
      assert.equal((await tool(ctx, 'list_workbench', { cursor: 'nope' })).isError, true)
      const paging = isolatedWorkbench()
      paging.workbench.rememberPlan(paging.review)
      paging.workbench.rememberPlan(paging.review)
      const firstPage = paging.workbench.list({ limit: 1 })
      assert.equal(firstPage.plans.length, 1)
      assert.ok(firstPage.nextCursor)
      const nextPage = paging.workbench.list({ limit: 1, cursor: firstPage.nextCursor })
      assert.equal(nextPage.plans.length, 1)
      assert.notEqual(nextPage.plans[0]?.planId, firstPage.plans[0]?.planId)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('B. validation diagnostics stay bounded and repair does not mutate the parent', () => {
    const view = projectValidationDiagnostics({
      id: 'cand-diag',
      workspaceRoot: '/Users/konghaifeng/secret/candidate',
      validation: {
        candidateId: 'cand-diag',
        digest: 'abc',
        passed: false,
        unresolved: [],
        blocked: [],
        stages: [{
          name: 'typecheck',
          status: 'failed',
          summary: 'Typecheck failed at /Users/konghaifeng/secret/candidate/src/bad.ts',
          startedAt: '2026-08-23T00:00:00.000Z',
          endedAt: '2026-08-23T00:00:00.000Z',
          evidence: 'Implemented',
          diagnostics: `/Users/konghaifeng/secret/candidate/src/bad.ts TOKEN=supersecret ${'x'.repeat(1800)}`,
        }, {
          name: 'tests',
          status: 'failed',
          summary: 'Candidate tests failed.',
          startedAt: '2026-08-23T00:00:00.000Z',
          endedAt: '2026-08-23T00:00:00.000Z',
          evidence: 'Implemented',
          diagnostics: 'file:///workspace/root/src/plugin.js and /root/secret and C:\\\\Users\\\\x\\\\src\\\\plugin.js and /usr/bin/node',
        }],
      },
    })
    const rendered = JSON.stringify(view)
    assert.doesNotMatch(rendered, /\/Users\/konghaifeng/)
    assert.doesNotMatch(rendered, /supersecret/)
    assert.equal(view.truncated, true)
    assert.match(view.stages[0]?.diagnostic ?? '', /\[truncated\]/)
    assert.equal(view.stages[0]?.file, 'src/bad.ts')
    assert.equal(view.stages[1]?.name, 'tests')
    assert.equal(view.stages[1]?.status, 'failed')
    assert.doesNotMatch(JSON.stringify(view.stages[1]), /\/workspace|\/root\/secret|C:\\\\Users|\/usr\/bin/)
    assert.equal(view.stages[1]?.file, 'src/plugin.js')

    const policy = new PolicyReviewerProvider((pkg) => [finding({
      reviewedDigest: pkg.candidate.digest,
      severity: 'BLOCKER',
      category: 'acceptance-contract',
      claim: 'needs-repair',
      location: 'policy',
      evidence: 'forced',
      whyItMatters: 'diagnostics',
      requiredRemediation: 'fix',
      status: 'open',
    })])
    const blocked = isolatedWorkbench(policy)
    const blockedParent = authorIsolated(blocked)
    blocked.workbench.review(blockedParent)
    const child = blocked.workbench.repair(blockedParent)
    const listed = blocked.workbench.list()
    assert.ok(listed.candidates.some((item) => item.id === child.id && item.parentId === blockedParent))
    assert.throws(() => blocked.workbench.writeFile(blockedParent, 'src/plugin.js', 'mutated'), WorkbenchContractError)
    assert.equal(blocked.workspace.get(blockedParent).sealed, true)
  })

  it('C. list/resume works after a real home restart and leftover stays visible', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-wb-m6c-'))
    const first = await bootAssistantControl({ home })
    let candidateId = ''
    try {
      const plan = parse(await tool(first.ctx, 'plan_capability_change', {
        capability: 'text.slugify',
        need: 'lowercase URL-safe slug',
      }))
      const created = parse(await tool(first.ctx, 'create_candidate', { planId: plan.planId }))
      candidateId = String(created.id)
      parse(await tool(first.ctx, 'scaffold_candidate', { candidateId }))
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({ home })
    try {
      const listed = parse(await tool(second.ctx, 'list_workbench', { limit: 20 }))
      const rendered = JSON.stringify(listed)
      assert.doesNotMatch(rendered, /workspaceRoot|\/Users\/|src\/plugin\.js/)
      assert.ok((listed.candidates as { id: string }[]).some((item) => item.id === candidateId))
      const inspected = parse(await tool(second.ctx, 'inspect_candidate', { candidateId }))
      assert.equal(inspected.owner, 'generated/text-slugify')
      assert.equal(inspected.contractVersion, GENERATED_EXTENSION_API_V1)
    } finally {
      await second.ctx.fiber.dispose()
    }
    const safe = await bootSafeModeRuntime({ home })
    try {
      parse(await tool(safe.ctx, 'list_workbench', {}))
      parse(await tool(safe.ctx, 'inspect_candidate', { candidateId }))
      assert.equal(safe.ctx.tools.get('scaffold_candidate'), undefined)
    } finally {
      await safe.ctx.fiber.dispose()
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
  stampContract(ctx.candidateWorkspace, created.id)
  ctx.candidateWorkbench.writeFile(created.id, 'src/plugin.js', R0_SOURCE)
  ctx.candidateWorkbench.writeFile(created.id, 'package.json', `${JSON.stringify({ name: 'dsh-generated-r0-workbench', type: 'module', main: 'src/plugin.js' }, null, 2)}\n`)
  return created.id
}

function stampContract(workspace: { get(id: string): { manifest: { capabilities: readonly string[]; tools: readonly string[]; entryPoints: readonly string[] } }; setManifest(id: string, manifest: Record<string, unknown>): unknown }, id: string) {
  const manifest = workspace.get(id).manifest
  workspace.setManifest(id, {
    capabilities: [...manifest.capabilities],
    tools: [...manifest.tools],
    entryPoints: [...manifest.entryPoints],
    runtimeContractVersion: GENERATED_EXTENSION_API_V1,
  })
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
  stampContract(setup.workspace, created.id)
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
    { persist: options.persist, registry },
  )
  return { workbench, workspace, review, governance: root.service, registry, independent }
}

function isolatedUnavailableDiscovery(status: 'unavailable' | 'incomplete' = 'unavailable') {
  const setup = isolatedWorkbench()
  const workbench = new WorkbenchService(
    new ResolutionService(setup.registry, new CatalogDiscovery({ status })),
    setup.workspace,
    setup.workspace,
    setup.independent,
    setup.governance,
    { registry: setup.registry },
  )
  return { ...setup, workbench }
}
