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
import { GENERATED_EXTENSION_API_V1 } from '../src/domain/workbench/index.js'
import { projectMissionControl } from '../src/domain/workspace/index.js'
import { SimulatedCrashError } from '../src/domain/governance/index.js'
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
    activations: [],
    plugins: [],
    extensions: [],
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
    recoveryRoot: Awaited<ReturnType<typeof bootAssistantControl>>['recoveryRoot'],
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
    await run(web.url, surface, agent, control.ctx, control.recoveryRoot)
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

function generatedPlugin(toolName: string): string {
  return `export const name = 'generated-${toolName.replaceAll('_', '-')}'
export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: '${toolName}',
    description: 'Workbench generated ping',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) { return String(args.text ?? '').toUpperCase() },
  })
  ctx.effect(() => dispose)
}
`
}

function authorGenerated(
  ctx: Awaited<ReturnType<typeof bootAssistantControl>>['ctx'],
  capability: string,
  extra: { readonly pluginDependencies?: readonly { capability: string; strength: 'hard' | 'optional' }[] } = {},
) {
  const toolName = capability.replaceAll('.', '_')
  const plan = ctx.candidateWorkbench.rememberPlan(ctx.capabilityResolution.review({
    capability,
    need: 'WUI activation path',
    inventory: { complete: true, seams: [] },
  }))
  const created = ctx.candidateWorkbench.create({
    planId: plan.planId,
    manifest: { capabilities: [capability], tools: [toolName], entryPoints: ['src/plugin.js'] },
  })
  const manifest = ctx.candidateWorkspace.get(created.id).manifest
  ctx.candidateWorkspace.setManifest(created.id, {
    capabilities: [...manifest.capabilities],
    tools: [...manifest.tools],
    entryPoints: [...manifest.entryPoints],
    runtimeContractVersion: GENERATED_EXTENSION_API_V1,
    ...(extra.pluginDependencies ? { pluginDependencies: [...extra.pluginDependencies] } : {}),
  })
  ctx.candidateWorkbench.writeFile(created.id, 'src/plugin.js', generatedPlugin(toolName))
  ctx.candidateWorkbench.writeFile(created.id, 'package.json', `${JSON.stringify({ name: `dsh-generated-${toolName}`, type: 'module', main: 'src/plugin.js' }, null, 2)}\n`)
  ctx.candidateWorkbench.validate(created.id)
  const sealed = ctx.candidateWorkbench.seal(created.id)
  ctx.candidateWorkbench.review(sealed.id)
  const requested = ctx.extensionGovernance.requestApproval(sealed.id)
  return { id: sealed.id, owner: created.owner, requested }
}

async function approveActivationCard(url: string, cookie: string, candidateId: string) {
  const before = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
  const approval = before.view.approvals.find((item) => item.candidateId === candidateId)
  assert.ok(approval)
  const approved = await fetch(`${url}/api/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
    body: JSON.stringify({ id: approval.id, candidateId: approval.candidateId, fingerprint: approval.fingerprint }),
  })
  assert.equal(approved.status, 200)
  const after = await approved.json() as { view: MissionControlView }
  const card = after.view.activations.find((item) => item.candidateId === candidateId)
  assert.ok(card)
  return card
}

function uninstallBody(plugin: MissionControlView['plugins'][number]) {
  return {
    id: plugin.id,
    owner: plugin.owner,
    version: plugin.version,
    candidateId: plugin.candidateId,
    digest: plugin.digest,
    registryGeneration: plugin.registryGeneration,
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
    await control.recoveryRoot.enterSafeMode(human)
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
    control.ctx.independentReview.reviewCandidate(sealed.id)
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
      ctx.independentReview.reviewCandidate(sealed.id)
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
      ctx.independentReview.reviewCandidate(sealedSecond.id)
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
      assert.equal(ctx.capabilityRegistry.get('managed/integrations', '0.3.0'), undefined)
    })
  })

  it('activates an approved Self-Extension candidate from a distinct WUI confirmation', async () => {
    await withServer(bootAssistantControl, 'web-ui-activate', async (url, _surface, _agent, ctx) => {
      const plan = ctx.candidateWorkbench.rememberPlan(ctx.capabilityResolution.review({
        capability: 'r0.workbench.ping',
        need: 'WUI activation path',
        inventory: { complete: true, seams: [] },
      }))
      const created = ctx.candidateWorkbench.create({
        planId: plan.planId,
        manifest: { capabilities: ['r0.workbench.ping'], tools: ['r0_workbench_ping'], entryPoints: ['src/plugin.js'] },
      })
      const manifest = ctx.candidateWorkspace.get(created.id).manifest
      ctx.candidateWorkspace.setManifest(created.id, {
        capabilities: [...manifest.capabilities],
        tools: [...manifest.tools],
        entryPoints: [...manifest.entryPoints],
        runtimeContractVersion: GENERATED_EXTENSION_API_V1,
      })
      ctx.candidateWorkbench.writeFile(created.id, 'src/plugin.js', `export const name = 'generated-r0-workbench'
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
`)
      ctx.candidateWorkbench.writeFile(created.id, 'package.json', `${JSON.stringify({ name: 'dsh-generated-r0-workbench', type: 'module', main: 'src/plugin.js' }, null, 2)}\n`)
      ctx.candidateWorkbench.validate(created.id)
      const sealed = ctx.candidateWorkbench.seal(created.id)
      ctx.candidateWorkbench.review(sealed.id)
      const requested = ctx.extensionGovernance.requestApproval(sealed.id)
      const cookie = await cookieHeader(url)
      const beforeApprove = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      assert.ok(beforeApprove.view.approvals.find((item) => item.kind === 'self-extension' && item.candidateId === sealed.id))
      assert.equal(beforeApprove.view.activations.length, 0)
      const inspectedRequested = ctx.candidateWorkbench.inspect(sealed.id)
      assert.equal('approvalStatus' in (inspectedRequested.review ?? {}), false)
      assert.equal(inspectedRequested.governanceApproval, 'approval-requested')
      assert.equal(inspectedRequested.activationState, 'inactive')
      assert.doesNotMatch(JSON.stringify(inspectedRequested), /NOT APPROVED/)

      const approvalCard = beforeApprove.view.approvals.find((item) => item.candidateId === sealed.id)
      assert.ok(approvalCard)
      const approved = await fetch(`${url}/api/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ id: approvalCard.id, candidateId: approvalCard.candidateId, fingerprint: approvalCard.fingerprint }),
      })
      assert.equal(approved.status, 200)
      const afterApprove = await approved.json() as { view: MissionControlView }
      assert.equal(afterApprove.view.approvals.some((item) => item.candidateId === sealed.id), false)
      const card = afterApprove.view.activations.find((item) => item.candidateId === sealed.id)
      assert.ok(card)
      assert.equal(card.status, 'APPROVED_NOT_ACTIVE')
      assert.equal(card.digest, requested.summary.digest)
      assert.equal(ctx.capabilityRegistry.get('generated/r0-workbench-ping', '0.1.0'), undefined)
      const projected = afterApprove.view.candidates?.find((item) => item.id === sealed.id)
      assert.equal(projected?.reviewState, 'review-complete')
      assert.equal(projected?.governanceApproval, 'approved-for-exact-diff')
      assert.equal(projected?.activationState, 'inactive')
      assert.equal(projected?.extensionLifecycle, 'APPROVED_NOT_ACTIVE')
      assert.doesNotMatch(JSON.stringify(projected), /NOT APPROVED/)

      const noConfirm = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ id: card.id, candidateId: card.candidateId, digest: card.digest, fingerprint: card.fingerprint }),
      })
      assert.equal(noConfirm.status, 409)
      const untrusted = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: card.id, candidateId: card.candidateId, digest: card.digest, fingerprint: card.fingerprint, confirm: true }),
      })
      assert.equal(untrusted.status, 403)
      const badOrigin = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example', ...authHeaders(cookie) },
        body: JSON.stringify({ id: card.id, candidateId: card.candidateId, digest: card.digest, fingerprint: card.fingerprint, confirm: true }),
      })
      assert.equal(badOrigin.status, 403)
      const wrongDigest = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ id: card.id, candidateId: card.candidateId, digest: 'stale-digest', fingerprint: card.fingerprint, confirm: true }),
      })
      assert.equal(wrongDigest.status, 409)
      const wrongCard = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ id: 'apr-missing', candidateId: card.candidateId, digest: card.digest, fingerprint: card.fingerprint, confirm: true }),
      })
      assert.equal(wrongCard.status, 409)
      assert.equal(ctx.capabilityRegistry.get('generated/r0-workbench-ping', '0.1.0'), undefined)
      assert.equal(ctx.tools.get('approve_extension'), undefined)
      assert.equal(ctx.tools.get('activate_extension'), undefined)
      assert.equal(ctx.tools.get('rollback_extension'), undefined)

      const activated = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ id: card.id, candidateId: card.candidateId, digest: card.digest, fingerprint: card.fingerprint, confirm: true }),
      })
      assert.equal(activated.status, 200, await activated.clone().text())
      const afterActivate = await activated.json() as { view: MissionControlView }
      assert.equal(afterActivate.view.activations.length, 0)
      assert.equal(ctx.capabilityRegistry.get('generated/r0-workbench-ping', '0.1.0')?.status, 'active')
      const replay = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ id: card.id, candidateId: card.candidateId, digest: card.digest, fingerprint: card.fingerprint, confirm: true }),
      })
      assert.equal(replay.status, 409)
    })
  })

  it('rolls back the READY-state system snapshot from a bound WUI card', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tars-rollback-boot-'))
    try {
      await withServer(() => bootAssistantControl({ home }), 'web-ui-rollback', async (url, _surface, _agent, ctx, recoveryRoot) => {
        const cookie = await cookieHeader(url)
        const empty = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
        assert.equal(empty.view.rollback, undefined)
        assert.equal(empty.view.systemState, 'READY')
        const base = authorGenerated(ctx, 'text.slugify')
        const card = await approveActivationCard(url, cookie, base.id)
        assert.equal((await fetch(`${url}/api/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: card.id,
            candidateId: card.candidateId,
            digest: card.digest,
            fingerprint: card.fingerprint,
            confirm: true,
          }),
        })).status, 200)
        assert.ok(ctx.tools.get('text_slugify'))
        const ready = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
        const rollback = ready.view.rollback
        assert.ok(rollback)
        assert.equal(ready.view.systemState, 'READY')
        assert.equal(rollback.title, 'Rollback system state')
        assert.ok(rollback.ownerChanges.some((item) => item.owner === 'generated/text-slugify' && item.change === 'disable'))
        assert.ok(rollback.toolsRemoved.includes('text_slugify'))
        const markup = renderToStaticMarkup(createElement(MissionControlScreen, {
          view: ready.view,
          connected: true,
          sending: false,
          draft: '',
          onDraft() {},
          onSend() {},
          onApprove() {},
          onReject() {},
          onRecovery() {},
        }))
        assert.match(markup, /Rollback system state/)
        assert.match(markup, /not a single-plugin uninstall/)
        assert.match(markup, /data-rollback-action="ask"/)
        const deferred = renderToStaticMarkup(createElement(MissionControlScreen, {
          view: ready.view,
          connected: true,
          sending: false,
          draft: '',
          deferredRollback: true,
          onDraft() {},
          onSend() {},
          onApprove() {},
          onReject() {},
          onRecovery() {},
        }))
        assert.doesNotMatch(deferred, /data-rollback-action="ask"/)
        assert.equal(ctx.tools.get('rollback_extension'), undefined)
        assert.equal(ctx.tools.get('rollback_system_state'), undefined)

        const noConfirm = await fetch(`${url}/api/rollback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: rollback.id,
            fingerprint: rollback.fingerprint,
            currentGeneration: rollback.currentGeneration,
            targetGeneration: rollback.targetGeneration,
          }),
        })
        assert.equal(noConfirm.status, 409)
        const untrusted = await fetch(`${url}/api/rollback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: rollback.id,
            fingerprint: rollback.fingerprint,
            currentGeneration: rollback.currentGeneration,
            targetGeneration: rollback.targetGeneration,
            confirm: true,
          }),
        })
        assert.equal(untrusted.status, 403)
        const badOrigin = await fetch(`${url}/api/rollback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://evil.example', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: rollback.id,
            fingerprint: rollback.fingerprint,
            currentGeneration: rollback.currentGeneration,
            targetGeneration: rollback.targetGeneration,
            confirm: true,
          }),
        })
        assert.equal(badOrigin.status, 403)
        const stale = await fetch(`${url}/api/rollback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: rollback.id,
            fingerprint: 'not-the-fingerprint',
            currentGeneration: rollback.currentGeneration,
            targetGeneration: rollback.targetGeneration,
            confirm: true,
          }),
        })
        assert.equal(stale.status, 409)
        assert.ok(ctx.tools.get('text_slugify'))
        const bypass = await fetch(`${url}/api/recovery`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({ action: 'rollback', confirm: true }),
        })
        assert.equal(bypass.status, 409)
        const bypassBody = await bypass.json() as { error: string }
        assert.equal(bypassBody.error, 'ready-state-rollback')
        assert.ok(ctx.tools.get('text_slugify'))
        ctx.capabilityRegistry.revise('generated/text-slugify', '0.1.0', {
          capabilities: [
            { id: 'text.slugify', permissions: [] },
            { id: 'text.other', permissions: [] },
          ],
        })
        const shifted = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
        assert.ok(shifted.view.rollback)
        assert.notEqual(shifted.view.rollback.fingerprint, rollback.fingerprint)
        const staleMeta = await fetch(`${url}/api/rollback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: rollback.id,
            fingerprint: rollback.fingerprint,
            currentGeneration: rollback.currentGeneration,
            targetGeneration: rollback.targetGeneration,
            confirm: true,
          }),
        })
        assert.equal(staleMeta.status, 409)
        const live = shifted.view.rollback

        let release!: () => void
        recoveryRoot.service.holdRollback = new Promise<void>((resolve) => {
          release = resolve
        })
        const inFlight = fetch(`${url}/api/rollback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: live.id,
            fingerprint: live.fingerprint,
            currentGeneration: live.currentGeneration,
            targetGeneration: live.targetGeneration,
            confirm: true,
          }),
        })
        for (let i = 0; i < 50 && recoveryRoot.inspect().lifecycleBusy !== 'recovery'; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        assert.equal(recoveryRoot.inspect().lifecycleBusy, 'recovery')
        const crossed = await fetch(`${url}/api/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: card.id,
            candidateId: card.candidateId,
            digest: card.digest,
            fingerprint: card.fingerprint,
            confirm: true,
          }),
        })
        assert.equal(crossed.status, 409)
        const crossedBody = await crossed.json() as { error: string }
        assert.equal(crossedBody.error, 'recovery-in-flight')
        release()
        assert.equal((await inFlight).status, 200)
        recoveryRoot.service.holdRollback = undefined
        assert.equal(ctx.tools.get('text_slugify'), undefined)
        assert.equal(ctx.capabilityRegistry.get('generated/text-slugify', '0.1.0')?.status, 'disabled')
        const after = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
        assert.equal(after.view.rollback, undefined)
        const replay = await fetch(`${url}/api/rollback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: rollback.id,
            fingerprint: rollback.fingerprint,
            currentGeneration: rollback.currentGeneration,
            targetGeneration: rollback.targetGeneration,
            confirm: true,
          }),
        })
        assert.equal(replay.status, 409)
        assert.ok(ctx.candidateWorkspace.get(base.id).sealed)
        assert.ok(ctx.extensionGovernance.inspectApproval(base.id))
      })
      const second = await bootAssistantControl({ home })
      try {
        assert.notEqual(second.ctx.capabilityRegistry.get('generated/text-slugify', '0.1.0')?.status, 'active')
        assert.equal(second.ctx.tools.get('text_slugify'), undefined)
        assert.ok(second.ctx.candidateWorkspace.list().some((item) => item.owner === 'generated/text-slugify' && item.sealed))
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('hides the READY rollback card when the target artifact is tampered', async () => {
    await withServer(bootAssistantControl, 'web-ui-rollback-tamper', async (url, _surface, _agent, ctx) => {
      const cookie = await cookieHeader(url)
      const first = authorGenerated(ctx, 'text.slugify')
      const firstCard = await approveActivationCard(url, cookie, first.id)
      assert.equal((await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: firstCard.id,
          candidateId: firstCard.candidateId,
          digest: firstCard.digest,
          fingerprint: firstCard.fingerprint,
          confirm: true,
        }),
      })).status, 200)
      const second = authorGenerated(ctx, 'other.opt')
      const secondCard = await approveActivationCard(url, cookie, second.id)
      assert.equal((await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: secondCard.id,
          candidateId: secondCard.candidateId,
          digest: secondCard.digest,
          fingerprint: secondCard.fingerprint,
          confirm: true,
        }),
      })).status, 200)
      const before = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      assert.ok(before.view.rollback)
      writeFileSync(join(ctx.candidateWorkspace.get(first.id).workspaceRoot, 'src/plugin.js'), 'tampered\n')
      const after = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      assert.equal(after.view.rollback, undefined)
      const denied = await fetch(`${url}/api/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: before.view.rollback.id,
          fingerprint: before.view.rollback.fingerprint,
          currentGeneration: before.view.rollback.currentGeneration,
          targetGeneration: before.view.rollback.targetGeneration,
          confirm: true,
        }),
      })
      assert.equal(denied.status, 409)
      assert.ok(ctx.tools.get('other_opt'))
    })
  })

  it('restores the prior READY snapshot when WUI rollback restore fails', async () => {
    await withServer(bootAssistantControl, 'web-ui-rollback-fail', async (url, _surface, _agent, ctx, recoveryRoot) => {
      const cookie = await cookieHeader(url)
      const base = authorGenerated(ctx, 'text.slugify')
      const card = await approveActivationCard(url, cookie, base.id)
      assert.equal((await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: card.id,
          candidateId: card.candidateId,
          digest: card.digest,
          fingerprint: card.fingerprint,
          confirm: true,
        }),
      })).status, 200)
      const ready = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      assert.ok(ready.view.rollback)
      recoveryRoot.service.failRollback = { phase: 'after-restore', diagnostics: 'secret /Users/secret/home/.tars-ng Bearer sk-rollback-secret-1' }
      const failed = await fetch(`${url}/api/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: ready.view.rollback.id,
          fingerprint: ready.view.rollback.fingerprint,
          currentGeneration: ready.view.rollback.currentGeneration,
          targetGeneration: ready.view.rollback.targetGeneration,
          confirm: true,
        }),
      })
      assert.equal(failed.status, 409)
      const body = await failed.json() as { error: string; diagnostics?: string }
      assert.doesNotMatch(JSON.stringify(body), /sk-rollback-secret-1|\/Users\/secret\/home/)
      assert.ok(ctx.tools.get('text_slugify'))
      assert.equal(ctx.capabilityRegistry.get('generated/text-slugify', '0.1.0')?.status, 'active')
      assert.equal(recoveryRoot.inspect().lifecycleBusy, undefined)
      assert.equal(recoveryRoot.inspect().safeMode, false)
    })
  })

  it('keeps the prior LKG when rollback is interrupted between Registry and authority commit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tars-rollback-interrupt-'))
    try {
      await withServer(() => bootAssistantControl({ home }), 'web-ui-rollback-interrupt', async (url, _surface, _agent, ctx, recoveryRoot) => {
        const cookie = await cookieHeader(url)
        const base = authorGenerated(ctx, 'text.slugify')
        const card = await approveActivationCard(url, cookie, base.id)
        assert.equal((await fetch(`${url}/api/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: card.id,
            candidateId: card.candidateId,
            digest: card.digest,
            fingerprint: card.fingerprint,
            confirm: true,
          }),
        })).status, 200)
        const ready = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
        assert.ok(ready.view.rollback)
        recoveryRoot.simulateInterrupt('rollback-registry-commit')
        const interrupted = await fetch(`${url}/api/rollback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: ready.view.rollback.id,
            fingerprint: ready.view.rollback.fingerprint,
            currentGeneration: ready.view.rollback.currentGeneration,
            targetGeneration: ready.view.rollback.targetGeneration,
            confirm: true,
          }),
        })
        assert.equal(interrupted.status, 409)
        const authority = JSON.parse(readFileSync(join(home, 'self-extension', 'authority.json'), 'utf8')) as {
          registry: { records: { owner: string; status: string }[] }
          recovery: { lastKnownGood?: { owners: { owner: string; status: string }[] } }
        }
        assert.equal(authority.registry.records.some((row) => row.owner === 'generated/text-slugify' && row.status === 'active'), true)
        assert.equal(authority.recovery.lastKnownGood?.owners.some((row) => row.owner === 'generated/text-slugify' && row.status === 'active'), true)
      })
      const second = await bootAssistantControl({ home })
      try {
        const status = second.recoveryRoot.inspect()
        const active = second.ctx.capabilityRegistry.list({ status: 'active' }).map((item) => `${item.owner}@${item.version}`).sort()
        const current = (status.current?.owners ?? []).map((item) => `${item.owner}@${item.version}`).sort()
        assert.deepEqual(active, current)
        assert.equal(status.lifecycleBusy, undefined)
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('uninstalls an active generated plugin from the READY-state WUI without model authority', async () => {
    await withServer(bootAssistantControl, 'web-ui-uninstall', async (url, _surface, _agent, ctx, recoveryRoot) => {
      const cookie = await cookieHeader(url)
      const base = authorGenerated(ctx, 'text.slugify')
      const baseCard = await approveActivationCard(url, cookie, base.id)
      const activated = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: baseCard.id,
          candidateId: baseCard.candidateId,
          digest: baseCard.digest,
          fingerprint: baseCard.fingerprint,
          confirm: true,
        }),
      })
      assert.equal(activated.status, 200, await activated.clone().text())
      assert.ok(ctx.tools.get('text_slugify'))
      const ready = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      assert.equal(ready.view.systemState, 'READY')
      const plugin = ready.view.plugins.find((item) => item.owner === 'generated/text-slugify')
      assert.ok(plugin)
      assert.equal(plugin.uninstallable, true)
      assert.equal(plugin.dependency.severity, 'none')
      assert.equal(ready.view.plugins.some((item) => item.owner.startsWith('managed/')), false)
      const trash = renderToStaticMarkup(createElement(MissionControlScreen, {
        view: ready.view,
        connected: true,
        sending: false,
        draft: '',
        onDraft() {},
        onSend() {},
        onApprove() {},
        onReject() {},
        onRecovery() {},
      }))
      assert.match(trash, /aria-label="Uninstall plugin"/)
      const dialog = renderToStaticMarkup(createElement(MissionControlScreen, {
        view: ready.view,
        connected: true,
        sending: false,
        draft: '',
        confirmingPlugin: plugin.id,
        onDraft() {},
        onSend() {},
        onApprove() {},
        onReject() {},
        onRecovery() {},
      }))
      assert.match(dialog, /Confirm uninstall/)
      assert.match(dialog, new RegExp(`Candidate: ${plugin.candidateId}`))
      assert.match(dialog, new RegExp(`Digest: ${plugin.digest}`))
      assert.doesNotMatch(trash, /data-owner="managed\//)
      assert.equal(ctx.tools.get('uninstall_plugin'), undefined)
      assert.equal(ctx.tools.get('disable_extension'), undefined)

      const noConfirm = await fetch(`${url}/api/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: plugin.id,
          owner: plugin.owner,
          version: plugin.version,
          candidateId: plugin.candidateId,
          digest: plugin.digest,
          registryGeneration: plugin.registryGeneration,
        }),
      })
      assert.equal(noConfirm.status, 409)
      assert.ok(ctx.tools.get('text_slugify'))
      const untrusted = await fetch(`${url}/api/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: plugin.id,
          owner: plugin.owner,
          version: plugin.version,
          candidateId: plugin.candidateId,
          digest: plugin.digest,
          registryGeneration: plugin.registryGeneration,
          confirm: true,
        }),
      })
      assert.equal(untrusted.status, 403)
      const badOrigin = await fetch(`${url}/api/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: plugin.id,
          owner: plugin.owner,
          version: plugin.version,
          candidateId: plugin.candidateId,
          digest: plugin.digest,
          registryGeneration: plugin.registryGeneration,
          confirm: true,
        }),
      })
      assert.equal(badOrigin.status, 403)
      const stale = await fetch(`${url}/api/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: plugin.id,
          owner: plugin.owner,
          version: plugin.version,
          candidateId: plugin.candidateId,
          digest: plugin.digest,
          registryGeneration: plugin.registryGeneration + 99,
          confirm: true,
        }),
      })
      assert.equal(stale.status, 409)
      assert.ok(ctx.tools.get('text_slugify'))

      const hard = authorGenerated(ctx, 'other.dep', {
        pluginDependencies: [{ capability: 'text.slugify', strength: 'hard' }],
      })
      const hardCard = await approveActivationCard(url, cookie, hard.id)
      assert.equal((await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: hardCard.id,
          candidateId: hardCard.candidateId,
          digest: hardCard.digest,
          fingerprint: hardCard.fingerprint,
          confirm: true,
        }),
      })).status, 200)
      const blockedView = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      const blockedPlugin = blockedView.view.plugins.find((item) => item.owner === 'generated/text-slugify')
      assert.ok(blockedPlugin)
      assert.equal(blockedPlugin.dependency.severity, 'hard')
      const blocked = await fetch(`${url}/api/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ ...uninstallBody(blockedPlugin), confirm: true }),
      })
      assert.equal(blocked.status, 409)
      const blockedBody = await blocked.json() as { error: string; denials?: { reason: string; detail: string }[] }
      assert.equal(blockedBody.error, 'uninstall-denied')
      assert.ok(blockedBody.denials?.some((item) => item.reason === 'dependency-blocked'))
      assert.match(JSON.stringify(blockedBody.denials), /generated\/other-dep/)
      assert.ok(ctx.tools.get('text_slugify'))

      const hardPlugin = blockedView.view.plugins.find((item) => item.owner === 'generated/other-dep')
      assert.ok(hardPlugin)
      assert.equal((await fetch(`${url}/api/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ ...uninstallBody(hardPlugin), confirm: true }),
      })).status, 200)
      assert.equal(ctx.tools.get('other_dep'), undefined)
      const afterHard = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      const afterHardPlugin = afterHard.view.plugins.find((item) => item.owner === 'generated/text-slugify')
      assert.ok(afterHardPlugin)
      assert.ok(afterHardPlugin.dependency.dependents.some((item) => item.kind === 'historical' && item.owner === 'generated/other-dep'))
      const historicalDialog = renderToStaticMarkup(createElement(MissionControlScreen, {
        view: afterHard.view,
        connected: true,
        sending: false,
        draft: '',
        confirmingPlugin: afterHardPlugin.id,
        onDraft() {},
        onSend() {},
        onApprove() {},
        onReject() {},
        onRecovery() {},
      }))
      assert.match(historicalDialog, /Historical dependents: generated\/other-dep@0.1.0 required text.slugify/)

      const optional = authorGenerated(ctx, 'other.opt', {
        pluginDependencies: [{ capability: 'text.slugify', strength: 'optional' }],
      })
      const optionalCard = await approveActivationCard(url, cookie, optional.id)
      assert.equal((await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: optionalCard.id,
          candidateId: optionalCard.candidateId,
          digest: optionalCard.digest,
          fingerprint: optionalCard.fingerprint,
          confirm: true,
        }),
      })).status, 200)
      const warnedView = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      const warned = warnedView.view.plugins.find((item) => item.owner === 'generated/text-slugify')
      assert.ok(warned)
      assert.equal(warned.dependency.severity, 'optional')
      const warning = await fetch(`${url}/api/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ ...uninstallBody(warned), confirm: true }),
      })
      assert.equal(warning.status, 409)
      const warningBody = await warning.json() as { error: string; denials?: { reason: string }[] }
      assert.ok(warningBody.denials?.some((item) => item.reason === 'optional-dependents'))
      assert.ok(ctx.tools.get('text_slugify'))
      recoveryRoot.service.failUninstall = { phase: 'after-unload', diagnostics: 'secret /Users/secret/home/.tars-ng Bearer sk-uninstall-secret-999' }
      const afterUnload = await fetch(`${url}/api/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ ...uninstallBody(warned), confirm: true, acknowledgeDependents: true }),
      })
      assert.equal(afterUnload.status, 409)
      const afterUnloadBody = await afterUnload.json() as { error: string; diagnostics?: string }
      assert.equal(afterUnloadBody.error, 'uninstall-failed')
      assert.doesNotMatch(JSON.stringify(afterUnloadBody), /sk-uninstall-secret-999|\/Users\/secret\/home/)
      assert.ok(ctx.tools.get('text_slugify'))
      assert.equal(ctx.capabilityRegistry.get('generated/text-slugify', '0.1.0')?.status, 'active')
      recoveryRoot.service.failUninstall = { phase: 'after-registry', diagnostics: 'registry commit failed' }
      const afterRegistry = await fetch(`${url}/api/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          ...uninstallBody((await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }).view.plugins.find((item) => item.owner === 'generated/text-slugify')!),
          confirm: true,
          acknowledgeDependents: true,
        }),
      })
      assert.equal(afterRegistry.status, 409)
      assert.ok(ctx.tools.get('text_slugify'))
      assert.equal(ctx.capabilityRegistry.get('generated/text-slugify', '0.1.0')?.status, 'active')
      recoveryRoot.service.failUninstall = { phase: 'after-persist', diagnostics: 'authority persist failed' }
      const afterPersist = await fetch(`${url}/api/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          ...uninstallBody((await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }).view.plugins.find((item) => item.owner === 'generated/text-slugify')!),
          confirm: true,
          acknowledgeDependents: true,
        }),
      })
      assert.equal(afterPersist.status, 409)
      assert.ok(ctx.tools.get('text_slugify'))
      assert.equal(ctx.capabilityRegistry.get('generated/text-slugify', '0.1.0')?.status, 'active')
      recoveryRoot.service.failUninstall = undefined

      const latest = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      const target = latest.view.plugins.find((item) => item.owner === 'generated/text-slugify')
      assert.ok(target)
      const acknowledged = await fetch(`${url}/api/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ ...uninstallBody(target), confirm: true, acknowledgeDependents: true }),
      })
      assert.equal(acknowledged.status, 200, await acknowledged.clone().text())
      const after = await acknowledged.json() as { view: MissionControlView }
      assert.equal(after.view.plugins.some((item) => item.owner === 'generated/text-slugify'), false)
      assert.equal(ctx.tools.get('text_slugify'), undefined)
      assert.equal(ctx.capabilityRegistry.get('generated/text-slugify', '0.1.0')?.status, 'disabled')
      assert.ok(ctx.tools.get('other_opt'))
      assert.ok(ctx.candidateWorkspace.get(base.id).sealed)
      const replay = await fetch(`${url}/api/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ ...uninstallBody(target), confirm: true, acknowledgeDependents: true }),
      })
      assert.equal(replay.status, 409)

      const optionalPlugin = (await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }).view.plugins.find((item) => item.owner === 'generated/other-opt')
      assert.ok(optionalPlugin)
      let release!: () => void
      recoveryRoot.service.holdUninstall = new Promise<void>((resolve) => {
        release = resolve
      })
      const inFlight = fetch(`${url}/api/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ ...uninstallBody(optionalPlugin), confirm: true }),
      })
      for (let i = 0; i < 50 && recoveryRoot.inspect().lifecycleBusy !== 'uninstall'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(recoveryRoot.inspect().lifecycleBusy, 'uninstall')
      const recovery = await fetch(`${url}/api/recovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ action: 'rollback', confirm: true }),
        signal: AbortSignal.timeout(3000),
      })
      assert.equal(recovery.status, 409)
      const recoveryBody = await recovery.json() as { error: string }
      assert.equal(recoveryBody.error, 'uninstall-in-flight')
      await assert.rejects(() => recoveryRoot.enterSafeMode(recoveryRoot.issueAuthority({
        kind: 'human-control',
        source: 'application-ui',
      })), /uninstall-in-flight/)
      const unused = authorGenerated(ctx, 'other.idle')
      const unusedCard = await approveActivationCard(url, cookie, unused.id)
      const crossed = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: unusedCard.id,
          candidateId: unusedCard.candidateId,
          digest: unusedCard.digest,
          fingerprint: unusedCard.fingerprint,
          confirm: true,
        }),
      })
      assert.equal(crossed.status, 409)
      const crossedBody = await crossed.json() as { error: string }
      assert.equal(crossedBody.error, 'uninstall-in-flight')
      release()
      assert.equal((await inFlight).status, 200)
      recoveryRoot.service.holdUninstall = undefined
      assert.equal(ctx.tools.get('other_opt'), undefined)
      assert.equal(ctx.tools.get('other_idle'), undefined)
    })
  })

  it('preserves uninstalled generated plugins across a fresh boot of the same home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tars-uninstall-boot-'))
    try {
      await withServer(() => bootAssistantControl({ home }), 'web-ui-uninstall-boot', async (url, _surface, _agent, ctx) => {
        const cookie = await cookieHeader(url)
        const base = authorGenerated(ctx, 'text.slugify')
        const card = await approveActivationCard(url, cookie, base.id)
        assert.equal((await fetch(`${url}/api/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: card.id,
            candidateId: card.candidateId,
            digest: card.digest,
            fingerprint: card.fingerprint,
            confirm: true,
          }),
        })).status, 200)
        const view = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
        const plugin = view.view.plugins.find((item) => item.owner === 'generated/text-slugify')
        assert.ok(plugin)
        assert.equal((await fetch(`${url}/api/uninstall`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({ ...uninstallBody(plugin), confirm: true }),
        })).status, 200)
        assert.equal(ctx.tools.get('text_slugify'), undefined)
      })
      const second = await bootAssistantControl({ home })
      try {
        assert.equal(second.ctx.capabilityRegistry.get('generated/text-slugify', '0.1.0')?.status, 'disabled')
        assert.equal(second.ctx.tools.get('text_slugify'), undefined)
        const leftover = second.ctx.candidateWorkspace.list().find((item) => item.owner === 'generated/text-slugify')
        assert.ok(leftover)
        assert.equal(leftover.sealed, true)
        assert.ok(second.ctx.extensionGovernance.inspectApproval(leftover.id))
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reactivates an exact disabled generated plugin from the Extensions Center', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tars-reactivate-boot-'))
    try {
      await withServer(() => bootAssistantControl({ home }), 'web-ui-reactivate', async (url, _surface, _agent, ctx) => {
        const cookie = await cookieHeader(url)
        const base = authorGenerated(ctx, 'text.slugify')
        const card = await approveActivationCard(url, cookie, base.id)
        assert.equal((await fetch(`${url}/api/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: card.id,
            candidateId: card.candidateId,
            digest: card.digest,
            fingerprint: card.fingerprint,
            confirm: true,
          }),
        })).status, 200)
        const ready = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
        const plugin = ready.view.plugins.find((item) => item.owner === 'generated/text-slugify')
        assert.ok(plugin)
        assert.ok(ctx.tools.get('text_slugify'))
        assert.equal((await fetch(`${url}/api/uninstall`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({ ...uninstallBody(plugin), confirm: true }),
        })).status, 200)
        assert.equal(ctx.tools.get('text_slugify'), undefined)
        const disabled = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
        assert.equal(disabled.view.plugins.some((item) => item.owner === 'generated/text-slugify'), false)
        assert.equal(disabled.view.extensions.find((item) => item.owner === 'generated/text-slugify')?.lifecycle, 'DISABLED_REACTIVATABLE')
      })
      await withServer(() => bootAssistantControl({ home }), 'web-ui-reactivate-restart', async (url, _surface, _agent, ctx) => {
        const cookie = await cookieHeader(url)
        const disabled = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
        const row = disabled.view.extensions.find((item) => item.owner === 'generated/text-slugify')
        assert.ok(row)
        assert.equal(row.lifecycle, 'DISABLED_REACTIVATABLE')
        const reactivate = disabled.view.activations.find((item) => item.candidateId === row.candidateId)
        assert.ok(reactivate)
        assert.equal(reactivate.title, 'Reactivate extension')
        const markup = renderToStaticMarkup(createElement(MissionControlScreen, {
          view: disabled.view,
          pane: 'extensions',
          connected: true,
          sending: false,
          draft: '',
          onDraft() {},
          onSend() {},
          onApprove() {},
          onReject() {},
          onRecovery() {},
        }))
        assert.match(markup, /data-nav="extensions"/)
        assert.match(markup, /data-workspace-pane="extensions"/)
        assert.match(markup, /aria-current="page"/)
        assert.match(markup, /data-extension-lifecycle="DISABLED_REACTIVATABLE"/)
        assert.match(markup, /data-extension-action="reactivate"/)
        assert.equal(ctx.tools.get('activate_extension'), undefined)
        const noConfirm = await fetch(`${url}/api/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: reactivate.id,
            candidateId: reactivate.candidateId,
            digest: reactivate.digest,
            fingerprint: reactivate.fingerprint,
          }),
        })
        assert.equal(noConfirm.status, 409)
        assert.equal((await fetch(`${url}/api/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: reactivate.id,
            candidateId: reactivate.candidateId,
            digest: reactivate.digest,
            fingerprint: reactivate.fingerprint,
            confirm: true,
          }),
        })).status, 200)
        assert.ok(ctx.tools.get('text_slugify'))
        assert.equal(ctx.capabilityRegistry.get('generated/text-slugify', '0.1.0')?.status, 'active')
        const after = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
        assert.ok(after.view.rollback)
        assert.ok(after.view.rollback.ownerChanges.some((item) => item.owner === 'generated/text-slugify' && item.change === 'disable'))
        const replayActivate = await fetch(`${url}/api/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: reactivate.id,
            candidateId: reactivate.candidateId,
            digest: reactivate.digest,
            fingerprint: reactivate.fingerprint,
            confirm: true,
          }),
        })
        assert.equal(replayActivate.status, 409)
        const rolled = await fetch(`${url}/api/rollback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: after.view.rollback.id,
            fingerprint: after.view.rollback.fingerprint,
            currentGeneration: after.view.rollback.currentGeneration,
            targetGeneration: after.view.rollback.targetGeneration,
            confirm: true,
          }),
        })
        assert.equal(rolled.status, 200)
        assert.equal(ctx.tools.get('text_slugify'), undefined)
        assert.equal(ctx.capabilityRegistry.get('generated/text-slugify', '0.1.0')?.status, 'disabled')
        const inactive = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
        assert.equal(inactive.view.extensions.find((item) => item.owner === 'generated/text-slugify')?.lifecycle, 'DISABLED_REACTIVATABLE')
        assert.ok(row.candidateId)
        assert.ok(ctx.extensionGovernance.inspectApproval(row.candidateId))
        assert.equal(ctx.independentReview.status({ id: row.candidateId, digest: row.digest }), 'review-complete')
        const replayRollback = await fetch(`${url}/api/rollback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
          body: JSON.stringify({
            id: after.view.rollback.id,
            fingerprint: after.view.rollback.fingerprint,
            currentGeneration: after.view.rollback.currentGeneration,
            targetGeneration: after.view.rollback.targetGeneration,
            confirm: true,
          }),
        })
        assert.equal(replayRollback.status, 409)
      })
      const second = await bootAssistantControl({ home })
      try {
        assert.equal(second.ctx.capabilityRegistry.get('generated/text-slugify', '0.1.0')?.status, 'disabled')
        assert.equal(second.ctx.tools.get('text_slugify'), undefined)
        const leftover = second.ctx.candidateWorkspace.list().find((item) => item.owner === 'generated/text-slugify')
        assert.ok(leftover)
        assert.equal(leftover.sealed, true)
        assert.ok(second.ctx.extensionGovernance.inspectApproval(leftover.id))
        assert.ok(second.ctx.independentReview.lastReport(leftover.id) || second.ctx.independentReview.status({ id: leftover.id, digest: leftover.digest }))
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rebinds a Retry card after a recoverable activation failure', async () => {
    await withServer(bootAssistantControl, 'web-ui-activate-retry', async (url, _surface, _agent, ctx, recoveryRoot) => {
      const cookie = await cookieHeader(url)
      const prepared = authorGenerated(ctx, 'r0.wui.retry')
      const first = await approveActivationCard(url, cookie, prepared.id)
      recoveryRoot.service.failActivation = { phase: 'prepare', diagnostics: 'transient prepare fault' }
      assert.equal((await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: first.id,
          candidateId: first.candidateId,
          digest: first.digest,
          fingerprint: first.fingerprint,
          confirm: true,
        }),
      })).status, 409)
      const failed = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      const row = failed.view.extensions.find((item) => item.candidateId === prepared.id)
      assert.ok(row)
      assert.equal(row.lifecycle, 'ACTIVATION_FAILED')
      assert.equal(row.eligibilityOk, true)
      const retryA = failed.view.activations.find((item) => item.candidateId === prepared.id)
      assert.ok(retryA)
      assert.equal(retryA.status, 'ACTIVATION_FAILED')
      assert.equal(retryA.title, 'Retry activation')
      assert.notEqual(retryA.id, first.id)
      assert.match(retryA.id, /^act-retry-/)
      const markup = renderToStaticMarkup(createElement(MissionControlScreen, {
        view: failed.view,
        pane: 'extensions',
        connected: true,
        sending: false,
        draft: '',
        onDraft() {},
        onSend() {},
        onApprove() {},
        onReject() {},
        onRecovery() {},
      }))
      assert.match(markup, /data-extension-lifecycle="ACTIVATION_FAILED"/)
      assert.match(markup, /data-extension-action="retry"/)
      assert.equal((await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: retryA.id,
          candidateId: retryA.candidateId,
          digest: retryA.digest,
          fingerprint: retryA.fingerprint,
          confirm: true,
        }),
      })).status, 409)
      const afterSecond = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      const retryB = afterSecond.view.activations.find((item) => item.candidateId === prepared.id)
      assert.ok(retryB)
      assert.notEqual(retryB.id, retryA.id)
      const generationAfterB = recoveryRoot.inspect().current?.generation
      recoveryRoot.service.failActivation = undefined
      assert.equal((await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: retryA.id,
          candidateId: retryA.candidateId,
          digest: retryA.digest,
          fingerprint: retryA.fingerprint,
          confirm: true,
        }),
      })).status, 409)
      assert.equal(recoveryRoot.inspect().current?.generation, generationAfterB)
      assert.equal(ctx.tools.get('r0_wui_retry'), undefined)
      assert.equal((await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: first.id,
          candidateId: first.candidateId,
          digest: first.digest,
          fingerprint: first.fingerprint,
          confirm: true,
        }),
      })).status, 409)
      assert.equal((await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: retryB.id,
          candidateId: retryB.candidateId,
          digest: retryB.digest,
          fingerprint: 'stale-fingerprint',
          confirm: true,
        }),
      })).status, 409)
      assert.equal((await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: retryB.id,
          candidateId: retryB.candidateId,
          digest: retryB.digest,
          fingerprint: retryB.fingerprint,
          confirm: true,
        }),
      })).status, 200)
      assert.ok(ctx.tools.get('r0_wui_retry'))
      assert.equal(ctx.capabilityRegistry.get(prepared.owner, '0.1.0')?.status, 'active')
    })
  })

  it('keeps the prior LKG when uninstall is interrupted between Registry and authority commit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tars-uninstall-atomic-'))
    try {
      const first = await bootAssistantControl({ home })
      try {
        const cookieHome = first
        const base = authorGenerated(cookieHome.ctx, 'text.slugify')
        const human = cookieHome.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
        cookieHome.recoveryRoot.recordApproval(human, {
          candidateId: base.id,
          fingerprint: base.requested.fingerprint,
          decision: 'approved-for-exact-diff',
        })
        await cookieHome.recoveryRoot.activate(base.id, human)
        assert.ok(cookieHome.ctx.tools.get('text_slugify'))
        cookieHome.recoveryRoot.simulateInterrupt('uninstall-registry-commit')
        await assert.rejects(
          () => cookieHome.recoveryRoot.uninstall(human, 'generated/text-slugify', '0.1.0'),
          SimulatedCrashError,
        )
        const authority = JSON.parse(readFileSync(join(home, 'self-extension', 'authority.json'), 'utf8')) as {
          registry: { records: { owner: string; status: string }[] }
          recovery: { lastKnownGood?: { owners: { owner: string; status: string }[] } }
        }
        assert.equal(authority.registry.records.some((row) => row.owner === 'generated/text-slugify' && row.status === 'active'), true)
        assert.equal(authority.recovery.lastKnownGood?.owners.some((row) => row.owner === 'generated/text-slugify' && row.status === 'active'), true)
      } finally {
        await first.ctx.fiber.dispose()
      }
      const second = await bootAssistantControl({ home })
      try {
        assert.equal(second.ctx.capabilityRegistry.get('generated/text-slugify', '0.1.0')?.status, 'active')
        assert.ok(second.ctx.tools.get('text_slugify'))
        assert.equal(second.recoveryRoot.inspect().lastKnownGood?.owners.some((row) => row.owner === 'generated/text-slugify' && row.status === 'active'), true)
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns bounded diagnostics for failed, interrupted, duplicate, and stale-eligibility WUI activation', async () => {
    await withServer(bootAssistantControl, 'web-ui-activate-fail', async (url, _surface, _agent, ctx, recoveryRoot) => {
      const cookie = await cookieHeader(url)
      const leak = 'prepare failed at /Users/secret/home/.tars-ng/candidates/x Bearer sk-ui-secret-value-123456'

      const prepared = authorGenerated(ctx, 'r0.wui.prepare')
      const prepareCard = await approveActivationCard(url, cookie, prepared.id)
      const priorOwners = recoveryRoot.inspect().lastKnownGood?.owners.map((item) => `${item.owner}@${item.version}`).sort() ?? []
      recoveryRoot.service.failActivation = { phase: 'prepare', diagnostics: leak }
      const prepareFail = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: prepareCard.id,
          candidateId: prepareCard.candidateId,
          digest: prepareCard.digest,
          fingerprint: prepareCard.fingerprint,
          confirm: true,
        }),
      })
      assert.equal(prepareFail.status, 409)
      const prepareBody = await prepareFail.json() as {
        error: string
        phase?: string
        diagnostics?: string
        rollbackSucceeded?: boolean
        recoveryRequired?: boolean
        view: MissionControlView
      }
      assert.equal(prepareBody.error, 'activation-failed')
      assert.equal(prepareBody.phase, 'prepare')
      assert.equal(prepareBody.rollbackSucceeded, true)
      assert.equal(prepareBody.recoveryRequired, false)
      assert.match(prepareBody.diagnostics ?? '', /prepare failed/)
      assert.doesNotMatch(JSON.stringify(prepareBody), /sk-ui-secret-value-123456|\/Users\/secret\/home/)
      assert.equal(prepareBody.view.activationFailure?.phase, 'prepare')
      assert.equal(prepareBody.view.activationFailure?.registryActive, false)
      assert.equal(prepareBody.view.activationFailure?.rollbackSucceeded, true)
      assert.ok(prepareBody.view.activity.some((item) => item.kind === 'FAILED' && item.summary.includes('prepare')))
      assert.equal(prepareBody.view.candidates?.find((item) => item.id === prepared.id)?.activationState, 'failed')
      assert.equal(ctx.capabilityRegistry.get(prepared.owner, '0.1.0'), undefined)
      assert.deepEqual(
        recoveryRoot.inspect().lastKnownGood?.owners.map((item) => `${item.owner}@${item.version}`).sort() ?? [],
        priorOwners,
      )
      const refreshed = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      assert.equal(refreshed.view.activationFailure?.candidateId, prepared.id)
      assert.equal(refreshed.view.systemState === 'READY' || refreshed.view.systemState === 'DEGRADED', true)
      recoveryRoot.service.failActivation = undefined

      const health = authorGenerated(ctx, 'r0.wui.health')
      const healthCard = await approveActivationCard(url, cookie, health.id)
      recoveryRoot.service.failActivation = { phase: 'health', diagnostics: 'post-activation health verification failed' }
      const healthFail = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: healthCard.id,
          candidateId: healthCard.candidateId,
          digest: healthCard.digest,
          fingerprint: healthCard.fingerprint,
          confirm: true,
        }),
      })
      assert.equal(healthFail.status, 409)
      const healthBody = await healthFail.json() as { error: string; phase?: string; view: MissionControlView }
      assert.equal(healthBody.error, 'activation-failed')
      assert.equal(healthBody.phase, 'health')
      assert.notEqual(ctx.capabilityRegistry.get(health.owner, '0.1.0')?.status, 'active')
      recoveryRoot.service.failActivation = undefined

      const commit = authorGenerated(ctx, 'r0.wui.commit')
      const commitCard = await approveActivationCard(url, cookie, commit.id)
      recoveryRoot.service.failActivation = { phase: 'commit', diagnostics: 'authority commit failed' }
      const commitFail = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: commitCard.id,
          candidateId: commitCard.candidateId,
          digest: commitCard.digest,
          fingerprint: commitCard.fingerprint,
          confirm: true,
        }),
      })
      assert.equal(commitFail.status, 409)
      const commitBody = await commitFail.json() as { error: string; phase?: string; rollbackSucceeded?: boolean; view: MissionControlView }
      assert.equal(commitBody.error, 'activation-failed')
      assert.equal(commitBody.phase, 'commit')
      assert.equal(commitBody.rollbackSucceeded, true)
      assert.notEqual(ctx.capabilityRegistry.get(commit.owner, '0.1.0')?.status, 'active')
      recoveryRoot.service.failActivation = undefined

      const interrupted = authorGenerated(ctx, 'r0.wui.interrupt')
      const interruptCard = await approveActivationCard(url, cookie, interrupted.id)
      recoveryRoot.simulateInterrupt('prepare')
      const crashed = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: interruptCard.id,
          candidateId: interruptCard.candidateId,
          digest: interruptCard.digest,
          fingerprint: interruptCard.fingerprint,
          confirm: true,
        }),
      })
      assert.equal(crashed.status, 409)
      const crashBody = await crashed.json() as { error: string; view: MissionControlView }
      assert.equal(crashBody.error, 'activation-interrupted')
      assert.notEqual(recoveryRoot.inspect().state, 'active')
      recoveryRoot.completeInterruptedActivation()
      recoveryRoot.service.interruptAfter = undefined

      const duplicate = authorGenerated(ctx, 'r0.wui.duplicate')
      const duplicateCard = await approveActivationCard(url, cookie, duplicate.id)
      let release!: () => void
      recoveryRoot.service.holdActivation = new Promise<void>((resolve) => {
        release = resolve
      })
      const first = fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: duplicateCard.id,
          candidateId: duplicateCard.candidateId,
          digest: duplicateCard.digest,
          fingerprint: duplicateCard.fingerprint,
          confirm: true,
        }),
      })
      for (let i = 0; i < 50 && recoveryRoot.inspect().state !== 'activation-pending'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(recoveryRoot.inspect().state, 'activation-pending')
      const second = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: duplicateCard.id,
          candidateId: duplicateCard.candidateId,
          digest: duplicateCard.digest,
          fingerprint: duplicateCard.fingerprint,
          confirm: true,
        }),
      })
      assert.equal(second.status, 409)
      const secondBody = await second.json() as { error: string }
      assert.equal(secondBody.error, 'activation-in-flight')
      release()
      const firstRes = await first
      assert.equal(firstRes.status, 200, await firstRes.clone().text())
      assert.equal(ctx.capabilityRegistry.get(duplicate.owner, '0.1.0')?.status, 'active')
      recoveryRoot.service.holdActivation = undefined

      const stale = authorGenerated(ctx, 'r0.wui.stale')
      const staleCard = await approveActivationCard(url, cookie, stale.id)
      const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
      await recoveryRoot.enterSafeMode(human)
      const afterSafe = await fetch(`${url}/api/view`).then((res) => res.json()) as { view: MissionControlView }
      const stillPending = afterSafe.view.activations.find((item) => item.candidateId === stale.id)
      assert.ok(stillPending)
      assert.equal(stillPending.status, 'APPROVED_NOT_ACTIVE')
      assert.equal(stillPending.eligibilityOk, false)
      const denied = await fetch(`${url}/api/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({
          id: staleCard.id,
          candidateId: staleCard.candidateId,
          digest: staleCard.digest,
          fingerprint: staleCard.fingerprint,
          confirm: true,
        }),
      })
      assert.equal(denied.status, 409)
      const deniedBody = await denied.json() as { error: string; denials?: { reason: string }[]; view: MissionControlView }
      assert.equal(deniedBody.error, 'activation-denied')
      assert.ok(deniedBody.denials?.some((item) => item.reason === 'safe-mode'))
      assert.notEqual(deniedBody.view.systemState === 'SAFE_MODE' ? 'SAFE_MODE' : '', '')
      assert.notEqual(ctx.capabilityRegistry.get(stale.owner, '0.1.0')?.status, 'active')
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

    const activation = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({
        activations: [{
          id: 'apr-act',
          kind: 'self-extension-activate',
          title: 'SELF-EXTENSION ACTIVATION',
          owner: 'generated/search',
          version: '0.1.0',
          candidateId: 'cand-1',
          digest: 'abc',
          fingerprint: 'fp-ext',
          isolatedRuntime: true,
          capabilitiesAdded: [],
          capabilitiesRemoved: [],
          capabilitiesChanged: ['search'],
          permissionsAdded: [],
          permissionsRemoved: [],
          permissionsChanged: [],
          toolsAdded: [],
          toolsRemoved: [],
          toolsChanged: ['web_search'],
          effects: ['network: example.com'],
          eligibilityOk: true,
          eligibilityDenials: [],
          status: 'APPROVED_NOT_ACTIVE',
          details: ['Approval did not activate this candidate.'],
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
    assert.match(activation, /data-activation-id="apr-act"/)
    assert.match(activation, /data-activation-action="activate"/)
    assert.match(activation, /data-activation-action="defer"/)
    assert.match(activation, /~search/)
    assert.match(activation, /~web_search/)
    assert.match(activation, /ACTIVATE/)
    assert.match(activation, /NOT NOW/)
    assert.doesNotMatch(activation, /NOT APPROVED/)

    const extensionsPane = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({
        approvals: [{
          id: 'apr-req',
          kind: 'self-extension',
          title: 'SELF-EXTENSION APPROVAL',
          target: 'generated/search@0.1.0',
          sideEffect: 'none',
          authorityChange: 'yes',
          details: [],
          fingerprint: 'fp-req',
          status: 'approval-requested',
          candidateId: 'cand-req',
        }],
        activations: [{
          id: 'apr-act-ext',
          kind: 'self-extension-activate',
          title: 'Reactivate extension',
          owner: 'generated/search',
          version: '0.1.0',
          candidateId: 'cand-off',
          digest: 'abc',
          fingerprint: 'fp-off',
          isolatedRuntime: true,
          capabilitiesAdded: [],
          capabilitiesRemoved: [],
          capabilitiesChanged: [],
          permissionsAdded: [],
          permissionsRemoved: [],
          permissionsChanged: [],
          toolsAdded: [],
          toolsRemoved: [],
          toolsChanged: [],
          effects: [],
          eligibilityOk: true,
          eligibilityDenials: [],
          status: 'DISABLED_REACTIVATABLE',
          details: [],
        }, {
          id: 'act-retry-apr-fail',
          kind: 'self-extension-activate',
          title: 'Retry activation',
          owner: 'generated/search',
          version: '0.0.3',
          candidateId: 'cand-fail',
          digest: 'abc',
          fingerprint: 'fp-fail',
          isolatedRuntime: true,
          capabilitiesAdded: [],
          capabilitiesRemoved: [],
          capabilitiesChanged: [],
          permissionsAdded: [],
          permissionsRemoved: [],
          permissionsChanged: [],
          toolsAdded: [],
          toolsRemoved: [],
          toolsChanged: [],
          effects: [],
          eligibilityOk: true,
          eligibilityDenials: [],
          status: 'ACTIVATION_FAILED',
          details: [],
        }],
        plugins: [{
          id: 'uninst-generated/search@0.2.0',
          owner: 'generated/search',
          version: '0.2.0',
          provenance: 'generated',
          mounted: true,
          registryGeneration: 1,
          capabilities: ['search'],
          tools: ['web_search'],
          dependency: { severity: 'none', dependents: [] },
          uninstallable: true,
        }],
        activationFailure: {
          candidateId: 'cand-fail',
          phase: 'prepare',
          summary: 'bounded',
          rollbackSucceeded: true,
          recoveryRequired: false,
          registryActive: false,
        },
        extensions: [
          { id: 'ext-req', owner: 'generated/search', version: '0.0.1', candidateId: 'cand-req', provenance: 'generated', capabilities: [], tools: [], lifecycle: 'APPROVAL_REQUIRED', registryStatus: 'absent', mounted: false, eligibilityOk: false, eligibilityDenials: ['review-required'], newerAuthoritative: false },
          { id: 'ext-off', owner: 'generated/search', version: '0.1.0', candidateId: 'cand-off', provenance: 'generated', capabilities: [], tools: [], lifecycle: 'DISABLED_REACTIVATABLE', registryStatus: 'disabled', mounted: false, eligibilityOk: true, eligibilityDenials: [], newerAuthoritative: false },
          { id: 'ext-on', owner: 'generated/search', version: '0.2.0', provenance: 'generated', capabilities: [], tools: [], lifecycle: 'ACTIVE', registryStatus: 'active', mounted: true, eligibilityOk: false, eligibilityDenials: [], newerAuthoritative: false },
          { id: 'ext-block', owner: 'generated/search', version: '0.0.2', provenance: 'generated', capabilities: [], tools: [], lifecycle: 'DISABLED_BLOCKED', registryStatus: 'disabled', mounted: false, eligibilityOk: false, eligibilityDenials: ['approval-rejected'], newerAuthoritative: false },
          { id: 'ext-fail', owner: 'generated/search', version: '0.0.3', candidateId: 'cand-fail', provenance: 'generated', capabilities: [], tools: [], lifecycle: 'ACTIVATION_FAILED', registryStatus: 'absent', mounted: false, eligibilityOk: true, eligibilityDenials: [], newerAuthoritative: false },
          { id: 'ext-old', owner: 'generated/search', version: '0.0.0', provenance: 'generated', capabilities: [], tools: [], lifecycle: 'SUPERSEDED', registryStatus: 'disabled', mounted: false, eligibilityOk: false, eligibilityDenials: [], newerAuthoritative: true },
        ],
      }),
      pane: 'extensions',
      connected: true,
      sending: false,
      draft: '',
      onDraft() {},
      onSend() {},
      onApprove() {},
      onReject() {},
      onRecovery() {},
    }))
    assert.match(extensionsPane, /data-workspace-pane="extensions"/)
    assert.match(extensionsPane, /data-nav="extensions"[^>]*aria-current="page"/)
    assert.match(extensionsPane, /data-extension-lifecycle="APPROVAL_REQUIRED"[^]*data-extension-action="approve"/)
    assert.match(extensionsPane, /data-extension-action="reject"/)
    assert.match(extensionsPane, /data-extension-action="reactivate"/)
    assert.match(extensionsPane, /data-uninstall-action="ask"/)
    assert.match(extensionsPane, /data-extension-action="inspect-denials"/)
    assert.match(extensionsPane, /data-extension-action="diagnostics"/)
    assert.match(extensionsPane, /data-extension-action="retry"/)
    assert.match(extensionsPane, /data-extension-action="view-history"/)

    const workbench = renderToStaticMarkup(createElement(MissionControlScreen, {
      view: fixtureView({
        candidates: [{
          id: 'cand-wb',
          owner: 'generated/r0-workbench-ping',
          version: '0.1.0',
          lifecycle: 'validated',
          resolutionKind: 'new-plugin',
          resolutionCapability: 'r0.workbench.ping',
          sealed: true,
          validationPassed: true,
          reviewState: 'review-complete',
          blockingFindings: 0,
          canRequestApproval: true,
          currentStep: 'request',
          approvalState: 'ready-for-approval',
          validationFailureSummary: undefined,
          effectSummary: [
            'remote-side-effect mutate',
            'calendar.google',
            'workspace/notes',
            'https://example.com',
            'child_process',
            'secret-access CALENDAR_TOKEN',
          ],
          diff: {
            owner: 'generated/r0-workbench-ping',
            candidateVersion: '0.1.0',
            capabilities: { added: ['r0.workbench.ping'], removed: [], changed: [] },
            permissions: { added: [], removed: [], changed: [] },
            tools: { added: ['r0_workbench_ping'], removed: [], changed: [] },
            services: { added: [], removed: [], changed: [] },
            providers: { added: [], removed: [], changed: [] },
            runtimeSeams: { added: [], removed: [], changed: [] },
            effects: {
              filesystem: ['workspace/notes'],
              network: ['https://example.com'],
              process: ['child_process'],
              secrets: ['CALENDAR_TOKEN'],
              externalSystems: ['calendar.google'],
              remoteSideEffect: 'mutate',
            },
          },
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
    assert.match(workbench, /data-workbench="true"/)
    assert.match(workbench, /data-candidate-id="cand-wb"/)
    assert.match(workbench, /generated\/r0-workbench-ping@0.1.0/)
    assert.match(workbench, /r0.workbench.ping/)
    assert.match(workbench, /can request approval/)
    assert.match(workbench, /step request/)
    assert.match(workbench, /ready for approval/)
    assert.match(workbench, /\+r0.workbench.ping/)
    assert.match(workbench, /remote-side-effect mutate/)
    assert.match(workbench, /workspace\/notes/)
    assert.match(workbench, /https:\/\/example.com/)
    assert.match(workbench, /child_process/)
    assert.match(workbench, /secret-access CALENDAR_TOKEN/)
    assert.match(workbench, /calendar.google/)

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
