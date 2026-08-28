import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { PERSONALITY_CORPUS } from '../src/domain/personality/index.js'
import { googleCalendarReadRiskModel } from '../src/domain/reliability/index.js'
import type { ResolutionReview } from '../src/domain/resolution/index.js'
import { flattenEffects, projectMissionControl, type WorkspaceSnapshotInput } from '../src/domain/workspace/index.js'
import { approvalStateOf, extensionLifecycleOf } from '../src/domain/workspace/lifecycle.js'
import { conversationWithoutReasoning, executionLogFromSession } from '../src/domain/workspace/gather.js'
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
  it('keeps only the final assistant answer in conversation and sends execution detail to the log', () => {
    const session = Session.create(SessionId('workspace-execution-log'))
    const callId = CallId('write-1')
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Build it.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'Writing the candidate now.' }], source: { provider: 'test', model: 'test' } }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'write_candidate_file', arguments: '{"path":"src/plugin.js"}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: '{"lifecycle":"developing"}' }], isError: false }),
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'Candidate implementation is complete.' }], source: { provider: 'test', model: 'test' } }),
    }, { surfaceOp: 'append' })

    assert.deepEqual(conversationWithoutReasoning(session.events), [
      { kind: 'user', text: 'Build it.' },
      { kind: 'assistant', text: 'Candidate implementation is complete.' },
    ])
    const log = executionLogFromSession(session.events)
    assert.deepEqual(log.map((entry) => entry.kind), ['agent-note', 'tool-call', 'tool-result'])
    assert.equal(log[1]?.label, 'write_candidate_file')
    assert.match(log[1]?.detail ?? '', /src\/plugin\.js/)
    assert.match(log[2]?.detail ?? '', /developing/)
  })

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

  it('projects auto-executing tasks as active while file writes stay governed', () => {
    const view = projectMissionControl(snapshot({
      integrationStatus: [
        { capability: 'tasks', available: true },
        { capability: 'files', available: true },
      ],
      autoExecuteCapabilities: ['tasks'],
    }))

    assert.ok(view.capabilities.some((item) => item.area === 'Tasks' && item.status === 'active'))
    assert.ok(view.capabilities.some((item) => item.area === 'Files' && item.status === 'approval-required'))
  })

  it('does not degrade for optional integrations that were never connected', () => {
    const view = projectMissionControl(snapshot({
      integrationStatus: [
        { capability: 'mail', available: false, configured: false, reason: 'mail is not connected' },
        { capability: 'contacts', available: false, configured: false, reason: 'contacts are not connected' },
      ],
      registry: [],
    }))

    assert.equal(view.systemState, 'READY')
    assert.equal(view.controlStrip.degradation, undefined)
    assert.ok(view.capabilities.some((item) => item.area === 'Mail' && item.status === 'not-connected'))
    assert.ok(view.capabilities.some((item) => item.area === 'Contacts' && item.status === 'not-connected'))
  })

  it('projects the live integration provider instead of the registry fixture default', () => {
    const view = projectMissionControl(snapshot({
      integrationStatus: [{ capability: 'mail', available: true, configured: true, provider: 'feishu' }],
      registry: [{
        owner: 'managed/integrations',
        version: '0.1.0',
        provenance: 'managed',
        status: 'active',
        capabilities: ['mail'],
        provider: 'fake',
      }],
    }))

    const mail = view.capabilities.find((item) => item.area === 'Mail')
    assert.equal(mail?.status, 'active')
    assert.equal(mail?.advanced?.provider, 'feishu')
  })

  it('preserves the provider for integration-only capability rows', () => {
    const view = projectMissionControl(snapshot({
      registry: [],
      integrationStatus: [{ capability: 'contacts', available: true, configured: true, provider: 'feishu' }],
    }))
    const contacts = view.capabilities.find((item) => item.area === 'Contacts')
    assert.equal(contacts?.status, 'active')
    assert.equal(contacts?.advanced?.provider, 'feishu')
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
    assert.equal(view.approvalResolutions[0]?.outcome, 'denied')
    assert.ok(view.activity.some((item) => item.source === 'approval/resolved' && item.summary.includes('denied')))
    assert.match(view.conversation.at(-1)?.text ?? '', /will not create/)
    assert.doesNotMatch(JSON.stringify(view.conversation), /Confirmation /)
    assert.equal('acknowledgement' in view, false)
    assert.equal('acknowledgement' in failed, false)
    const mixed = projectMissionControl(snapshot({
      pendingConfirmations: [{
        id: 'conf-denied',
        capability: 'calendar',
        operation: 'create_event',
        fingerprint: 'fp-cal',
        status: 'denied',
        level: 'L4',
        payload: { title: 'Dentist', start: '2026-08-25T15:00:00+08:00', end: '2026-08-25T16:00:00+08:00' },
      }],
      extensionApprovals: [{
        id: 'apr-hist',
        candidateId: 'cand-hist',
        fingerprint: 'fp-ext',
        decision: 'approved-for-exact-diff',
        owner: 'generated/hist',
        candidateVersion: '0.1.0',
        digest: 'abc',
        capabilitiesAdded: [],
        capabilitiesRemoved: [],
        permissionsAdded: [],
        permissionsRemoved: [],
        effects: [],
      }],
    }))
    assert.equal('acknowledgement' in mixed, false)
    assert.ok(mixed.approvalResolutions.some((item) => item.confirmationId === 'conf-denied' && item.outcome === 'denied'))
    assert.ok(mixed.approvalResolutions.some((item) => item.confirmationId === 'apr-hist' && item.outcome === 'completed'))
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

  it('G7. disabled exact revision stays discoverable and reactivatable', () => {
    const view = projectMissionControl(snapshot({
      candidates: [{
        id: 'generated--text-slugify@0.1.0',
        owner: 'generated/text-slugify',
        version: '0.1.0',
        digest: 'abc123',
        lifecycle: 'sealed',
        sealed: true,
        canRequestApproval: false,
        governanceApproval: 'approved-for-exact-diff',
        extensionLifecycle: 'DISABLED_REACTIVATABLE',
      }],
      extensionApprovals: [{
        id: 'apr-disabled',
        candidateId: 'generated--text-slugify@0.1.0',
        fingerprint: 'fp-disabled',
        decision: 'approved-for-exact-diff',
        owner: 'generated/text-slugify',
        candidateVersion: '0.1.0',
        digest: 'abc123',
        capabilitiesAdded: ['text.slugify'],
        capabilitiesRemoved: [],
        permissionsAdded: [],
        permissionsRemoved: [],
        effects: [],
        eligibilityOk: true,
        eligibilityDenials: [],
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
          status: 'disabled',
          capabilities: ['text.slugify'],
          tools: ['text_slugify'],
        },
      ],
    }))
    assert.equal(view.plugins.length, 0)
    assert.equal(view.extensions.length, 1)
    assert.equal(view.extensions[0]?.lifecycle, 'DISABLED_REACTIVATABLE')
    assert.equal(view.activations[0]?.status, 'DISABLED_REACTIVATABLE')
    assert.equal(view.activations[0]?.title, 'Reactivate extension')
    assert.match(renderMissionControlAsHtml(view), /data-extension-lifecycle="DISABLED_REACTIVATABLE"/)
    const superseded = projectMissionControl(snapshot({
      candidates: [{
        id: 'generated--text-slugify@0.1.0',
        owner: 'generated/text-slugify',
        version: '0.1.0',
        digest: 'abc123',
        lifecycle: 'sealed',
        sealed: true,
        canRequestApproval: false,
        governanceApproval: 'approved-for-exact-diff',
      }],
      extensionApprovals: [{
        id: 'apr-old',
        candidateId: 'generated--text-slugify@0.1.0',
        fingerprint: 'fp-old',
        decision: 'approved-for-exact-diff',
        owner: 'generated/text-slugify',
        candidateVersion: '0.1.0',
        digest: 'abc123',
        capabilitiesAdded: [],
        capabilitiesRemoved: [],
        permissionsAdded: [],
        permissionsRemoved: [],
        effects: [],
        eligibilityOk: true,
        eligibilityDenials: [],
      }],
      registry: [
        {
          owner: 'generated/text-slugify',
          version: '0.1.0',
          provenance: 'generated',
          status: 'disabled',
          capabilities: ['text.slugify'],
        },
        {
          owner: 'generated/text-slugify',
          version: '0.2.0',
          provenance: 'generated',
          status: 'active',
          capabilities: ['text.slugify'],
        },
      ],
    }))
    assert.equal(superseded.extensions[0]?.lifecycle, 'SUPERSEDED')
    assert.equal(superseded.activations.length, 0)
  })

  it('G7b. generated provenance on a non-generated owner stays visible and activatable', () => {
    const view = projectMissionControl(snapshot({
      candidates: [{
        id: 'managed--integrations@0.2.0',
        owner: 'managed/integrations',
        version: '0.2.0',
        digest: 'evo-digest',
        provenance: { kind: 'generated', origin: 'assistant' },
        lifecycle: 'sealed',
        sealed: true,
        canRequestApproval: false,
        governanceApproval: 'approved-for-exact-diff',
      }],
      extensionApprovals: [{
        id: 'apr-evo',
        candidateId: 'managed--integrations@0.2.0',
        fingerprint: 'fp-evo',
        decision: 'approved-for-exact-diff',
        owner: 'managed/integrations',
        candidateVersion: '0.2.0',
        digest: 'evo-digest',
        capabilitiesAdded: ['calendar.read'],
        capabilitiesRemoved: [],
        permissionsAdded: [],
        permissionsRemoved: [],
        effects: [],
        eligibilityOk: true,
        eligibilityDenials: [],
      }],
    }))
    const row = view.extensions.find((item) => item.owner === 'managed/integrations' && item.version === '0.2.0')
    assert.ok(row)
    assert.equal(row.lifecycle, 'APPROVED_NOT_ACTIVE')
    assert.equal(row.provenance, 'generated')
    assert.equal(row.provenanceOrigin, 'assistant')
    assert.equal(view.activations.some((item) => item.candidateId === row.candidateId), true)
  })

  it('G7c. approval projection keeps the real decision for blocked and superseded states', () => {
    const cases: readonly {
      readonly name: string
      readonly input: Parameters<typeof extensionLifecycleOf>[0]
      readonly lifecycle: ReturnType<typeof extensionLifecycleOf>
      readonly approval: ReturnType<typeof approvalStateOf>
    }[] = [
      { name: 'never-active approved', input: { decision: 'approved-for-exact-diff' }, lifecycle: 'APPROVED_NOT_ACTIVE', approval: 'approved' },
      { name: 'active approved', input: { registryStatus: 'active', decision: 'approved-for-exact-diff' }, lifecycle: 'ACTIVE', approval: 'active' },
      { name: 'disabled reactivatable', input: { registryStatus: 'disabled', decision: 'approved-for-exact-diff' }, lifecycle: 'DISABLED_REACTIVATABLE', approval: 'approved' },
      { name: 'disabled rejected', input: { registryStatus: 'disabled', decision: 'approval-rejected' }, lifecycle: 'DISABLED_BLOCKED', approval: 'not-ready' },
      { name: 'disabled missing approval', input: { registryStatus: 'disabled' }, lifecycle: 'DISABLED_BLOCKED', approval: 'not-ready' },
      { name: 'explicit superseded', input: { decision: 'superseded', registryStatus: 'disabled' }, lifecycle: 'SUPERSEDED', approval: 'not-ready' },
      { name: 'retired keeps approved fact', input: { registryStatus: 'retired', decision: 'approved-for-exact-diff' }, lifecycle: 'SUPERSEDED', approval: 'approved' },
      { name: 'newer authoritative', input: { registryStatus: 'disabled', decision: 'approved-for-exact-diff', newerAuthoritative: true }, lifecycle: 'SUPERSEDED', approval: 'approved' },
      { name: 'active plus superseded is fail-closed', input: { registryStatus: 'active', decision: 'superseded' }, lifecycle: 'SUPERSEDED', approval: 'not-ready' },
    ]
    for (const item of cases) {
      const lifecycle = extensionLifecycleOf(item.input)
      assert.equal(lifecycle, item.lifecycle, item.name)
      assert.equal(approvalStateOf(lifecycle, item.input.decision), item.approval, item.name)
    }
  })

  it('G6. READY-state projects a system rollback card only when LKG differs', () => {
    const none = projectMissionControl(snapshot())
    assert.equal(none.rollback, undefined)
    const ready = projectMissionControl(snapshot({
      activation: {
        state: 'active',
        generation: 5,
        mounted: ['generated--text-slugify@0.1.0'],
        current: {
          generation: 5,
          mounted: ['generated--text-slugify@0.1.0'],
          owners: [
            { owner: 'managed/integrations', version: '0.1.0' },
            { owner: 'generated/text-slugify', version: '0.1.0' },
          ],
        },
        rollbackTarget: {
          generation: 4,
          mounted: [],
          owners: [{ owner: 'managed/integrations', version: '0.1.0' }],
        },
        rollbackPlan: {
          id: 'rollback-5-4',
          currentGeneration: 5,
          targetGeneration: 4,
          fingerprint: 'authoritative-rollback-plan',
          available: true,
          denials: [],
        },
      },
      registry: [
        {
          owner: 'managed/integrations',
          version: '0.1.0',
          provenance: 'managed',
          status: 'active',
          capabilities: ['calendar.read'],
          tools: ['calendar_list_events'],
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
    assert.equal(ready.systemState, 'READY')
    assert.ok(ready.rollback)
    assert.equal(ready.rollback?.title, 'Rollback system state')
    assert.equal(ready.rollback?.currentGeneration, 5)
    assert.equal(ready.rollback?.targetGeneration, 4)
    assert.ok(ready.rollback?.ownerChanges.some((item) => item.owner === 'generated/text-slugify' && item.change === 'disable'))
    assert.ok(ready.rollback?.toolsRemoved.includes('text_slugify'))
    assert.match(renderMissionControlAsHtml(ready), /data-rollback-id=/)
    const recovering = projectMissionControl(snapshot({
      safeMode: true,
      recoveryRequired: true,
      recoveryWhy: 'integrity failure',
      activation: {
        state: 'safe-mode',
        generation: 5,
        current: {
          generation: 5,
          owners: [{ owner: 'managed/integrations', version: '0.1.0' }],
        },
        rollbackTarget: {
          generation: 4,
          owners: [{ owner: 'managed/integrations', version: '0.1.0' }, { owner: 'generated/text-slugify', version: '0.1.0' }],
        },
      },
    }))
    assert.equal(recovering.systemState === 'SAFE_MODE' || recovering.systemState === 'RECOVERY', true)
    assert.equal(recovering.rollback, undefined)
    assert.ok(recovering.recovery)
    const unverified = projectMissionControl(snapshot({
      activation: {
        state: 'active',
        generation: 5,
        current: {
          generation: 5,
          owners: [
            { owner: 'managed/integrations', version: '0.1.0' },
            { owner: 'generated/text-slugify', version: '0.1.0' },
          ],
        },
        rollbackTarget: {
          generation: 4,
          owners: [{ owner: 'managed/integrations', version: '0.1.0' }],
        },
        rollbackPlan: {
          id: 'rollback-5-4',
          currentGeneration: 5,
          targetGeneration: 4,
          fingerprint: 'stale',
          available: false,
          denials: [{ reason: 'digest-mismatch', detail: 'generated/text-slugify@0.1.0' }],
        },
      },
    }))
    assert.equal(unverified.rollback, undefined)
  })

  it('G3. activation failure stays visible after a successful rollback', () => {
    const view = projectMissionControl(snapshot({
      activation: {
        state: 'activation-failed',
        generation: 4,
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
    const retry = view.activations.find((item) => item.candidateId === 'cand-obsidian')
    assert.ok(retry)
    assert.equal(retry.status, 'ACTIVATION_FAILED')
    assert.equal(retry.id, 'act-retry-apr-2-4-health')
    assert.equal(retry.title, 'Retry activation')
    assert.equal(retry.eligibilityOk, true)
    assert.equal(view.activationFailure?.phase, 'health')
    assert.equal(view.activationFailure?.rollbackSucceeded, true)
    assert.equal(view.activationFailure?.registryActive, false)
    assert.ok(view.activity.some((item) => item.kind === 'FAILED' && item.summary.includes('health')))
    assert.match(renderMissionControlAsText(view), /ACTIVATION FAILED/)
    assert.match(renderMissionControlAsHtml(view), /data-activation-failed="true"/)
    assert.match(renderMissionControlAsHtml(view), /data-activation-id="act-retry-apr-2-4-health"/)
    const nextAttempt = projectMissionControl(snapshot({
      activation: {
        state: 'activation-failed',
        generation: 5,
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
    assert.equal(nextAttempt.activations[0]?.id, 'act-retry-apr-2-5-health')
    assert.notEqual(nextAttempt.activations[0]?.id, retry.id)

    const blocked = projectMissionControl(snapshot({
      recoveryRequired: true,
      activation: {
        state: 'activation-failed',
        lastFailureCandidateId: 'cand-obsidian',
        lastFailure: {
          candidateId: 'cand-obsidian',
          phase: 'commit',
          diagnostics: 'authority commit failed',
          rollbackSucceeded: false,
          safeModeRequired: true,
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
        capabilitiesAdded: [],
        capabilitiesRemoved: [],
        permissionsAdded: [],
        permissionsRemoved: [],
        effects: [],
        eligibilityOk: true,
        eligibilityDenials: [],
      }],
    }))
    assert.equal(blocked.activations.length, 0)
    assert.equal(blocked.activationFailure?.recoveryRequired, true)

    const stale = projectMissionControl(snapshot({
      activation: {
        state: 'activation-failed',
        lastFailureCandidateId: 'cand-obsidian',
        lastFailure: {
          candidateId: 'cand-obsidian',
          phase: 'prepare',
          diagnostics: 'digest drifted',
          rollbackSucceeded: true,
          safeModeRequired: false,
        },
      },
      extensionApprovals: [{
        id: 'apr-2',
        candidateId: 'cand-obsidian',
        fingerprint: 'fp-old',
        decision: 'approved-for-exact-diff',
        owner: 'generated/obsidian-vault',
        candidateVersion: '0.1.0',
        digest: 'old-digest',
        capabilitiesAdded: [],
        capabilitiesRemoved: [],
        permissionsAdded: [],
        permissionsRemoved: [],
        effects: [],
        eligibilityOk: false,
        eligibilityDenials: ['digest-mismatch'],
      }],
    }))
    assert.equal(stale.activations.length, 0)
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

  it('marks Safe Mode ready to exit after recovery is complete', () => {
    const entered = projectMissionControl(snapshot({ safeMode: true, recoveryRequired: false }))
    assert.equal(entered.recovery?.exitReady, false)
    const view = projectMissionControl(snapshot({
      safeMode: true,
      recoveryRequired: false,
      activation: {
        state: 'safe-mode',
        rollbackPlan: {
          id: 'rollback-10-7',
          currentGeneration: 10,
          targetGeneration: 7,
          fingerprint: 'verified-rollback',
          available: false,
          denials: [{ reason: 'already-restored', detail: 'current owner set already matches the rollback target' }],
        },
      },
    }))
    assert.equal(view.recovery?.exitReady, true)
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
        kind: 'new-plugin',
        capability: 'calendar.read',
        need: 'Google Calendar read with declared oauth scope',
        recommendation: 'new plugin',
        rationale: 'independent generated owner',
        implications: [],
        assumptions: [],
        unresolved: [],
        steps: [],
        registryFacts: { exact: { kind: 'unknown', capability: 'calendar.read' }, domainOwners: [], conflicts: [] },
      }
      const created = ctx.candidateWorkspace.create({
        review,
        owner: 'generated/calendar-secret-probe',
        version: '0.1.0',
        manifest: {
          capabilities: ['calendar.read', 'calendar.freebusy'],
          permissions: ['host.text.echo'],
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

  it('projects Skill lifecycle facts without instruction bodies', () => {
    const view = projectMissionControl(snapshot({
      skills: [{
        id: 'weekly-review@1.0.0',
        name: 'weekly-review',
        version: '1.0.0',
        profile: 'assistant',
        provenance: 'third-party',
        origin: 'import',
        lifecycle: 'active',
        sealed: true,
        modelInvocable: true,
        userInvocable: true,
        description: 'Guide a weekly review with sk-secretvalue123',
        resources: ['references/notes.md'],
        validationPassed: true,
        reviewComplete: true,
        digest: 'deadbeefdeadbeef',
        dependsOn: [],
        dependents: [],
        system: false,
        generation: 0,
      }],
      skillEvents: [{
        id: 'evt-activate',
        kind: 'activate',
        name: 'weekly-review',
        version: '1.0.0',
      }],
    }))
    assert.ok(view.activity.some((item) => item.summary === 'Skill weekly-review@1.0.0 activate' && item.source === 'skill.lifecycle'))
    assert.doesNotMatch(view.activity.map((item) => item.summary).join('\n'), /Use recall_memory|instruction/)
    assert.doesNotMatch(view.skills?.[0]?.description ?? '', /sk-secretvalue123/)
  })
})
