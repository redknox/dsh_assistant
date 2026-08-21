import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PERSONALITY_CORPUS } from '../src/domain/personality/index.js'
import { projectMissionControl, type WorkspaceSnapshotInput } from '../src/domain/workspace/index.js'
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
    assert.match(card.details.join('\n'), /obsidian.read/)
    assert.match(card.details.join('\n'), /not self-authorization/)
    assert.match(card.authorityChange, /human approval/)
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
})
