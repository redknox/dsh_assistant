import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PERSONALITY_CORPUS } from '../src/domain/personality/index.js'
import { googleCalendarReadRiskModel } from '../src/domain/reliability/index.js'
import type { ResolutionReview } from '../src/domain/resolution/index.js'
import { flattenEffects, projectMissionControl, type WorkspaceSnapshotInput } from '../src/domain/workspace/index.js'
import { bootAssistantControl, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'
import { renderMissionControlAsHtml, renderMissionControlAsText } from '../src/ui/mission-control.js'

function snapshot(overrides: Partial<WorkspaceSnapshotInput> = {}): WorkspaceSnapshotInput {
  return {
    agentStatus: 'idle',
    safeMode: false,
    recoveryRequired: false,
    pendingConfirmations: [],
    jobs: [],
    toolEvents: [],
    conversation: [],
    integrationStatus: [{ capability: 'calendar', available: true }],
    registry: [
      {
        owner: 'managed/integrations',
        version: '0.1.0',
        provenance: 'managed',
        status: 'active',
        capabilities: ['calendar.read', 'calendar.create'],
      },
    ],
    memory: [{ id: 'm1', topicKey: 'briefing', statement: 'Prefers a short morning brief', status: 'active', origin: 'personal-memory' }],
    knowledge: [{ sourceUri: 'fixtures/office-hours.md', title: 'Office hours' }],
    personality: { humor: 60, directness: 85, initiative: 80, verbosity: 'adaptive', humorSuppressed: false },
    ...overrides,
  }
}

describe('TARS-NG mission-control workspace', () => {
  it('A. shows today context and a concise objective without fake progress', () => {
    const view = projectMissionControl(snapshot({
      objective: { text: 'What matters today?', status: 'active' },
      conversation: [{ kind: 'user', text: 'What matters today?' }, { kind: 'assistant', text: 'Finance review at 10:00. Dentist is unconfirmed.' }],
    }))
    assert.equal(view.identity, 'TARS-NG')
    assert.equal(view.systemState, 'READY')
    assert.equal(view.objective?.text, 'What matters today?')
    assert.match(renderMissionControlAsText(view), /What matters today/)
    assert.match(renderMissionControlAsHtml(view), /id="context"/)
    assert.equal(view.developmentControlPlaneSeparated, true)
  })

  it('B. keeps the skeptical-partner preferred shape out of generic flattery', () => {
    const scenario = PERSONALITY_CORPUS.find((item) => item.id === 'architecture-flaw')
    assert.ok(scenario)
    const view = projectMissionControl(snapshot({
      conversation: [{ kind: 'user', text: scenario.prompt }, { kind: 'assistant', text: scenario.preferred }],
    }))
    assert.match(view.conversation[1]?.text ?? '', /second authority system/)
    assert.doesNotMatch(view.conversation[1]?.text ?? '', /wonderful idea/i)
  })

  it('C. calendar read is activity without an approval card', () => {
    const view = projectMissionControl(snapshot({
      conversation: [{ kind: 'user', text: 'Am I free tomorrow afternoon?' }],
      toolEvents: [
        { type: 'tool/call', name: 'calendar_list_events', text: '{}', seq: 1 },
        { type: 'tool/result', name: 'calendar_list_events', text: '3 events', isError: false, seq: 2 },
        { type: 'tool/call', name: 'calendar_freebusy', text: '{}', seq: 3 },
        { type: 'tool/result', name: 'calendar_freebusy', text: 'free', isError: false, seq: 4 },
      ],
    }))
    assert.equal(view.systemState, 'READY')
    assert.equal(view.approvals.length, 0)
    assert.ok(view.activity.some((item) => item.summary.includes('3 events found')))
    assert.ok(view.activity.some((item) => item.summary.includes('Free/busy')))
    assert.ok(view.capabilities.some((item) => item.area === 'Calendar' && item.action === 'Read schedule' && item.status === 'active'))
    assert.equal(view.capabilities.filter((item) => item.area === 'Calendar').length, 2)
    assert.equal(view.capabilities.some((item) => item.action === 'Find free time'), false)
    assert.ok(view.capabilities.some((item) => item.area === 'Calendar' && item.action === 'Create event' && item.status === 'approval-required'))
  })

  it('does not treat registry-active calendar as connected when the provider is down', () => {
    const view = projectMissionControl(snapshot({
      integrationStatus: [{ capability: 'calendar', available: false, reason: 'not configured' }],
    }))
    const calendar = view.capabilities.filter((item) => item.area === 'Calendar')
    assert.equal(calendar.length, 2)
    assert.equal(calendar.every((item) => item.status === 'unavailable'), true)
  })

  it('D. calendar create is a first-class approval object', () => {
    const view = projectMissionControl(snapshot({
      pendingConfirmations: [{
        id: 'conf-1',
        capability: 'calendar',
        operation: 'create_event',
        fingerprint: 'fp-cal',
        status: 'pending',
        level: 'L4',
        payload: {
          title: 'Dentist',
          start: '2026-08-25T15:00:00+08:00',
          end: '2026-08-25T16:00:00+08:00',
          timeZone: 'Asia/Shanghai',
          calendarId: 'Personal',
        },
      }],
    }))
    assert.equal(view.systemState, 'NEEDS_APPROVAL')
    const card = view.approvals[0]
    assert.equal(card?.kind, 'calendar-create')
    assert.match(card?.details.join('\n') ?? '', /Dentist/)
    assert.equal(card?.sideEffect, 'yes')
    assert.equal(card?.authorityChange, 'none')
    assert.match(renderMissionControlAsHtml(view), /CREATE CALENDAR EVENT/)
  })

  it('E. denied approval stays calm and does not re-queue the action', () => {
    const view = projectMissionControl(snapshot({
      pendingConfirmations: [{
        id: 'conf-denied',
        capability: 'calendar',
        operation: 'create_event',
        fingerprint: 'fp-cal',
        status: 'denied',
        level: 'L4',
        payload: { title: 'Dentist', start: '2026-08-25T15:00:00+08:00', end: '2026-08-25T16:00:00+08:00' },
      }],
      conversation: [{ kind: 'assistant', text: 'Cancelled. I will not create the event unless you ask again.' }],
    }))
    assert.equal(view.systemState, 'READY')
    assert.equal(view.controlStrip.pendingApprovals, 0)
    const failed = projectMissionControl(snapshot({
      pendingConfirmations: [{
        id: 'conf-failed',
        capability: 'calendar',
        operation: 'create_event',
        fingerprint: 'fp-cal',
        status: 'failed',
        level: 'L2',
        payload: { title: '给妈妈打电话', start: '2026-08-23T20:30:00+08:00', end: '2026-08-23T21:00:00+08:00' },
      }],
    }))
    assert.equal(failed.approvals[0]?.status, 'failed')
    assert.equal(failed.approvals[0]?.kind, 'calendar-create')
    assert.match(view.conversation.at(-1)?.text ?? '', /will not create/)
  })

  it('F. provider degradation is a product state, not theater', () => {
    const view = projectMissionControl(snapshot({
      integrationStatus: [{ capability: 'calendar', available: false, reason: 'rate-limited' }],
    }))
    assert.equal(view.systemState, 'DEGRADED')
    assert.match(view.controlStrip.degradation ?? '', /calendar/)
    assert.doesNotMatch(renderMissionControlAsText(view), /sparkle|thinking\.\.\./i)
  })

  it('G. Self-Extension approval shows capability/permission/effect diff', () => {
    const view = projectMissionControl(snapshot({
      extensionApprovals: [{
        id: 'apr-1',
        candidateId: 'cand-obsidian',
        fingerprint: 'fp-ext',
        decision: 'approval-requested',
        owner: 'generated/obsidian-vault',
        candidateVersion: '0.1.0',
        digest: 'abc123',
        capabilitiesAdded: ['obsidian.read'],
        capabilitiesRemoved: [],
        permissionsAdded: ['files.read'],
        permissionsRemoved: [],
        effects: ['vault read'],
      }],
    }))
    const card = view.approvals.find((item) => item.kind === 'self-extension')
    assert.ok(card)
    assert.equal(card.candidateId, 'cand-obsidian')
    assert.match(card.details.join('\n'), /obsidian.read/)
    assert.match(card.details.join('\n'), /not self-authorization/)
    assert.match(card.authorityChange, /human approval/)
  })

  it('G2. approved Self-Extension projects an Activation Card without claiming NOT APPROVED', () => {
    const view = projectMissionControl(snapshot({
      extensionApprovals: [{
        id: 'apr-2',
        candidateId: 'cand-obsidian',
        fingerprint: 'fp-ext',
        decision: 'approved-for-exact-diff',
        owner: 'generated/obsidian-vault',
        candidateVersion: '0.1.0',
        digest: 'abc123',
        capabilitiesAdded: [],
        capabilitiesRemoved: [],
        capabilitiesChanged: ['obsidian.read'],
        permissionsAdded: [],
        permissionsRemoved: [],
        permissionsChanged: ['files.read'],
        effects: ['vault read'],
        toolsAdded: [],
        toolsRemoved: [],
        toolsChanged: ['obsidian_read'],
        runtimeContractVersion: 'generated-extension-api/v1',
        eligibilityOk: true,
        eligibilityDenials: [],
      }],
      candidates: [{
        id: 'cand-obsidian',
        owner: 'generated/obsidian-vault',
        version: '0.1.0',
        lifecycle: 'sealed',
        sealed: true,
        reviewState: 'review-complete',
        canRequestApproval: false,
        currentStep: 'approved',
        approvalState: 'approved',
        governanceApproval: 'approved-for-exact-diff',
        activationState: 'inactive',
        extensionLifecycle: 'APPROVED_NOT_ACTIVE',
      }],
    }))
    assert.equal(view.approvals.some((item) => item.kind === 'self-extension'), false)
    const card = view.activations.find((item) => item.candidateId === 'cand-obsidian')
    assert.ok(card)
    assert.equal(card.status, 'APPROVED_NOT_ACTIVE')
    assert.deepEqual(card.capabilitiesChanged, ['obsidian.read'])
    assert.deepEqual(card.permissionsChanged, ['files.read'])
    assert.deepEqual(card.toolsChanged, ['obsidian_read'])
    assert.match(card.details.join('\n'), /~obsidian\.read/)
    assert.match(card.details.join('\n'), /~obsidian_read/)
    assert.match(card.details.join('\n'), /~files\.read/)
    assert.doesNotMatch(card.details.join('\n'), /Capabilities none/)
    assert.match(card.details.join('\n'), /did not activate/)
    assert.doesNotMatch(JSON.stringify(view), /NOT APPROVED/)
    const text = renderMissionControlAsText(view)
    assert.match(text, /activation-request/)
    assert.match(renderMissionControlAsHtml(view), /data-activation-id="apr-2"/)
  })

  it('G4. stale exact-diff evidence is not projected as APPROVED_NOT_ACTIVE', () => {
    const stale = projectMissionControl(snapshot({
      extensionApprovals: [{
        id: 'apr-stale',
        candidateId: 'cand-stale',
        fingerprint: 'fp-old',
        decision: 'approved-for-exact-diff',
        owner: 'generated/obsidian-vault',
        candidateVersion: '0.1.0',
        digest: 'old-digest',
        capabilitiesAdded: [],
        capabilitiesRemoved: [],
        capabilitiesChanged: ['obsidian.read'],
        permissionsAdded: [],
        permissionsRemoved: [],
        effects: [],
        eligibilityOk: false,
        eligibilityDenials: ['digest-mismatch'],
      }],
    }))
    assert.equal(stale.activations.length, 0)
    assert.doesNotMatch(JSON.stringify(stale), /APPROVED_NOT_ACTIVE/)

    for (const reason of ['base-changed', 'review-required', 'review-changes-required'] as const) {
      const retired = projectMissionControl(snapshot({
        extensionApprovals: [{
          id: `apr-${reason}`,
          candidateId: `cand-${reason}`,
          fingerprint: 'fp-old',
          decision: 'approved-for-exact-diff',
          owner: 'generated/obsidian-vault',
          candidateVersion: '0.1.0',
          digest: 'old-digest',
          capabilitiesAdded: ['obsidian.read'],
          capabilitiesRemoved: [],
          permissionsAdded: [],
          permissionsRemoved: [],
          effects: [],
          eligibilityOk: false,
          eligibilityDenials: [reason],
        }],
      }))
      assert.equal(retired.activations.length, 0, reason)
      assert.doesNotMatch(JSON.stringify(retired), /APPROVED_NOT_ACTIVE/)
    }

    const conflict = projectMissionControl(snapshot({
      extensionApprovals: [{
        id: 'apr-conflict',
        candidateId: 'cand-conflict',
        fingerprint: 'fp-ext',
        decision: 'approved-for-exact-diff',
        owner: 'generated/obsidian-vault',
        candidateVersion: '0.1.0',
        digest: 'abc123',
        capabilitiesAdded: ['obsidian.read'],
        capabilitiesRemoved: [],
        permissionsAdded: [],
        permissionsRemoved: [],
        effects: [],
        eligibilityOk: false,
        eligibilityDenials: ['ownership-conflict'],
      }],
    }))
    assert.equal(conflict.activations[0]?.status, 'APPROVED_NOT_ACTIVE')
    assert.equal(conflict.activations[0]?.eligibilityOk, false)

    const safeMode = projectMissionControl(snapshot({
      safeMode: true,
      extensionApprovals: [{
        id: 'apr-safe',
        candidateId: 'cand-safe',
        fingerprint: 'fp-ext',
        decision: 'approved-for-exact-diff',
        owner: 'generated/obsidian-vault',
        candidateVersion: '0.1.0',
        digest: 'abc123',
        capabilitiesAdded: ['obsidian.read'],
        capabilitiesRemoved: [],
        permissionsAdded: [],
        permissionsRemoved: [],
        effects: [],
        eligibilityOk: false,
        eligibilityDenials: ['safe-mode'],
      }],
    }))
    const card = safeMode.activations.find((item) => item.candidateId === 'cand-safe')
    assert.ok(card)
    assert.equal(card.status, 'APPROVED_NOT_ACTIVE')
    assert.equal(card.eligibilityOk, false)
    assert.deepEqual(card.eligibilityDenials, ['safe-mode'])
  })

  it('G5. READY-state user plugins project a trash uninstall action', () => {
    const plugins = projectMissionControl(snapshot({
      activation: { state: 'active', generation: 4, mounted: ['generated--text-slugify@0.1.0'] },
      candidates: [{
        id: 'generated--text-slugify@0.1.0',
        owner: 'generated/text-slugify',
        version: '0.1.0',
        digest: 'abc123',
        lifecycle: 'sealed',
        sealed: true,
        canRequestApproval: false,
      }],
      registry: [
        {
          owner: 'managed/integrations',
          version: '0.1.0',
          provenance: 'managed',
          status: 'active',
          capabilities: ['calendar.read'],
        },
        {
          owner: 'generated/text-slugify',
          version: '0.1.0',
          provenance: 'generated',
          status: 'active',
          capabilities: ['text.slugify'],
          tools: ['text_slugify'],
        },
      ],
    }))
    assert.equal(plugins.systemState, 'READY')
    assert.equal(plugins.plugins.length, 1)
    assert.equal(plugins.plugins[0]?.owner, 'generated/text-slugify')
    assert.equal(plugins.plugins[0]?.uninstallable, true)
    assert.equal(plugins.plugins.some((item) => item.owner.startsWith('managed/')), false)
    assert.match(renderMissionControlAsText(plugins), /generated\/text-slugify@0.1.0/)
    assert.match(renderMissionControlAsHtml(plugins), /data-plugin-id="uninst-generated\/text-slugify@0.1.0"/)
  })

  it('G3. activation failure stays visible after a successful rollback', () => {
    const view = projectMissionControl(snapshot({
      activation: {
        state: 'activation-failed',
        lastFailureCandidateId: 'cand-obsidian',
        lastFailure: {
          candidateId: 'cand-obsidian',
          phase: 'health',
          diagnostics: 'post-activation health verification failed',
          rollbackSucceeded: true,
          safeModeRequired: false,
        },
      },
      extensionApprovals: [{
        id: 'apr-2',
        candidateId: 'cand-obsidian',
        fingerprint: 'fp-ext',
        decision: 'approved-for-exact-diff',
        owner: 'generated/obsidian-vault',
        candidateVersion: '0.1.0',
        digest: 'abc123',
        capabilitiesAdded: ['obsidian.read'],
        capabilitiesRemoved: [],
        permissionsAdded: [],
        permissionsRemoved: [],
        effects: [],
      }],
    }))
    assert.equal(view.activations.length, 0)
    assert.equal(view.activationFailure?.phase, 'health')
    assert.equal(view.activationFailure?.rollbackSucceeded, true)
    assert.equal(view.activationFailure?.registryActive, false)
    assert.ok(view.activity.some((item) => item.kind === 'FAILED' && item.summary.includes('health')))
    assert.match(renderMissionControlAsText(view), /ACTIVATION FAILED/)
    assert.match(renderMissionControlAsHtml(view), /data-activation-failed="true"/)
  })

  it('H. Safe Mode is a dedicated comprehensible product state', () => {
    const view = projectMissionControl(snapshot({
      safeMode: true,
      recoveryRequired: true,
      recoveryWhy: 'Generated Calendar artifact failed integrity verification.',
      registry: [{
        owner: 'generated/google-calendar',
        version: '0.1.0',
        provenance: 'generated',
        status: 'active',
        capabilities: ['calendar.read'],
      }],
    }))
    assert.equal(view.systemState, 'SAFE_MODE')
    assert.ok(view.recovery)
    assert.match(view.recovery?.why ?? '', /integrity/)
    assert.equal(view.personality.humorSuppressed, true)
    assert.match(renderMissionControlAsHtml(view), /data-system-state="SAFE_MODE"/)
    assert.ok(view.capabilities.some((item) => item.status === 'safe-mode-disabled'))
  })

  it('I. personality tuning previews behavior without granting authority', () => {
    const view = projectMissionControl(snapshot({
      personality: { humor: 20, directness: 95, initiative: 80, verbosity: 'concise', humorSuppressed: false },
    }))
    assert.equal(view.personality.humor, 20)
    assert.equal(view.personality.directness, 95)
    assert.equal(view.developmentControlPlaneSeparated, true)
  })

  it('J. serious context keeps chain-of-thought out of activity', () => {
    const view = projectMissionControl(snapshot({
      blockedReason: 'Recovery root rewrite was refused.',
      conversation: [{ kind: 'assistant', text: 'No. Recovery stays in the trusted control plane.' }],
    }))
    assert.equal(view.systemState, 'BLOCKED')
    assert.equal(view.activity.every((item) => !/hidden reasoning|chain-of-thought/i.test(item.summary)), true)
    assert.match(renderMissionControlAsHtml(view), /data-control-plane="user-workspace"/)
  })

  it('includes secret-access metadata and redacts credential values', () => {
    const effects = flattenEffects({
      filesystem: [],
      network: ['https://www.googleapis.com/calendar/v3'],
      process: [],
      secrets: ['google.calendar.oauth', 'ya29.not-a-real-token'],
      externalSystems: ['google-calendar-v3'],
    }, ['google.calendar.oauth'])
    assert.ok(effects.some((item) => item === 'secret-access google.calendar.oauth'))
    assert.ok(effects.some((item) => item === 'secret-access (redacted)'))
    assert.equal(effects.some((item) => item.includes('ya29')), false)
  })

  it('projects secret-access effects from a live governance summary without secret values', async () => {
    const { ctx } = await bootAssistantControl()
    const handle = await createAssistantAgent(ctx, 'ws-secret-approval')
    try {
      const review: ResolutionReview = {
        kind: 'evolve-owner',
        capability: 'calendar.read',
        need: 'Google Calendar read with declared oauth scope',
        recommendation: 'evolve managed/integrations',
        rationale: 'owned',
        implications: [],
        assumptions: [],
        unresolved: [],
        steps: [],
        registryFacts: { exact: { kind: 'unknown', capability: 'calendar.read' }, domainOwners: [], conflicts: [] },
        target: { owner: 'managed/integrations', version: '0.1.0' },
      }
      const created = ctx.candidateWorkspace.create({
        review,
        owner: 'managed/integrations',
        version: '0.2.0',
        baseVersion: '0.1.0',
        manifest: {
          capabilities: ['calendar.read', 'calendar.freebusy'],
          permissions: ['local.fake.suite'],
          secrets: ['google.calendar.oauth'],
          effects: {
            filesystem: [],
            network: ['https://www.googleapis.com/calendar/v3'],
            process: [],
            secrets: ['google.calendar.oauth', 'ya29.not-a-real-token'],
            externalSystems: ['google-calendar-v3'],
            remoteSideEffect: 'read-only',
          },
          riskModel: googleCalendarReadRiskModel(),
        },
      })
      ctx.candidateWorkspace.writeFile(created.id, 'src/ok.ts', 'export const value: string = "ok"\n')
      ctx.candidateValidation.validate(created.id)
      const sealed = ctx.candidateWorkspace.seal(created.id)
      ctx.independentReview.reviewCandidate(sealed.id)
      const requested = ctx.extensionGovernance.requestApproval(sealed.id)
      assert.equal(requested.decision, 'approval-requested')
      assert.ok(ctx.extensionGovernance.inspectSummary(sealed.id).effects.secrets.includes('google.calendar.oauth'))

      const ui = new AssistantControlSurface(ctx, 'ws-secret-approval')
      const view = ui.workspace()
      const card = view.approvals.find((item) => item.kind === 'self-extension')
      assert.ok(card)
      const rendered = [card.sideEffect, ...card.details, renderMissionControlAsText(view), renderMissionControlAsHtml(view)].join('\n')
      assert.match(rendered, /secret-access google\.calendar\.oauth/)
      assert.doesNotMatch(rendered, /ya29\.not-a-real-token/)
      assert.doesNotMatch(rendered, /ya29\.|Bearer |access_token=|refresh_token=|client_secret=/)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })
})
