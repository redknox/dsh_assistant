import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { FakeReplyAdapter } from '../src/adapters/llm/fake-reply-adapter.js'
import { googleCalendarReadRiskModel } from '../src/domain/reliability/index.js'
import type { ResolutionReview } from '../src/domain/resolution/index.js'
import { projectMissionControl } from '../src/domain/workspace/index.js'
import { bootAssistantControl, bootSafeModeRuntime, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'
import {
  originAllowed,
  resolveWebUiListen,
  assertSafePayload,
} from '../src/product/web-ui-protocol.js'
import { attachWebUiBroadcast, startWebUiServer } from '../src/product/web-ui-server.js'
import type { MissionControlView } from '../src/domain/workspace/types.js'
import { MissionControlScreen } from '../web/src/App.tsx'

function fixtureView(overrides: Partial<MissionControlView> = {}): MissionControlView {
  return {
    identity: 'TARS-NG',
    systemState: 'READY',
    conversation: [
      { kind: 'user-message', text: 'Hello **TARS-NG**' },
      { kind: 'assistant-response', text: 'Ready.' },
    ],
    activity: [{ id: 'a1', kind: 'COMPLETED', summary: 'Calendar inspected', source: 'calendar' }],
    approvals: [],
    capabilities: [{ area: 'Memory', action: 'remember', status: 'active' }],
    memory: [],
    knowledge: [],
    controlStrip: { pendingApprovals: 0, backgroundJobs: 0, mode: 'READY' },
    personality: { humor: 40, directness: 70, initiative: 50, verbosity: 'normal', humorSuppressed: false },
    developmentControlPlaneSeparated: true,
    ...overrides,
  }
}

async function withServer(
  boot: () => Promise<{ ctx: Awaited<ReturnType<typeof bootAssistantControl>>['ctx']; recoveryRoot: Awaited<ReturnType<typeof bootAssistantControl>>['recoveryRoot'] }>,
  sessionId: string,
  run: (
    url: string,
    surface: AssistantControlSurface,
    agent: Awaited<ReturnType<typeof createAssistantAgent>>,
    ctx: Awaited<ReturnType<typeof bootAssistantControl>>['ctx'],
  ) => Promise<void>,
) {
  const control = await boot()
  control.ctx.llm.registerAdapter(['fake'], new FakeReplyAdapter('ack'))
  const agent = await createAssistantAgent(control.ctx, sessionId, { provider: 'fake', model: 'fake-echo' })
  const surface = new AssistantControlSurface(control.ctx, sessionId)
  const assets = mkdtempSync(join(tmpdir(), 'tars-web-assets-'))
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>TARS-NG</title><div id="root"></div>')
  const web = await startWebUiServer({
    surface,
    recoveryRoot: control.recoveryRoot,
    diagnostics: { persistence: 'ok' },
    assetRoot: assets,
    port: 0,
  })
  const detach = attachWebUiBroadcast(control.ctx, () => web.notify())
  try {
    await run(web.url, surface, agent, control.ctx)
  } finally {
    detach()
    await web.close()
    await agent.dispose()
    await control.ctx.fiber.dispose()
  }
}

async function cookieHeader(url: string): Promise<string> {
  const res = await fetch(`${url}/api/session`)
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie()[0] : res.headers.get('set-cookie')
  assert.ok(setCookie)
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /SameSite=Strict/i)
  return setCookie.split(';')[0] ?? ''
}

function authHeaders(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie, ...extra }
}

describe('local Mission-Control Web UI', () => {
  it('binds loopback only and rejects public hosts', () => {
    assert.deepEqual(resolveWebUiListen({}), { host: '127.0.0.1', port: 8787 })
    assert.throws(() => resolveWebUiListen({ TARS_NG_UI_HOST: '0.0.0.0' }))
    assert.equal(originAllowed('https://evil.example', '127.0.0.1', 8787), false)
    assert.equal(originAllowed('http://127.0.0.1:8787', '127.0.0.1', 8787), true)
    assert.equal(originAllowed(undefined, '127.0.0.1', 8787), true)
  })

  it('refuses secret values and reasoning in UI payloads', () => {
    const env = { DEEPSEEK_API_KEY: 'sk-ui-secret-value-123456' }
    assert.throws(() => assertSafePayload(JSON.stringify({ key: 'sk-ui-secret-value-123456' }), env))
    assert.throws(() => assertSafePayload(JSON.stringify({ type: 'reasoning', text: 'hidden' })))
    assert.equal(assertSafePayload(JSON.stringify({ view: { identity: 'TARS-NG' } })), '{"view":{"identity":"TARS-NG"}}')
  })

  it('serves an authoritative snapshot, conversation, and live update', async () => {
    await withServer(bootAssistantControl, 'web-ui-ready', async (url, surface, agent) => {
      const first = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView; webUi: string }
      assert.equal(first.view.identity, 'TARS-NG')
      assert.equal(first.view.systemState, 'READY')
      assert.match(first.webUi, /^http:\/\/127\.0\.0\.1:\d+$/)
      assert.doesNotMatch(JSON.stringify(first), /reasoning_content|"type":"reasoning"/)

      const page = await fetch(`${url}/`)
      assert.equal(page.status, 200)
      assert.match(await page.text(), /TARS-NG/)

      const forbidden = await fetch(`${url}/api/view`, { headers: { origin: 'https://evil.example' } })
      assert.equal(forbidden.status, 403)

      const events = await fetch(`${url}/api/events`)
      assert.match(events.headers.get('content-type') ?? '', /text\/event-stream/)
      const reader = events.body?.getReader()
      const firstEvent = new TextDecoder().decode((await reader?.read())?.value)
      assert.match(firstEvent, /TARS-NG/)
      await reader?.cancel()

      const sent = await fetch(`${url}/api/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(await cookieHeader(url)) },
        body: JSON.stringify({ text: 'Hello from the Web UI' }),
      })
      assert.equal(sent.status, 202)
      await agent.agent.whenIdle()
      const after = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      assert.ok(after.view, JSON.stringify(after))
      assert.equal(after.view.conversation.some((item) => item.kind === 'user-message' && item.text.includes('Hello from the Web UI')), true)
      assert.equal(after.view.conversation.some((item) => item.kind === 'assistant-response' && item.text.includes('ack')), true)
      assert.equal(after.view.conversation.some((item) => item.text.includes('Current runtime context')), false)
      assert.equal(after.view.conversation.some((item) => item.text.includes('Contextual Expression')), false)
      assert.equal(surface.workspace().systemState, after.view.systemState)

      const cookie = await cookieHeader(url)
      const untrusted = await fetch(`${url}/api/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'no session' }),
      })
      assert.equal(untrusted.status, 403)

      const malformed = await fetch(`${url}/api/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ nope: true }),
      })
      assert.equal(malformed.status, 400)
      const unknown = await fetch(`${url}/api/launch-missiles`, {
        method: 'POST',
        headers: authHeaders(cookie),
        body: '{}',
      })
      assert.equal(unknown.status, 404)
    })
  })

  it('keeps read-only tools executable after Web UI broadcast is attached', async () => {
    await withServer(bootAssistantControl, 'web-ui-tools', async (_url, _surface, _agent, ctx) => {
      const listed = await ctx.tools.execute({
        callId: CallId('web-ui-list-capabilities'),
        name: 'list_capabilities',
        arguments: {},
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(listed.isError, false, String(listed.value ?? listed.content))
      assert.doesNotMatch(String(listed.value), /Cannot read properties of undefined/)

      const status = await ctx.tools.execute({
        callId: CallId('web-ui-integration-status'),
        name: 'integration_status',
        arguments: {},
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(status.isError, false, String(status.value ?? status.content))
      assert.match(String(status.value), /"trust":"read"/)
    })
  })

  it('approves and rejects through the existing policy path', async () => {
    await withServer(bootAssistantControl, 'web-ui-approve', async (url, surface, agent) => {
      const pending = surface.requestExecute('calendar', 'create_event', {
        calendarId: 'Personal',
        title: 'Team review',
        start: '2026-08-22T10:00:00+08:00',
        end: '2026-08-22T10:30:00+08:00',
        attendees: ['ada@example.com'],
      })
      assert.equal(pending.kind, 'pending_confirmation')
      if (pending.kind !== 'pending_confirmation') throw new Error('expected pending')
      const cookie = await cookieHeader(url)
      const view = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      const card = view.view.approvals.find((item) => item.id === pending.confirmationId)
      assert.equal(card?.kind, 'calendar-create')
      assert.match(card?.fingerprint ?? '', /./)
      assert.match(card?.details.join('\n') ?? '', /Team review/)

      const denied = await fetch(`${url}/api/deny`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ id: pending.confirmationId, fingerprint: card?.fingerprint }),
      }).then((res) => res.json()) as { view: MissionControlView }
      const after = denied.view.approvals.find((item) => item.id === pending.confirmationId)
      assert.equal(after?.status, 'denied')
      assert.notEqual(after?.status, 'pending')
      await agent.agent.whenIdle()
      const talked = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      assert.equal(talked.view.conversation.some((item) => item.kind === 'user-message' && item.text.includes(pending.confirmationId) && item.text.includes('deny')), true)
    })
  })

  it('cannot recover through unsupported browser-invented actions', async () => {
    const control = await bootSafeModeRuntime()
    const human = control.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
    control.recoveryRoot.enterSafeMode(human)
    const surface = new AssistantControlSurface(control.ctx, 'web-ui-safe')
    const web = await startWebUiServer({
      surface,
      recoveryRoot: control.recoveryRoot,
      port: 0,
    })
    try {
      const cookie = await cookieHeader(web.url)
      const view = await fetch(`${web.url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      assert.equal(view.view.systemState === 'SAFE_MODE' || view.view.systemState === 'RECOVERY', true)
      assert.ok(view.view.recovery)
      const untrusted = await fetch(`${web.url}/api/recovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'diagnostics' }),
      })
      assert.equal(untrusted.status, 403)
      const blocked = await fetch(`${web.url}/api/recovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ action: 'self-authorize' }),
      })
      assert.equal(blocked.status, 409)
      const unconfirmed = await fetch(`${web.url}/api/recovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ action: 'exit-safe-mode' }),
      })
      assert.equal(unconfirmed.status, 409)
      const diagnostics = await fetch(`${web.url}/api/recovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ action: 'diagnostics' }),
      })
      assert.equal(diagnostics.status, 200)
    } finally {
      await web.close()
      await control.ctx.fiber.dispose()
    }
  })

  it('completes Safe Mode recovery after verified rollback while keeping lastFailure', async () => {
    const home = mkdtempSync(join(tmpdir(), 'web-ui-recovery-loop-'))
    const control = await bootAssistantControl({ home })
    const review: ResolutionReview = {
      kind: 'new-plugin',
      capability: 'restart.probe.ping',
      need: 'web ui recovery loop',
      recommendation: 'new plugin',
      rationale: 'no owner',
      implications: [],
      assumptions: [],
      unresolved: [],
      steps: [],
      registryFacts: { exact: { kind: 'unknown', capability: 'restart.probe.ping' }, domainOwners: [], conflicts: [] },
    }
    const created = control.ctx.candidateWorkspace.create({
      review,
      owner: 'generated/restart-probe',
      version: '0.1.0',
      manifest: { capabilities: ['restart.probe.ping'], tools: ['restart_probe_ping'], entryPoints: ['src/plugin.js'] },
    })
    control.ctx.candidateWorkspace.writeFile(created.id, 'package.json', `${JSON.stringify({ name: 'dsh-generated-restart-probe', type: 'module', main: 'src/plugin.js' }, null, 2)}\n`)
    control.ctx.candidateWorkspace.writeFile(created.id, 'src/plugin.js', `export const name = 'generated-restart-probe'
export const inject = ['tools']
export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'restart_probe_ping',
    description: 'Restart durability probe',
    parameters: {},
    output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: String(value) }] } },
    async execute() { return 'pong' },
  })
  ctx.effect(() => dispose)
}
`)
    control.ctx.candidateValidation.validate(created.id)
    const sealed = control.ctx.candidateWorkspace.seal(created.id)
    const human = control.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
    const fingerprint = control.ctx.extensionGovernance.requestApproval(sealed.id).fingerprint
    control.recoveryRoot.recordApproval(human, { candidateId: sealed.id, fingerprint, decision: 'approved-for-exact-diff' })
    await control.recoveryRoot.activate(sealed.id, human)
    rmSync(sealed.workspaceRoot, { recursive: true, force: true })
    const remount = await control.recoveryRoot.remountCommittedGenerated()
    assert.equal(remount.some((item) => item.includes('missing-active-artifact')), true)
    const surface = new AssistantControlSurface(control.ctx, 'web-ui-recovery-loop')
    const web = await startWebUiServer({
      surface,
      recoveryRoot: control.recoveryRoot,
      port: 0,
    })
    try {
      const cookie = await cookieHeader(web.url)
      const before = await fetch(`${web.url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      assert.equal(before.view.systemState === 'SAFE_MODE' || before.view.systemState === 'RECOVERY', true)
      const immediate = await fetch(`${web.url}/api/recovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ action: 'exit-safe-mode', confirm: true }),
      })
      assert.equal(immediate.status, 409)
      const rolled = await fetch(`${web.url}/api/recovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ action: 'rollback', confirm: true }),
      })
      assert.equal(rolled.status, 200)
      const verified = control.recoveryRoot.inspect()
      assert.equal(verified.integrityVerified, true)
      assert.equal(verified.recoveryRequired, false)
      assert.match(verified.lastFailure?.diagnostics ?? '', /missing-active-artifact/)
      const exited = await fetch(`${web.url}/api/recovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ action: 'exit-safe-mode', confirm: true }),
      })
      assert.equal(exited.status, 200, await exited.text())
      const after = await fetch(`${web.url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      assert.notEqual(after.view.systemState, 'SAFE_MODE')
      assert.notEqual(after.view.systemState, 'RECOVERY')
      const diagnostics = await fetch(`${web.url}/api/recovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ action: 'diagnostics' }),
      }).then((res) => res.json()) as { diagnostics: { activation?: { lastFailure?: { diagnostics: string } } } }
      assert.match(JSON.stringify(diagnostics), /missing-active-artifact/)
      assert.match(control.recoveryRoot.inspect().lastFailure?.diagnostics ?? '', /missing-active-artifact/)
    } finally {
      await web.close()
      await control.ctx.fiber.dispose()
    }
  })

  it('approves and rejects a real Self-Extension candidate by candidateId and fingerprint', async () => {
    await withServer(bootAssistantControl, 'web-ui-extension', async (url, _surface, _agent, ctx) => {
      const review: ResolutionReview = {
        kind: 'evolve-owner',
        capability: 'calendar.read',
        need: 'Web UI approval path',
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
            secrets: ['google.calendar.oauth'],
            externalSystems: ['google-calendar-v3'],
            remoteSideEffect: 'read-only',
          },
          riskModel: googleCalendarReadRiskModel(),
        },
      })
      ctx.candidateWorkspace.writeFile(created.id, 'src/ok.ts', 'export const value: string = "ok"\n')
      ctx.candidateValidation.validate(created.id)
      const sealed = ctx.candidateWorkspace.seal(created.id)
      const requested = ctx.extensionGovernance.requestApproval(sealed.id)
      const cookie = await cookieHeader(url)
      const view = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      const card = view.view.approvals.find((item) => item.kind === 'self-extension')
      assert.ok(card)
      assert.equal(card.candidateId, sealed.id)
      assert.equal(card.id, requested.id)
      assert.notEqual(card.id, sealed.id)
      assert.equal(card.fingerprint, requested.fingerprint)
      assert.ok(card.digest)

      const stale = await fetch(`${url}/api/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ id: card.id, candidateId: card.candidateId, fingerprint: 'stale-fp' }),
      })
      assert.equal(stale.status, 409)
      const unknown = await fetch(`${url}/api/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ id: 'apr-missing', candidateId: 'missing', fingerprint: card.fingerprint }),
      })
      assert.equal(unknown.status, 409)
      const wrongId = await fetch(`${url}/api/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ id: card.id, candidateId: card.id, fingerprint: card.fingerprint }),
      })
      assert.equal(wrongId.status, 409)

      const rejected = await fetch(`${url}/api/deny`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ id: card.id, candidateId: card.candidateId, fingerprint: card.fingerprint }),
      })
      assert.equal(rejected.status, 200)
      const inspected = ctx.extensionGovernance.inspectApproval(sealed.id)
      assert.equal(inspected?.decision, 'rejected')
      assert.equal(inspected?.fingerprint, requested.fingerprint)
      assert.equal(inspected?.candidateId, sealed.id)

      const second = ctx.candidateWorkspace.create({
        review,
        owner: 'managed/integrations',
        version: '0.3.0',
        baseVersion: '0.1.0',
        manifest: {
          capabilities: ['calendar.read'],
          permissions: ['local.fake.suite'],
          riskModel: googleCalendarReadRiskModel(),
        },
      })
      ctx.candidateWorkspace.writeFile(second.id, 'src/ok.ts', 'export const value: string = "ok"\n')
      ctx.candidateValidation.validate(second.id)
      const sealedSecond = ctx.candidateWorkspace.seal(second.id)
      const requestedSecond = ctx.extensionGovernance.requestApproval(sealedSecond.id)
      const secondView = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      const secondCard = secondView.view.approvals.find((item) => item.candidateId === sealedSecond.id)
      assert.ok(secondCard)
      const approved = await fetch(`${url}/api/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ id: secondCard.id, candidateId: secondCard.candidateId, fingerprint: secondCard.fingerprint }),
      })
      assert.equal(approved.status, 200)
      const approvedRecord = ctx.extensionGovernance.inspectApproval(sealedSecond.id)
      assert.equal(approvedRecord?.decision, 'approved-for-exact-diff')
      assert.equal(approvedRecord?.fingerprint, requestedSecond.fingerprint)
    })
  })

  it('redacts nested secrets and credential-bearing fields at the projection boundary', () => {
    const view = projectMissionControl({
      agentStatus: 'idle',
      safeMode: false,
      recoveryRequired: false,
      pendingConfirmations: [{
        id: 'conf-secret',
        capability: 'files',
        operation: 'delete',
        fingerprint: 'fp-files',
        status: 'pending',
        level: 'L4',
        payload: {
          id: 'f-1',
          access_token: 'ya29.nested-secret',
          description: 'Bearer super.secret.value and https://example.com/?access_token=leak',
        },
      }],
      jobs: [],
      toolEvents: [],
      conversation: [{ kind: 'assistant', text: 'Authorization: Bearer leaked.token.value' }],
      integrationStatus: [{ capability: 'calendar', available: false, reason: 'refresh_token=abc123 leaked' }],
      registry: [],
      memory: [],
      knowledge: [],
      personality: { humor: 40, directness: 70, initiative: 50, verbosity: 'normal', humorSuppressed: false },
    })
    const rendered = JSON.stringify(view)
    assert.doesNotMatch(rendered, /ya29\.nested-secret/)
    assert.doesNotMatch(rendered, /Bearer super\.secret\.value/)
    assert.doesNotMatch(rendered, /access_token=leak/)
    assert.doesNotMatch(rendered, /refresh_token=abc123/)
    assert.doesNotMatch(rendered, /Authorization: Bearer leaked/)
    const card = view.approvals[0]
    assert.equal(card?.details.some((line) => line.includes('access_token')), false)
    assert.match(card?.details.join('\n') ?? '', /\[redacted\]/)
  })

  it('renders frontend scenarios from the authoritative view', () => {
    const ready = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView(),
      connected: true,
      sending: false,
      draft: '',
      onDraft() {},
      onSend() {},
      onApprove() {},
      onReject() {},
      onRecovery() {},
    }))
    assert.match(ready, /data-system-state="READY"/)
    assert.match(ready, /class="console"/)
    assert.match(ready, /Hello/)
    assert.match(ready, /TARS-NG/)
    assert.match(ready, /COMPLETED/)
    assert.match(ready, /Calendar inspected/)
    assert.match(ready, /MEMORY|Memory/)
    assert.match(ready, /data-control-plane="user-workspace"/)
    assert.doesNotMatch(ready, /reasoning_content|sk-secret|chain-of-thought/)

    const working = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({
        systemState: 'WORKING',
        activity: [{ id: 'run', kind: 'RUNNING', summary: 'Calendar inspected', source: 'calendar' }],
        controlStrip: { pendingApprovals: 0, backgroundJobs: 0, mode: 'WORKING' },
      }),
      connected: true,
      sending: true,
      draft: 'queued',
      onDraft() {},
      onSend() {},
      onApprove() {},
      onReject() {},
      onRecovery() {},
    }))
    assert.match(working, /WORKING/)
    assert.match(working, /RUNNING/)

    const approval = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({
        systemState: 'NEEDS_APPROVAL',
        approvals: [{
          id: 'c1',
          kind: 'calendar-create',
          title: 'CREATE CALENDAR EVENT',
          target: 'Personal',
          sideEffect: 'yes',
          authorityChange: 'none',
          details: ['Title Team review'],
          fingerprint: 'fp-calendar',
          status: 'pending',
        }],
        controlStrip: { pendingApprovals: 1, backgroundJobs: 0, mode: 'NEEDS_APPROVAL' },
      }),
      connected: true,
      sending: false,
      draft: '',
      onDraft() {},
      onSend() {},
      onApprove() {},
      onReject() {},
      onRecovery() {},
    }))
    assert.match(approval, /fp-calendar/)
    assert.match(approval, /data-approval-id="c1"/)
    assert.match(approval, /data-fingerprint="fp-calendar"/)
    assert.match(approval, /data-approval-action="approve"/)
    assert.match(approval, /data-approval-action="reject"/)
    assert.match(approval, /APPROVE/)
    assert.match(approval, /REJECT/)
    assert.doesNotMatch(approval, /data-approval-action="approve" disabled/)

    const rejected = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({
        approvals: [{
          id: 'c1',
          kind: 'calendar-create',
          title: 'CREATE CALENDAR EVENT',
          target: 'Personal',
          sideEffect: 'yes',
          authorityChange: 'none',
          details: ['Title Team review'],
          fingerprint: 'fp-calendar',
          status: 'denied',
        }],
      }),
      connected: true,
      sending: false,
      draft: '',
      onDraft() {},
      onSend() {},
      onApprove() {},
      onReject() {},
      onRecovery() {},
    }))
    assert.match(rejected, /Status denied/)
    assert.doesNotMatch(rejected, />APPROVE</)

    const extension = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({
        approvals: [{
          id: 'cand-1',
          kind: 'self-extension',
          title: 'SELF-EXTENSION APPROVAL',
          target: 'generated/search@0.1.0',
          sideEffect: 'network: example.com',
          authorityChange: 'yes — human approval of exact digest/diff required',
          details: ['Candidate cand-1', 'Digest abc', 'Capabilities +search', 'not self-authorization'],
          fingerprint: 'fp-ext',
          status: 'approval-requested',
          candidateId: 'cand-1',
          digest: 'abc',
        }],
      }),
      connected: true,
      sending: false,
      draft: '',
      onDraft() {},
      onSend() {},
      onApprove() {},
      onReject() {},
      onRecovery() {},
    }))
    assert.match(extension, /fp-ext/)
    assert.match(extension, /data-candidate-id="cand-1"/)
    assert.match(extension, /data-fingerprint="fp-ext"/)
    assert.match(extension, /not self-authorization/)

    const degraded = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({
        systemState: 'DEGRADED',
        capabilities: [{ area: 'Search', action: 'web', status: 'unavailable' }],
        controlStrip: { pendingApprovals: 0, backgroundJobs: 0, mode: 'DEGRADED', degradation: 'search unavailable' },
      }),
      connected: true,
      sending: false,
      draft: '',
      onDraft() {},
      onSend() {},
      onApprove() {},
      onReject() {},
      onRecovery() {},
    }))
    assert.match(degraded, /unavailable/)
    assert.match(degraded, /search unavailable/)

    const safe = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({
        systemState: 'SAFE_MODE',
        recovery: {
          why: 'Generated Calendar artifact failed integrity verification.',
          disabled: ['generated/google-calendar@0.1.0'],
          actions: ['Diagnostics', 'Rollback', 'Exit Safe Mode', 'Disable candidate'],
        },
        personality: { humor: 90, directness: 70, initiative: 50, verbosity: 'normal', humorSuppressed: true },
        controlStrip: { pendingApprovals: 0, backgroundJobs: 0, mode: 'SAFE_MODE' },
      }),
      connected: true,
      sending: false,
      draft: '',
      onDraft() {},
      onSend() {},
      onApprove() {},
      onReject() {},
      onRecovery() {},
    }))
    assert.match(safe, /SAFE_MODE/)
    assert.match(safe, /integrity/)
    assert.match(safe, /disabled/)
    assert.match(safe, /data-recovery="true"/)
    assert.match(safe, /data-recovery-action="diagnostics"/)
    assert.match(safe, /data-recovery-action="rollback"/)
    assert.match(safe, /data-recovery-action="exit-safe-mode"/)
    assert.match(safe, /Disable candidate/)
    assert.match(safe, /title="Not available from this Web UI"/)

    const armed = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({
        systemState: 'SAFE_MODE',
        recovery: {
          why: 'Generated Calendar artifact failed integrity verification.',
          disabled: ['generated/google-calendar@0.1.0'],
          actions: ['Diagnostics', 'Rollback', 'Exit Safe Mode'],
        },
        controlStrip: { pendingApprovals: 0, backgroundJobs: 0, mode: 'SAFE_MODE' },
      }),
      connected: true,
      sending: false,
      draft: '',
      armedRecovery: 'rollback',
      onDraft() {},
      onSend() {},
      onApprove() {},
      onReject() {},
      onRecovery() {},
    }))
    assert.match(armed, /Confirm Rollback/)

    const waiting = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({ systemState: 'WAITING', controlStrip: { pendingApprovals: 0, backgroundJobs: 0, mode: 'WAITING' } }),
      connected: true,
      sending: false,
      draft: '',
      onDraft() {},
      onSend() {},
      onApprove() {},
      onReject() {},
      onRecovery() {},
    }))
    assert.match(waiting, /data-system-state="WAITING"/)
    assert.match(waiting, /status-lamp--waiting/)

    const disconnected = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({
        systemState: 'READY',
        approvals: [{
          id: 'c1',
          kind: 'calendar-create',
          title: 'CREATE CALENDAR EVENT',
          target: 'Personal',
          sideEffect: 'yes',
          authorityChange: 'none',
          details: ['Title Team review'],
          fingerprint: 'fp-calendar',
          status: 'pending',
        }],
        recovery: {
          why: 'historical lastFailure must not become current blocking copy',
          disabled: [],
          actions: ['Rollback'],
        },
      }),
      connected: false,
      sending: false,
      draft: 'queued',
      onDraft() {},
      onSend() {},
      onApprove() {},
      onReject() {},
      onRecovery() {},
    }))
    assert.match(disconnected, /Disconnected from local runtime/)
    assert.match(disconnected, /data-system-state="READY"/)
    assert.match(disconnected, /data-connected="no"/)
    assert.match(disconnected, /data-approval-action="approve" disabled/)
    assert.match(disconnected, /data-approval-action="reject" disabled/)
    assert.match(disconnected, /aria-label="Send message" disabled/)
    assert.doesNotMatch(disconnected, /data-recovery="true"/)
    assert.doesNotMatch(disconnected, /historical lastFailure/)

    const longText = 'Paragraph '.repeat(80)
    const longForm = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({ conversation: [{ kind: 'assistant-response', text: longText }] }),
      connected: true,
      sending: false,
      draft: '',
      onDraft() {},
      onSend() {},
      onApprove() {},
      onReject() {},
      onRecovery() {},
    }))
    assert.ok(longForm.includes('Paragraph'))
    assert.doesNotMatch(longForm, /chain-of-thought|sk-secret/)
    assert.match(ready, /href="#memory"/)
    assert.match(ready, /id="memory"/)
  })

  it('keeps essential WUI text readable and narrow-screen Memory reachable', () => {
    const css = readFileSync(join(import.meta.dirname, '../web/src/styles.css'), 'utf8')
    assert.match(css, /--muted:\s*#4f4a40/)
    assert.match(css, /--text-amber:\s*#7a4500/)
    assert.match(css, /\.approval-facts dt \{[^}]*font:[^;]*14px/)
    assert.match(css, /\.activity-item \{[^}]*font:[^;]*14px/)
    assert.match(css, /\.activity-item \.activity-summary \{[^}]*font-size:\s*14px/)
    assert.match(css, /\.capability-list dd \{[^}]*font:[^;]*14px/)
    assert.match(css, /\.capability-action \{[^}]*font:[^;]*14px/)
    assert.match(css, /\.strip-label \{[^}]*font-size:\s*14px/)
    assert.match(css, /\.control-strip strong \{[^}]*font-size:\s*14px/)
    assert.match(css, /\.nav-item:focus-visible \{[^}]*outline:\s*2px solid/)
    assert.doesNotMatch(css, /\.nav-item:focus-visible \{[^}]*outline:\s*none/)
    const narrow = css.slice(css.indexOf('@media (max-width: 820px)'))
    assert.match(narrow, /\.nav-item \{[^}]*font-size:\s*14px/)
    assert.doesNotMatch(narrow, /\.recent[^{]*\{/)
    assert.match(narrow, /\.panel-coordinates, \.nav-panel \.panel-code \{ display: none; \}/)
  })
})
