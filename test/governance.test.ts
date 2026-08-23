import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CandidateService } from '../src/domain/candidate/index.js'
import {
  ActivationDeniedError,
  GovernanceAuthorityError,
  GovernanceContractError,
  InMemoryActivationRuntime,
  RecoveryRoot,
  TrustedAuthorityCredential,
} from '../src/domain/governance/index.js'
import {
  InMemoryRegistryPersistence,
  RegistryService,
  bootstrapCoreInventory,
} from '../src/domain/registry/index.js'
import type { ResolutionReview } from '../src/domain/resolution/index.js'
import * as candidatePlugin from '../src/plugins/candidate-plugin.js'
import * as governancePlugin from '../src/plugins/governance-plugin.js'
import * as registryPlugin from '../src/plugins/registry-plugin.js'
import { bootAssistantControl, bootSafeModeRuntime } from '../src/runtime/boot.js'

function review(overrides: Partial<ResolutionReview> = {}): ResolutionReview {
  return {
    kind: 'evolve-owner',
    capability: 'calendar.read',
    need: 'richer calendar filtering',
    recommendation: 'evolve managed/integrations',
    rationale: 'owned',
    implications: [],
    assumptions: [],
    unresolved: [],
    steps: [],
    registryFacts: { exact: { kind: 'unknown', capability: 'calendar.read' }, domainOwners: [], conflicts: [] },
    target: { owner: 'managed/integrations', version: '0.1.0' },
    ...overrides,
  }
}

function seeded(runtime = new InMemoryActivationRuntime()) {
  const registry = new RegistryService(new InMemoryRegistryPersistence())
  bootstrapCoreInventory((input) => registry.register(input))
  const workspace = new CandidateService(registry, mkdtempSync(path.join(tmpdir(), 'dsh-gov-')))
  const root = new RecoveryRoot(registry, workspace, runtime)
  const human = root.issueAuthority({ kind: 'human-control', source: 'application-ui' })
  return { registry, workspace, governance: root.service, root, human, runtime }
}

async function listCalendar(ctx: Context) {
  const result = await ctx.tools.execute({
    callId: CallId(`cal-${Math.random().toString(16).slice(2)}`),
    name: 'calendar_list_events',
    arguments: {
      from: '2026-08-21T00:00:00.000Z',
      to: '2026-08-23T00:00:00.000Z',
      limit: 1,
    },
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(result.isError, false, String(result.value))
  return JSON.parse(String(result.value)) as { source?: string; items?: { title?: string }[] }
}

function ready(
  workspace: CandidateService,
  input: { owner?: string; version?: string; permissions?: string[]; capabilities?: string[] } = {},
) {
  const candidate = workspace.create({
    review: input.owner?.startsWith('generated/')
      ? review({ kind: 'new-plugin', capability: 'matter.light.set', need: 'matter', target: undefined })
      : review(),
    owner: input.owner ?? 'managed/integrations',
    version: input.version ?? '0.2.0',
    baseVersion: input.owner?.startsWith('generated/') ? undefined : '0.1.0',
    manifest: {
      capabilities: input.capabilities ?? ['calendar.read', 'calendar.freebusy'],
      permissions: input.permissions ?? ['local.fake.suite'],
      runtimeSeams: ['integrations.calendar'],
      tools: ['calendar_list_events'],
    },
  })
  workspace.writeFile(candidate.id, 'src/ok.ts', 'export const value: string = "ok"\n')
  workspace.validate(candidate.id)
  return workspace.seal(candidate.id)
}

describe('extension governance and recovery', () => {
  it('A. denies activation without approval', async () => {
    const { registry, workspace, governance, root, human } = seeded()
    const candidate = ready(workspace)
    const before = registry.get('managed/integrations', '0.1.0')
    const gate = governance.eligibility(candidate.id)
    assert.equal(gate.ok, false)
    assert.ok(gate.denials.some((item) => item.reason === 'approval-required'))
    await assert.rejects(() => root.activate(candidate.id, human), ActivationDeniedError)
    assert.deepEqual(registry.get('managed/integrations', '0.1.0'), before)
  })

  it('B. accepts trusted approval for the exact digest and diff', () => {
    const { workspace, governance, human } = seeded()
    const candidate = ready(workspace)
    const requested = governance.requestApproval(candidate.id)
    const approved = governance.recordApproval(human, {
      candidateId: candidate.id,
      fingerprint: requested.fingerprint,
      decision: 'approved-for-exact-diff',
    })
    assert.equal(approved.decision, 'approved-for-exact-diff')
    assert.equal(approved.authority?.source, 'application-ui')
    const gate = governance.eligibility(candidate.id)
    assert.equal(gate.ok, true)
    assert.equal(gate.fingerprint, requested.fingerprint)
  })

  it('C. treats a changed candidate digest as a stale approval', () => {
    const { workspace, governance, human } = seeded()
    const candidate = workspace.create({
      review: review(),
      owner: 'managed/integrations',
      version: '0.2.0',
      baseVersion: '0.1.0',
      manifest: { capabilities: ['calendar.read'] },
    })
    workspace.writeFile(candidate.id, 'src/ok.ts', 'export const value: string = "ok"\n')
    workspace.validate(candidate.id)
    const fingerprint = governance.requestApproval(candidate.id).fingerprint
    governance.recordApproval(human, { candidateId: candidate.id, fingerprint, decision: 'approved-for-exact-diff' })
    workspace.writeFile(candidate.id, 'src/ok.ts', 'export const value: string = "changed"\n')
    workspace.validate(candidate.id)
    workspace.seal(candidate.id)
    const gate = governance.eligibility(candidate.id)
    assert.equal(gate.ok, false)
    assert.ok(gate.denials.some((item) => item.reason === 'approval-stale'))
  })

  it('D. does not let an old approval authorize a permission expansion', () => {
    const { workspace, governance, human } = seeded()
    const first = ready(workspace, { version: '0.2.0', permissions: ['local.fake.suite'] })
    const firstFp = governance.requestApproval(first.id).fingerprint
    governance.recordApproval(human, { candidateId: first.id, fingerprint: firstFp, decision: 'approved-for-exact-diff' })
    const expanded = ready(workspace, {
      version: '0.3.0',
      permissions: ['local.fake.suite', 'local.fake.calendar.freebusy'],
    })
    assert.throws(() => governance.recordApproval(human, {
      candidateId: expanded.id,
      fingerprint: firstFp,
      decision: 'approved-for-exact-diff',
    }))
    const gate = governance.eligibility(expanded.id)
    assert.equal(gate.ok, false)
    assert.ok(gate.denials.some((item) => item.reason === 'approval-required'))
  })

  it('E. rejects self-approval and forged authority', () => {
    const { workspace, governance } = seeded()
    const candidate = ready(workspace)
    assert.throws(() => governance.recordUntrustedApproval({ approved: true, authority: 'human' }), GovernanceAuthorityError)
    assert.throws(() => governance.recordApproval(
      { authority: { kind: 'human-control', source: 'application-ui' }, issuedBy: () => true } as unknown as TrustedAuthorityCredential,
      { candidateId: candidate.id, fingerprint: 'forged', decision: 'approved-for-exact-diff' },
    ), GovernanceAuthorityError)
  })

  it('F. upgrades an owner transactionally after trusted approval', async () => {
    const { registry, workspace, governance, root, human } = seeded()
    const candidate = ready(workspace)
    const fingerprint = governance.requestApproval(candidate.id).fingerprint
    root.recordApproval(human, { candidateId: candidate.id, fingerprint, decision: 'approved-for-exact-diff' })
    const before = governance.status()
    assert.ok(before.lastKnownGood?.owners.some((item) => item.owner === 'managed/integrations' && item.version === '0.1.0'))
    const after = await root.activate(candidate.id, human)
    assert.equal(after.state, 'active')
    assert.equal(registry.get('managed/integrations', '0.1.0')?.status, 'disabled')
    assert.equal(registry.get('managed/integrations', '0.2.0')?.status, 'active')
    assert.equal(registry.resolveActiveOwner('calendar.read').kind, 'owner')
    const owner = registry.resolveActiveOwner('calendar.read')
    assert.equal(owner.kind, 'owner')
    if (owner.kind === 'owner') assert.equal(owner.record.version, '0.2.0')
    assert.ok(after.lastKnownGood?.owners.some((item) => item.version === '0.2.0'))
    assert.ok(after.rollbackTarget?.owners.some((item) => item.version === '0.1.0'))
    assert.notEqual(after.current?.generation, after.rollbackTarget?.generation)
  })

  it('G. rolls back a failed health check before commit', async () => {
    const runtime = new InMemoryActivationRuntime()
    runtime.failHealth = true
    const { registry, workspace, governance, root, human } = seeded(runtime)
    const candidate = ready(workspace)
    const fingerprint = governance.requestApproval(candidate.id).fingerprint
    root.recordApproval(human, { candidateId: candidate.id, fingerprint, decision: 'approved-for-exact-diff' })
    const status = await root.activate(candidate.id, human)
    assert.equal(status.state, 'activation-failed')
    assert.equal(status.lastFailure?.phase, 'health')
    assert.equal(status.lastFailure?.rollbackSucceeded, true)
    assert.equal(registry.get('managed/integrations', '0.1.0')?.status, 'active')
    assert.equal(registry.get('managed/integrations', '0.2.0'), undefined)
    assert.ok(status.lastKnownGood?.owners.some((item) => item.version === '0.1.0'))
  })

  it('H. restores the previous LKG after a committed activation', async () => {
    const { registry, workspace, governance, root, human } = seeded()
    const candidate = ready(workspace)
    const fingerprint = governance.requestApproval(candidate.id).fingerprint
    root.recordApproval(human, { candidateId: candidate.id, fingerprint, decision: 'approved-for-exact-diff' })
    await root.activate(candidate.id, human)
    const restored = await root.rollback(human)
    assert.equal(restored.state, 'rolled-back')
    assert.equal(registry.get('managed/integrations', '0.1.0')?.status, 'active')
    assert.equal(registry.get('managed/integrations', '0.2.0')?.status, 'disabled')
    assert.equal(registry.conflicts().length, 0)
  })

  it('H2. verified rollback resolves recoveryRequired without dropping lastFailure', async () => {
    const { registry, workspace, governance, root, human } = seeded()
    const candidate = ready(workspace, {
      owner: 'generated/matter-home',
      version: '0.1.0',
      capabilities: ['matter.light.set'],
    })
    const fingerprint = governance.requestApproval(candidate.id).fingerprint
    root.recordApproval(human, { candidateId: candidate.id, fingerprint, decision: 'approved-for-exact-diff' })
    await root.activate(candidate.id, human)
    rmSync(candidate.workspaceRoot, { recursive: true, force: true })
    const diagnostics = await root.remountCommittedGenerated()
    assert.equal(diagnostics.some((item) => item.includes('missing-active-artifact')), true)
    const failed = root.inspect()
    assert.equal(failed.safeMode, true)
    assert.equal(failed.recoveryRequired, true)
    assert.equal(failed.integrityVerified, false)
    assert.match(failed.lastFailure?.diagnostics ?? '', /missing-active-artifact/)
    assert.throws(() => root.exitSafeMode(human), GovernanceContractError)
    const restored = await root.rollback(human)
    assert.equal(restored.integrityVerified, true)
    assert.equal(restored.recoveryRequired, false)
    assert.equal(restored.safeMode, true)
    assert.match(restored.lastFailure?.diagnostics ?? '', /missing-active-artifact/)
    const exited = root.exitSafeMode(human)
    assert.equal(exited.safeMode, false)
    assert.equal(exited.recoveryRequired, false)
    assert.notEqual(exited.state, 'safe-mode')
    assert.match(exited.lastFailure?.diagnostics ?? '', /missing-active-artifact/)
    assert.equal(registry.get('generated/matter-home', '0.1.0')?.status, 'disabled')
  })

  it('I. enters Safe Mode without the generated extension', async () => {
    const { registry, workspace, governance, root, human } = seeded()
    const candidate = ready(workspace, {
      owner: 'generated/matter-home',
      version: '0.1.0',
      capabilities: ['matter.light.set'],
    })
    const fingerprint = governance.requestApproval(candidate.id).fingerprint
    root.recordApproval(human, { candidateId: candidate.id, fingerprint, decision: 'approved-for-exact-diff' })
    await root.activate(candidate.id, human)
    assert.equal(registry.get('generated/matter-home', '0.1.0')?.status, 'active')
    const safe = root.enterSafeMode(human)
    assert.equal(safe.safeMode, true)
    assert.equal(registry.get('generated/matter-home', '0.1.0')?.status, 'disabled')
    assert.equal(registry.get('managed/integrations', '0.1.0')?.status, 'active')
    assert.ok(governance.inspect().lastKnownGood)
    const again = ready(workspace, { owner: 'generated/matter-other', version: '0.1.0', capabilities: ['matter.light.set'] })
    const fp = governance.requestApproval(again.id).fingerprint
    root.recordApproval(human, { candidateId: again.id, fingerprint: fp, decision: 'approved-for-exact-diff' })
    assert.ok(governance.eligibility(again.id).denials.some((item) => item.reason === 'safe-mode'))
  })

  it('J. rejects attempts to rewrite the recovery root', () => {
    const { governance, root } = seeded()
    assert.throws(() => governance.rewriteRecoveryRoot(), GovernanceAuthorityError)
    assert.throws(() => root.issueAuthority({ kind: 'assistant' } as never), GovernanceAuthorityError)
    assert.equal('issueAuthority' in governance, false)
  })

  it('K. never leaves two active owners after a prepare failure', async () => {
    const runtime = new InMemoryActivationRuntime()
    runtime.failPrepare = true
    const { registry, workspace, governance, root, human } = seeded(runtime)
    const candidate = ready(workspace)
    const fingerprint = governance.requestApproval(candidate.id).fingerprint
    root.recordApproval(human, { candidateId: candidate.id, fingerprint, decision: 'approved-for-exact-diff' })
    await root.activate(candidate.id, human)
    assert.equal(registry.get('managed/integrations', '0.1.0')?.status, 'active')
    assert.equal(registry.list({ owner: 'managed/integrations', status: 'active' }).length, 1)
    assert.equal(registry.conflicts().length, 0)
  })

  it('L. keeps Registry and runtime unchanged after approval alone', () => {
    const { registry, workspace, governance, human } = seeded()
    const before = registry.get('managed/integrations', '0.1.0')
    const candidate = ready(workspace)
    const fingerprint = governance.requestApproval(candidate.id).fingerprint
    governance.recordApproval(human, { candidateId: candidate.id, fingerprint, decision: 'approved-for-exact-diff' })
    assert.deepEqual(registry.get('managed/integrations', '0.1.0'), before)
    assert.equal(registry.get('managed/integrations', '0.2.0'), undefined)
    assert.equal(governance.status().state, 'idle')
  })
})

describe('governance plugin', () => {
  it('exposes inspect/request tools and keeps approval off the model path', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(registryPlugin)
    await ctx.plugin(candidatePlugin, { workspaceRoot: mkdtempSync(path.join(tmpdir(), 'dsh-gov-plug-')) })
    await ctx.plugin(governancePlugin)
    try {
      assert.ok(ctx.extensionGovernance)
      assert.ok(ctx.extensionActivation)
      assert.ok(ctx.extensionRecovery)
      assert.equal('issueAuthority' in ctx.extensionRecovery, false)
      assert.equal(ctx.get('recoveryRoot'), undefined)
      assert.throws(() => ctx.extensionGovernance.recordUntrustedApproval({ approved: true }), GovernanceAuthorityError)
      const listed = await ctx.tools.execute({
        callId: CallId('test-request-approval-tool'),
        name: 'request_extension_approval',
        arguments: { candidateId: 'missing' },
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(listed.isError, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ordinary plugin on shared ctx cannot mint trusted authority', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl()
    try {
      let sawMint = false
      await ctx.plugin({
        name: 'ordinary-self-extension',
        inject: ['extensionRecovery', 'extensionActivation', 'extensionGovernance'],
        apply(scope: Context) {
          assert.equal('issueAuthority' in scope.extensionRecovery, false)
          assert.equal('activate' in scope.extensionActivation, false)
          assert.equal(scope.get('recoveryRoot'), undefined)
          assert.equal(typeof (scope.extensionRecovery as { issueAuthority?: unknown }).issueAuthority, 'undefined')
          sawMint = typeof (scope.extensionRecovery as { issueAuthority?: unknown }).issueAuthority === 'function'
        },
      })
      assert.equal(sawMint, false)
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
      assert.equal(human.authority.kind, 'human-control')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('activates the candidate artifact itself, not an adapter probe', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl()
    try {
      const unique = 'candidate_unique_surface'
      assert.equal(ctx.tools.get(unique), undefined)
      const candidate = ctx.candidateWorkspace.create({
        review: review({
          kind: 'new-plugin',
          capability: 'matter.light.set',
          need: 'unique candidate surface',
          target: undefined,
        }),
        owner: 'generated/unique-surface',
        version: '0.1.0',
        manifest: {
          capabilities: ['matter.light.set'],
          tools: [unique],
          entryPoints: ['src/plugin.js'],
        },
      })
      ctx.candidateWorkspace.writeFile(candidate.id, 'package.json', `${JSON.stringify({
        name: 'dsh-candidate-unique-surface',
        type: 'module',
        main: 'src/plugin.js',
      }, null, 2)}\n`)
      ctx.candidateWorkspace.writeFile(candidate.id, 'src/plugin.js', `export const name = 'generated-unique-surface'
export const inject = ['tools']
export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: '${unique}',
    description: 'Surface registered only by this sealed candidate.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: String(value) }] },
    },
    async execute() { return 'from-candidate-source' },
  })
  ctx.effect(() => dispose)
}
`)
      ctx.candidateValidation.validate(candidate.id)
      const sealed = ctx.candidateWorkspace.seal(candidate.id)
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
      const fingerprint = ctx.extensionGovernance.requestApproval(sealed.id).fingerprint
      recoveryRoot.recordApproval(human, { candidateId: sealed.id, fingerprint, decision: 'approved-for-exact-diff' })
      const after = await recoveryRoot.activate(sealed.id, human)
      assert.equal(after.state, 'active')
      assert.ok(ctx.tools.get(unique), 'candidate source must register the unique tool')
      assert.equal(ctx.tools.get(`activated__${sealed.id.replaceAll(/[^A-Za-z0-9_]/g, '_')}`), undefined)
      const restored = await recoveryRoot.rollback(human)
      assert.equal(restored.state, 'rolled-back')
      assert.equal(ctx.tools.get(unique), undefined)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not treat a swapped owner as healthy unless the candidate produces the surface', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl()
    try {
      assert.ok(ctx.tools.get('calendar_list_events'))
      const candidate = ctx.candidateWorkspace.create({
        review: review(),
        owner: 'managed/integrations',
        version: '0.2.0',
        baseVersion: '0.1.0',
        provenance: { kind: 'managed', origin: 'human' },
        manifest: {
          capabilities: ['calendar.read', 'calendar.freebusy'],
          permissions: ['local.fake.suite'],
          runtimeSeams: ['integrations.calendar'],
          tools: ['calendar_list_events'],
          entryPoints: ['src/plugin.js'],
        },
      })
      ctx.candidateWorkspace.writeFile(candidate.id, 'package.json', `${JSON.stringify({
        name: 'dsh-candidate-calendar-evolve',
        type: 'module',
        main: 'src/plugin.js',
      }, null, 2)}\n`)
      ctx.candidateWorkspace.writeFile(candidate.id, 'src/plugin.js', `export const name = 'candidate-without-new-surface'
export function apply() {}
`)
      ctx.candidateValidation.validate(candidate.id)
      const sealed = ctx.candidateWorkspace.seal(candidate.id)
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
      const fingerprint = ctx.extensionGovernance.requestApproval(sealed.id).fingerprint
      recoveryRoot.recordApproval(human, { candidateId: sealed.id, fingerprint, decision: 'approved-for-exact-diff' })
      const status = await recoveryRoot.activate(sealed.id, human)
      assert.equal(status.state, 'activation-failed')
      assert.equal(status.lastFailure?.phase, 'health')
      assert.match(status.lastFailure?.diagnostics ?? '', /missing after candidate mount|already present/)
      assert.ok(ctx.tools.get('calendar_list_events'))
      const restoredPage = await listCalendar(ctx)
      assert.equal(restoredPage.items[0]?.title, 'Team standup')
      assert.equal(ctx.capabilityRegistry.get('managed/integrations', '0.1.0')?.status, 'active')
      assert.equal(ctx.capabilityRegistry.get('managed/integrations', '0.2.0'), undefined)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('swaps managed/integrations 0.1.0 to 0.2.0 and restores the old implementation', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl()
    try {
      const before = await listCalendar(ctx)
      assert.equal(before.items[0]?.title, 'Team standup')
      const candidate = ctx.candidateWorkspace.create({
        review: review(),
        owner: 'managed/integrations',
        version: '0.2.0',
        baseVersion: '0.1.0',
        provenance: { kind: 'managed', origin: 'human' },
        manifest: {
          capabilities: ['calendar.read', 'calendar.freebusy'],
          permissions: ['local.fake.suite'],
          runtimeSeams: ['integrations.calendar'],
          tools: ['calendar_list_events'],
          entryPoints: ['src/plugin.js'],
        },
      })
      ctx.candidateWorkspace.writeFile(candidate.id, 'package.json', `${JSON.stringify({
        name: 'dsh-candidate-integrations-0.2.0',
        type: 'module',
        main: 'src/plugin.js',
      }, null, 2)}\n`)
      ctx.candidateWorkspace.writeFile(candidate.id, 'src/plugin.js', `export const name = 'managed-integrations-0.2.0'
export const inject = ['tools']
export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'calendar_list_events',
    description: 'Evolved calendar list from managed/integrations@0.2.0.',
    parameters: {
      from: { type: 'string', required: true },
      to: { type: 'string', required: true },
      limit: { type: 'integer' },
      cursor: { type: 'string' },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: String(value) }] },
    },
    async execute() {
      return JSON.stringify({
        source: 'managed/integrations@0.2.0',
        items: [{ id: 'evt-evolved', title: 'Evolved calendar view' }],
      })
    },
  })
  ctx.effect(() => dispose)
}
`)
      ctx.candidateValidation.validate(candidate.id)
      const sealed = ctx.candidateWorkspace.seal(candidate.id)
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
      const fingerprint = ctx.extensionGovernance.requestApproval(sealed.id).fingerprint
      recoveryRoot.recordApproval(human, { candidateId: sealed.id, fingerprint, decision: 'approved-for-exact-diff' })
      const after = await recoveryRoot.activate(sealed.id, human)
      assert.equal(after.state, 'active')
      assert.equal(ctx.capabilityRegistry.get('managed/integrations', '0.1.0')?.status, 'disabled')
      assert.equal(ctx.capabilityRegistry.get('managed/integrations', '0.2.0')?.status, 'active')
      const evolved = await listCalendar(ctx)
      assert.equal(evolved.source, 'managed/integrations@0.2.0')
      assert.equal(evolved.items[0]?.title, 'Evolved calendar view')
      const restored = await recoveryRoot.rollback(human)
      assert.equal(restored.state, 'rolled-back')
      assert.equal(ctx.capabilityRegistry.get('managed/integrations', '0.1.0')?.status, 'active')
      assert.equal(ctx.capabilityRegistry.get('managed/integrations', '0.2.0')?.status, 'disabled')
      const rolled = await listCalendar(ctx)
      assert.equal(rolled.items[0]?.title, 'Team standup')
      assert.notEqual(rolled.source, 'managed/integrations@0.2.0')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

const failingGenerated = {
  name: 'generated-optional-fail',
  async apply() {
    throw new Error('generated extension exploded')
  },
}

describe('safe mode bootstrap', () => {
  it('full product fails if a generated optional extension throws', async () => {
    const { ctx } = await bootAssistantControl()
    try {
      await assert.rejects(async () => {
        await ctx.plugin(failingGenerated)
      }, /generated extension exploded/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('Safe Mode boots recovery without loading the failed generated extension', async () => {
    const { ctx, recoveryRoot } = await bootSafeModeRuntime()
    try {
      assert.ok(ctx.tools.get('inspect_extension_governance'))
      assert.ok(ctx.tools.get('request_extension_approval'))
      assert.ok(ctx.capabilityRegistry)
      assert.ok(ctx.extensionRecovery.inspect())
      assert.equal(ctx.tools.get('calendar_list_events'), undefined)
      assert.equal(ctx.get('assistantJobs'), undefined)
      assert.equal(ctx.get('personalMemory'), undefined)
      assert.equal('issueAuthority' in ctx.extensionRecovery, false)
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'recovery-root' })
      const safe = recoveryRoot.enterSafeMode(human)
      assert.equal(safe.safeMode, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
