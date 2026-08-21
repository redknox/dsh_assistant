import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { ActivationDeniedError } from '../src/domain/governance/index.js'
import { googleCalendarReadRiskModel, googleCalendarWriteRiskModel } from '../src/domain/reliability/index.js'
import { CORE_KNOWN_SEAMS } from '../src/domain/resolution/index.js'
import { bootAssistantControl, bootSafeModeRuntime } from '../src/runtime/boot.js'

const root = join(import.meta.dirname, '..')
const candidateSource = join(root, 'fixtures/self-extension/google-calendar-candidate')
const CALENDAR_NEED = 'Inspect my Google Calendar, find free time, propose an event, and create it only under the correct write authority.'
const GOOGLE_ORIGIN = 'https://www.googleapis.com/calendar/v3'
const RANGE = { from: '2026-08-21T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z' }
const READ_CAPABILITIES = ['calendar.events.list', 'calendar.event.read', 'calendar.freebusy.read']
const READ_PERMISSIONS = ['google.calendar.events.read', 'google.calendar.freebusy.read']
const WRITE_CAPABILITIES = [...READ_CAPABILITIES, 'calendar.events.create']
const WRITE_PERMISSIONS = [...READ_PERMISSIONS, 'google.calendar.events.create']

function copyCandidateSources(workspace: { writeFile(id: string, path: string, content: string): unknown }, id: string) {
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const relative = prefix === '' ? entry : `${prefix}/${entry}`
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, relative)
      else workspace.writeFile(id, relative, readFileSync(full, 'utf8'))
    }
  }
  walk(candidateSource, '')
}

function googleProviders() {
  return [{
    provider: 'google',
    seam: 'integrations.calendar',
    capabilities: [...WRITE_CAPABILITIES, 'calendar.read'],
    domains: ['calendar'],
  }]
}

function reviewGoogle(ctx: { capabilityResolution: { review(input: object): { kind: string; target?: { owner?: string; seam?: string; provider?: string } } } }) {
  return ctx.capabilityResolution.review({
    capability: 'calendar.read',
    need: CALENDAR_NEED,
    knownProviders: googleProviders(),
    inventory: { complete: true, seams: CORE_KNOWN_SEAMS },
  })
}

function readManifest() {
  return {
    capabilities: READ_CAPABILITIES,
    permissions: READ_PERMISSIONS,
    runtimeSeams: ['integrations.calendar'],
    tools: ['google_calendar_provider'],
    secrets: ['google.calendar.oauth'],
    configRequired: ['googleCalendarMode'],
    effects: { filesystem: [], network: [GOOGLE_ORIGIN], process: [], secrets: ['google.calendar.oauth'] },
    entryPoints: ['src/plugin.js'],
    riskModel: googleCalendarReadRiskModel(),
  }
}

async function tool(ctx: { tools: { execute(input: unknown): Promise<{ isError: boolean; value?: unknown }> } }, name: string, args: Record<string, unknown>) {
  const result = await ctx.tools.execute({
    callId: CallId(`gcal-${name}-${Math.random().toString(16).slice(2)}`),
    name,
    arguments: args,
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(result.isError, false, String(result.value))
  return JSON.parse(String(result.value))
}

function assertNoSecretValue(text: string) {
  assert.doesNotMatch(text, /ya29\.|Bearer |access_token=|refresh_token=|client_secret=/)
}

async function activateReadOnly(ctx: Awaited<ReturnType<typeof bootAssistantControl>>['ctx'], recoveryRoot: Awaited<ReturnType<typeof bootAssistantControl>>['recoveryRoot']) {
  const review = reviewGoogle(ctx)
  assert.equal(review.kind, 'implement-provider')
  const created = ctx.candidateWorkspace.create({
    review,
    owner: 'generated/google-calendar',
    version: '0.1.0',
    manifest: readManifest(),
  })
  copyCandidateSources(ctx.candidateWorkspace, created.id)
  const report = ctx.candidateValidation.validate(created.id)
  assert.equal(report.passed, true, report.stages.map((item) => `${item.name}:${item.status}`).join(', '))
  const sealed = ctx.candidateWorkspace.seal(created.id)
  const summary = ctx.extensionGovernance.inspectSummary(sealed.id)
  const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
  const requested = ctx.extensionGovernance.requestApproval(sealed.id)
  recoveryRoot.recordApproval(human, {
    candidateId: sealed.id,
    fingerprint: requested.fingerprint,
    decision: 'approved-for-exact-diff',
  })
  const activated = await recoveryRoot.activate(sealed.id, human)
  assert.equal(activated.state, 'active', activated.lastFailure?.diagnostics ?? activated.state)
  return { sealed, human, review, fingerprint: requested.fingerprint, summary }
}

describe('Calendar Self-Extension vertical slice', () => {
  it('A. inspects the existing calendar seam and selects implement-provider, not a parallel plugin', async () => {
    const { ctx } = await bootAssistantControl()
    try {
      const reuse = ctx.capabilityResolution.review({
        capability: 'calendar.read',
        need: 'list events through the existing fake calendar provider',
      })
      assert.equal(reuse.kind, 'reuse')
      assert.equal(reuse.target?.owner, 'managed/integrations')
      const review = reviewGoogle(ctx)
      assert.equal(review.kind, 'implement-provider')
      assert.equal(review.target?.owner, 'managed/integrations')
      assert.equal(review.target?.seam, 'integrations.calendar')
      assert.equal(review.target?.provider, 'google')
      assert.equal(review.steps.some((item) => item.option === 'new-plugin' && item.verdict === 'accepted'), false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('B/D/G/H/J/L. activates a read-only Google provider behind the existing calendar tools', async () => {
    const previous = process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN
    process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN = 'ya29.should-never-be-persisted'
    process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_MODE = 'fixture'
    const { ctx, recoveryRoot } = await bootAssistantControl()
    try {
      const before = await tool(ctx, 'calendar_list_events', RANGE)
      assert.equal(before.items[0]?.title, 'Team standup')

      const { human, summary } = await activateReadOnly(ctx, recoveryRoot)
      assert.deepEqual(summary.secrets, ['google.calendar.oauth'])
      assert.deepEqual(summary.effects.network, [GOOGLE_ORIGIN])
      assert.ok(summary.permissions.added.includes('google.calendar.events.read'))
      assert.equal(summary.permissions.added.includes('google.calendar.events.create'), false)
      assertNoSecretValue(JSON.stringify(summary))

      const identity = await tool(ctx, 'google_calendar_provider', {})
      assert.equal(identity.provider, 'google')
      assert.equal(identity.seam, 'integrations.calendar')
      assert.equal(identity.transport, 'host-managed')
      assert.equal(identity.allowCreate, false)
      assert.equal(identity.credential, 'injected')
      assert.equal(Object.hasOwn(identity, 'token'), false)

      const listed = await tool(ctx, 'calendar_list_events', RANGE)
      assert.equal(listed.items.some((item: { title: string }) => item.title === 'Google standup'), true)
      assert.equal(listed.items.some((item: { title: string }) => item.title === 'Team standup'), false)

      const one = await tool(ctx, 'calendar_get_event', { id: 'gcal-allday' })
      assert.equal(one.allDay, true)
      assert.equal(one.start, '2026-08-22')

      const dst = await tool(ctx, 'calendar_get_event', { id: 'gcal-dst' })
      assert.equal(dst.timeZone, 'America/New_York')
      assert.equal(dst.start, '2026-03-08T06:30:00.000Z')

      const busy = await tool(ctx, 'calendar_freebusy', RANGE)
      assert.ok(busy.items.some((item: { busy: boolean }) => item.busy === true))

      const proposal = await tool(ctx, 'calendar_propose_event', {
        title: 'Focus',
        start: '2026-08-22T14:00:00.000Z',
        end: '2026-08-22T15:00:00.000Z',
        timeZone: 'UTC',
        calendarId: 'primary',
        attendees: ['ada@example.com'],
        description: 'Deep work',
      })
      assert.equal(proposal.trust, 'propose')
      assert.match(proposal.summary, /Focus/)
      assert.match(proposal.summary, /primary/)
      assert.deepEqual(proposal.draft.attendees, ['ada@example.com'])
      const afterPropose = await ctx.integrations.hub.calendar().listEvents(RANGE)
      assert.equal(afterPropose.items.some((item) => item.title === 'Focus'), false)

      await assert.rejects(
        () => ctx.integrations.hub.calendar().createEvent({
          title: 'Focus',
          start: '2026-08-22T14:00:00.000Z',
          end: '2026-08-22T15:00:00.000Z',
          timeZone: 'UTC',
        }),
        /not authorized/,
      )

      const durableText = JSON.stringify(ctx.capabilityRegistry.get('generated/google-calendar', '0.1.0'))
      assertNoSecretValue(durableText)
      for (const source of ['src/plugin.js', 'src/provider.js', 'src/google-event.js']) {
        const text = readFileSync(join(candidateSource, source), 'utf8')
        assertNoSecretValue(text)
        assert.doesNotMatch(text, /\bfetch\s*\(|node:http|node:https|https\.request/)
      }

      const rolled = await recoveryRoot.rollback(human)
      assert.equal(rolled.state, 'rolled-back')
      assert.equal(ctx.capabilityRegistry.get('generated/google-calendar', '0.1.0')?.status, 'disabled')
      assert.equal(ctx.tools.get('google_calendar_provider'), undefined)
      const restored = await tool(ctx, 'calendar_list_events', RANGE)
      assert.equal(restored.items[0]?.title, 'Team standup')
    } finally {
      if (previous === undefined) delete process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN
      else process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN = previous
      delete process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_MODE
      await ctx.fiber.dispose()
    }
  })

  it('C/E/F. write expansion needs a new approval and creates one idempotent event', async () => {
    const { ctx, recoveryRoot } = await bootAssistantControl()
    try {
      const { human } = await activateReadOnly(ctx, recoveryRoot)
      const writeReview = ctx.capabilityResolution.review({
        capability: 'calendar.events.create',
        need: 'create a Google Calendar event after a side-effect-free proposal',
        behavior: 'event-create',
        alreadySatisfied: false,
        knownProviders: googleProviders(),
      })
      const created = ctx.candidateWorkspace.create({
        review: writeReview,
        owner: 'generated/google-calendar',
        version: '0.2.0',
        baseVersion: '0.1.0',
        manifest: {
          ...readManifest(),
          capabilities: WRITE_CAPABILITIES,
          permissions: WRITE_PERMISSIONS,
          riskModel: googleCalendarWriteRiskModel(),
        },
      })
      copyCandidateSources(ctx.candidateWorkspace, created.id)
      ctx.candidateWorkspace.writeFile(
        created.id,
        'src/plugin.js',
        readFileSync(join(candidateSource, 'src/plugin.js'), 'utf8').replace('const ALLOW_CREATE = false', 'const ALLOW_CREATE = true'),
      )
      ctx.candidateValidation.validate(created.id)
      const sealed = ctx.candidateWorkspace.seal(created.id)
      const summary = ctx.extensionGovernance.inspectSummary(sealed.id)
      assert.ok(summary.capabilities.added.includes('calendar.events.create'))
      assert.ok(summary.permissions.added.includes('google.calendar.events.create'))
      assert.ok(ctx.extensionGovernance.eligibility(sealed.id).denials.length > 0)
      await assert.rejects(() => recoveryRoot.activate(sealed.id, human), ActivationDeniedError)

      const requested = ctx.extensionGovernance.requestApproval(sealed.id)
      recoveryRoot.recordApproval(human, {
        candidateId: sealed.id,
        fingerprint: requested.fingerprint,
        decision: 'approved-for-exact-diff',
      })
      const activated = await recoveryRoot.activate(sealed.id, human)
      assert.equal(activated.state, 'active', activated.lastFailure?.diagnostics ?? activated.state)
      assert.equal((await tool(ctx, 'google_calendar_provider', {})).allowCreate, true)

      const event = {
        title: 'Focus',
        start: '2026-08-22T14:00:00.000Z',
        end: '2026-08-22T15:00:00.000Z',
        timeZone: 'UTC',
        calendarId: 'primary',
        attendees: ['ada@example.com'],
        description: 'Deep work',
        idempotencyKey: 'op-focus-1',
      }
      const pending = await tool(ctx, 'calendar_create_event', event)
      assert.equal(pending.kind, 'pending_confirmation')
      const approved = await tool(ctx, 'confirm_action', { confirmationId: pending.confirmationId, decision: 'approve' })
      assert.equal(approved.kind, 'allow')
      const createdOnce = approved.result as { id: string; title: string; timeZone?: string; attendees?: string[] }
      assert.equal(createdOnce.title, 'Focus')
      assert.equal(createdOnce.timeZone, 'UTC')
      assert.deepEqual(createdOnce.attendees, ['ada@example.com'])

      const again = await ctx.integrations.hub.calendar().createEvent(event)
      assert.equal(again.id, createdOnce.id)
      const listed = await ctx.integrations.hub.calendar().listEvents(RANGE)
      assert.equal(listed.items.filter((item) => item.title === 'Focus').length, 1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('K. remounts only committed Calendar authority after restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gcal-restart-'))
    const first = await bootAssistantControl({ home })
    try {
      await activateReadOnly(first.ctx, first.recoveryRoot)
      assert.ok(first.ctx.tools.get('google_calendar_provider'))
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.ctx.capabilityRegistry.get('generated/google-calendar', '0.1.0')?.status, 'active')
      assert.ok(second.ctx.tools.get('google_calendar_provider'))
      const listed = await tool(second.ctx, 'calendar_list_events', RANGE)
      assert.equal(listed.items.some((item: { title: string }) => item.title === 'Google standup'), true)
    } finally {
      await second.ctx.fiber.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('M. Safe Mode excludes the generated Google Calendar provider', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gcal-safe-'))
    const first = await bootAssistantControl({ home })
    try {
      await activateReadOnly(first.ctx, first.recoveryRoot)
    } finally {
      await first.ctx.fiber.dispose()
    }
    const safe = await bootSafeModeRuntime({ home })
    try {
      assert.equal(safe.ctx.tools.get('google_calendar_provider'), undefined)
      assert.equal(safe.ctx.tools.get('calendar_list_events'), undefined)
      assert.ok(safe.ctx.tools.get('inspect_extension_governance'))
      assert.ok(safe.recoveryRoot)
    } finally {
      await safe.ctx.fiber.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
