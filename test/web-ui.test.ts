import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { FakeReplyAdapter } from '../src/adapters/llm/fake-reply-adapter.js'
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
  run: (url: string, surface: AssistantControlSurface, agent: Awaited<ReturnType<typeof createAssistantAgent>>) => Promise<void>,
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
    await run(web.url, surface, agent)
  } finally {
    detach()
    await web.close()
    await agent.dispose()
    await control.ctx.fiber.dispose()
  }
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
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Hello from the Web UI' }),
      })
      assert.equal(sent.status, 202)
      await agent.agent.whenIdle()
      const after = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      assert.ok(after.view, JSON.stringify(after))
      assert.equal(after.view.conversation.some((item) => item.kind === 'user-message' && item.text.includes('Hello from the Web UI')), true)
      assert.equal(after.view.conversation.some((item) => item.kind === 'assistant-response' && item.text.includes('ack')), true)
      assert.equal(surface.workspace().systemState, after.view.systemState)

      const malformed = await fetch(`${url}/api/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nope: true }),
      })
      assert.equal(malformed.status, 400)
      const unknown = await fetch(`${url}/api/launch-missiles`, { method: 'POST', body: '{}' })
      assert.equal(unknown.status, 404)
    })
  })

  it('approves and rejects through the existing policy path', async () => {
    await withServer(bootAssistantControl, 'web-ui-approve', async (url, surface) => {
      const pending = surface.requestExecute('calendar', 'create_event', {
        calendarId: 'Personal',
        title: 'Team review',
        start: '2026-08-22T10:00:00+08:00',
        end: '2026-08-22T10:30:00+08:00',
        attendees: ['ada@example.com'],
      })
      assert.equal(pending.kind, 'pending_confirmation')
      if (pending.kind !== 'pending_confirmation') throw new Error('expected pending')
      const view = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      const card = view.view.approvals.find((item) => item.id === pending.confirmationId)
      assert.equal(card?.kind, 'calendar-create')
      assert.match(card?.fingerprint ?? '', /./)
      assert.match(card?.details.join('\n') ?? '', /Team review/)

      const denied = await fetch(`${url}/api/deny`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: pending.confirmationId }),
      }).then((res) => res.json()) as { view: MissionControlView }
      const after = denied.view.approvals.find((item) => item.id === pending.confirmationId)
      assert.equal(after?.status, 'denied')
      assert.notEqual(after?.status, 'pending')
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
      const view = await fetch(`${web.url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      assert.equal(view.view.systemState === 'SAFE_MODE' || view.view.systemState === 'RECOVERY', true)
      assert.ok(view.view.recovery)
      const blocked = await fetch(`${web.url}/api/recovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'self-authorize' }),
      })
      assert.equal(blocked.status, 409)
      const diagnostics = await fetch(`${web.url}/api/recovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'diagnostics' }),
      })
      assert.equal(diagnostics.status, 200)
    } finally {
      await web.close()
      await control.ctx.fiber.dispose()
    }
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
    assert.match(ready, /Hello/)
    assert.doesNotMatch(ready, /reasoning_content|sk-secret/)

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
    assert.match(approval, /Approve/)
    assert.match(approval, /Reject/)

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
    assert.doesNotMatch(rejected, />Approve</)

    const extension = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({
        approvals: [{
          id: 'cand-1',
          kind: 'self-extension',
          title: 'SELF-EXTENSION APPROVAL',
          target: 'generated/search@0.1.0',
          sideEffect: 'network: example.com',
          authorityChange: 'yes — human approval of exact digest/diff required',
          details: ['Digest abc', 'Capabilities +search', 'not self-authorization'],
          fingerprint: 'fp-ext',
          status: 'approval-requested',
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
          actions: ['Diagnostics', 'Rollback', 'Restart normally', 'Disable candidate'],
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

    const disconnected = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({ systemState: 'READY' }),
      connected: false,
      sending: false,
      draft: '',
      onDraft() {},
      onSend() {},
      onApprove() {},
      onReject() {},
      onRecovery() {},
    }))
    assert.match(disconnected, /Disconnected from local runtime/)
    assert.match(disconnected, /data-system-state="READY"/)

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
  })
})
