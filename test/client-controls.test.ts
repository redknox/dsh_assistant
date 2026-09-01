import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MissionControlView } from '../src/domain/workspace/types.js'
import { activateGovernedCapability, decideApproval, type UiEnvelope } from '../web/src/api.js'
import { ConversationWorkspace, type ConversationWorkspaceActions } from '../web/src/ConversationWorkspace.js'
import { useConversationControl, type ConversationControl } from '../web/src/useConversationControl.js'
import { useMissionControlRuntime, type MissionControlRuntime } from '../web/src/useMissionControlRuntime.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:8787/' })
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

const originalFetch = globalThis.fetch
const originalEventSource = globalThis.EventSource
const mounted: Root[] = []

afterEach(async () => {
  while (mounted.length > 0) {
    const root = mounted.pop()
    if (root) await act(async () => root.unmount())
  }
  globalThis.fetch = originalFetch
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: originalEventSource })
  dom.window.document.body.replaceChildren()
})

function fixtureView(): MissionControlView {
  return {
    identity: 'TARS-NG',
    systemState: 'READY',
    conversation: [],
    activity: [],
    approvals: [],
    approvalResolutions: [],
    activations: [],
    plugins: [],
    extensions: [],
    capabilities: [],
    memory: [],
    knowledge: [],
    controlStrip: { pendingApprovals: 0, backgroundJobs: 0, mode: 'READY' },
    personality: { humor: 40, directness: 70, initiative: 50, verbosity: 'normal', humorSuppressed: false },
    developmentControlPlaneSeparated: true,
    runtimeContext: {
      profile: 'assistant',
      workspaceLabel: 'Default',
      workspaceIdentity: 'workspace-1',
      sessionId: 'session-1',
      sessionPersistence: 'persistent',
      safeMode: false,
    },
    sessions: {
      schemaVersion: 1,
      revision: 7,
      currentSessionId: 'session-1',
      health: 'ok',
      activeCount: 1,
      archivedCount: 0,
      sessions: [],
    },
  }
}

function envelope(view = fixtureView(), acknowledgement?: { readonly text: string }): UiEnvelope {
  return { view, webUi: 'http://127.0.0.1:8787', ...(acknowledgement ? { acknowledgement } : {}) }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function mountHook<T>(hook: () => T): { readonly current: () => T } {
  let current: T | undefined
  function Harness() {
    current = hook()
    return null
  }
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  const root = createRoot(container)
  mounted.push(root)
  act(() => root.render(createElement(Harness)))
  return {
    current: () => {
      assert.ok(current)
      return current
    },
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('client control hooks', () => {
  it('routes a unified Skill approval card through the exact Skill authority endpoint', async () => {
    const calls: { readonly url: string; readonly body: Record<string, unknown> }[] = []
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return Response.json(envelope())
    }

    await decideApproval({
      id: 'skill-approval:weekly-review@1.0.0',
      kind: 'skill',
      title: 'SKILL APPROVAL',
      target: 'weekly-review@1.0.0',
      sideEffect: 'Agent instructions',
      authorityChange: 'exact Skill revision',
      details: [],
      fingerprint: 'skill-fingerprint',
      digest: 'skill-digest',
      status: 'approval-requested',
      skill: { id: 'weekly-review@1.0.0', name: 'weekly-review', version: '1.0.0', digest: 'skill-digest', approvalFingerprint: 'skill-fingerprint', generation: 4 },
    }, 'approve')

    assert.equal(calls[0]?.url, '/api/skill')
    assert.deepEqual(calls[0]?.body, {
      action: 'approve',
      confirm: true,
      id: 'weekly-review@1.0.0',
      name: 'weekly-review',
      version: '1.0.0',
      digest: 'skill-digest',
      fingerprint: 'skill-fingerprint',
      generation: 4,
      dependents: [],
      acknowledgeDependents: false,
    })
  })

  it('routes a unified Skill activation card through the exact Skill authority endpoint', async () => {
    const calls: { readonly url: string; readonly body: Record<string, unknown> }[] = []
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return Response.json(envelope())
    }

    await activateGovernedCapability({
      id: 'skill-activation:weekly-review@1.0.0:4',
      kind: 'skill-activate',
      title: 'SKILL ACTIVATION',
      owner: 'skill/weekly-review',
      version: '1.0.0',
      candidateId: 'weekly-review@1.0.0',
      digest: 'skill-digest',
      fingerprint: 'skill-fingerprint',
      isolatedRuntime: false,
      capabilitiesAdded: [], capabilitiesRemoved: [], capabilitiesChanged: [],
      permissionsAdded: [], permissionsRemoved: [], permissionsChanged: [],
      toolsAdded: [], toolsRemoved: [], toolsChanged: [],
      workflowsAdded: [], workflowsRemoved: [], workflowsChanged: [],
      effects: [], eligibilityOk: true, eligibilityDenials: [], status: 'APPROVED_NOT_ACTIVE', details: [],
      skill: { id: 'weekly-review@1.0.0', name: 'weekly-review', version: '1.0.0', digest: 'skill-digest', approvalFingerprint: 'skill-fingerprint', generation: 4 },
    }, true)

    assert.equal(calls[0]?.url, '/api/skill')
    assert.deepEqual(calls[0]?.body, {
      action: 'activate', confirm: true, id: 'weekly-review@1.0.0', name: 'weekly-review', version: '1.0.0',
      digest: 'skill-digest', fingerprint: 'skill-fingerprint', generation: 4, dependents: [], acknowledgeDependents: false,
    })
  })

  it('follows growing replies only while the reader remains at the conversation tail', async () => {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.append(container)
    const root = createRoot(container)
    mounted.push(root)
    const actions: ConversationWorkspaceActions = {
      draft() {},
      send() {},
      approve() {},
      reject() {},
      activate() {},
      abandonActivation() {},
      deferActivation() {},
    }
    const renderConversation = (text: string, active: boolean) => root.render(createElement(ConversationWorkspace, {
      view: { ...fixtureView(), conversation: [{ kind: 'assistant-response', text }] },
      active,
      state: { connected: true, sending: true, draft: '', activations: [] },
      actions,
    }))

    await act(async () => renderConversation('Working', true))
    const viewport = container.querySelector<HTMLElement>('[data-follow-tail="true"]')
    assert.ok(viewport)
    let scrollHeight = 900
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 100 })
    viewport.scrollTop = 0

    await act(async () => renderConversation('Working on the answer…', true))
    assert.equal(viewport.scrollTop, 900)

    viewport.scrollTop = 200
    viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }))
    scrollHeight = 1_000
    await act(async () => renderConversation('Working on the longer answer…', true))
    assert.equal(viewport.scrollTop, 200)

    viewport.scrollTop = 900
    viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }))
    scrollHeight = 1_100
    await act(async () => renderConversation('Working on the longest answer yet…', true))
    assert.equal(viewport.scrollTop, 1_100)

    viewport.scrollTop = 300
    viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }))
    await act(async () => renderConversation('Working on the answer…', false))
    assert.equal(viewport.scrollTop, 300)
    await act(async () => renderConversation('Working on the answer…', true))
    assert.equal(viewport.scrollTop, 300)
  })

  it('discovers slash commands in the composer and executes an exact no-argument command', async () => {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.append(container)
    const root = createRoot(container)
    mounted.push(root)
    let sends = 0
    let selected = ''
    const actions: ConversationWorkspaceActions = {
      draft(value) { selected = value },
      send() { sends += 1 },
      approve() {},
      reject() {},
      activate() {},
      abandonActivation() {},
      deferActivation() {},
    }
    const commands = [{ name: 'compact', description: 'Compact older session history.' }, {
      name: 'plan',
      description: 'Control Plan Mode.',
      input: { hint: 'on | off', images: false },
    }]

    await act(async () => root.render(createElement(ConversationWorkspace, {
      view: fixtureView(),
      state: { connected: true, sending: false, draft: '/', commands, activations: [] },
      actions,
    })))
    assert.match(container.textContent ?? '', /COMMAND CONTROL/)
    assert.match(container.textContent ?? '', /\/compact/)
    assert.match(container.textContent ?? '', /\/plan/)

    await act(async () => root.render(createElement(ConversationWorkspace, {
      view: fixtureView(),
      state: { connected: true, sending: false, draft: '/compact', commands, activations: [] },
      actions,
    })))
    const form = container.querySelector('form')
    assert.ok(form)
    await act(async () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
    assert.equal(sends, 1)

    await act(async () => root.render(createElement(ConversationWorkspace, {
      view: fixtureView(),
      state: { connected: true, sending: true, executingCommand: '/compact', draft: '', commands, activations: [] },
      actions,
    })))
    assert.match(container.querySelector('[role="status"]')?.textContent ?? '', /EXECUTING \/compact/)
    assert.equal(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled, true)
    assert.equal(container.querySelector('[aria-label="Slash commands"]'), null)

    await act(async () => root.render(createElement(ConversationWorkspace, {
      view: fixtureView(),
      state: { connected: true, sending: false, draft: '/plan', commands, activations: [] },
      actions,
    })))
    const planOption = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('/plan'))
    assert.ok(planOption)
    await act(async () => planOption.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(selected, '/plan ')
    assert.equal(sends, 1)
  })

  it('locks duplicate sends and preserves input typed while the request is pending', async () => {
    const calls: { readonly url: string; readonly init?: RequestInit }[] = []
    let resolveResponse: ((response: Response) => void) | undefined
    globalThis.fetch = (input, init) => {
      calls.push({ url: String(input), init })
      return new Promise<Response>((resolve) => { resolveResponse = resolve })
    }
    const runtime: Pick<MissionControlRuntime, 'view' | 'commands' | 'perform'> = {
      view: fixtureView(),
      commands: [],
      perform: async (operation) => operation(),
    }
    const hook = mountHook<ConversationControl>(() => useConversationControl(runtime))

    act(() => hook.current().dispatch({ action: 'draft', value: 'first message' }))
    await act(async () => {
      hook.current().dispatch({ action: 'send' })
      hook.current().dispatch({ action: 'send' })
      await flush()
    })
    assert.equal(calls.length, 1)
    assert.equal(hook.current().sending, true)
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      text: 'first message',
      sessionId: 'session-1',
    })

    act(() => hook.current().dispatch({ action: 'draft', value: 'new message' }))
    await act(async () => {
      assert.ok(resolveResponse)
      resolveResponse(jsonResponse(envelope()))
      await flush()
    })
    assert.equal(hook.current().sending, false)
    assert.equal(hook.current().draft, 'new message')
  })

  it('immediately acknowledges a slash command while host execution is pending', async () => {
    let resolveResponse: ((response: Response) => void) | undefined
    globalThis.fetch = () => new Promise<Response>((resolve) => { resolveResponse = resolve })
    const runtime: Pick<MissionControlRuntime, 'view' | 'commands' | 'perform'> = {
      view: fixtureView(),
      commands: [{ name: 'compact', description: 'Compact older session history.' }],
      perform: async (operation) => operation(),
    }
    const hook = mountHook<ConversationControl>(() => useConversationControl(runtime))

    act(() => hook.current().dispatch({ action: 'draft', value: '/compact' }))
    await act(async () => {
      hook.current().dispatch({ action: 'send' })
      await flush()
    })

    assert.equal(hook.current().sending, true)
    assert.equal(hook.current().draft, '', 'the accepted command should leave editing mode immediately')

    await act(async () => {
      assert.ok(resolveResponse)
      resolveResponse(jsonResponse(envelope()))
      await flush()
    })
  })

  it('owns session bootstrap, SSE status, action feedback, and stream cleanup', async (context) => {
    const calls: string[] = []
    globalThis.fetch = async (input) => {
      const url = String(input)
      calls.push(url)
      return url === '/api/session' ? jsonResponse({}) : jsonResponse(envelope())
    }

    class FakeEventSource {
      static current: FakeEventSource | undefined
      readonly listeners = new Map<string, ((event: Event) => void)[]>()
      closed = false

      constructor(readonly url: string) {
        FakeEventSource.current = this
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const callback = typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event)
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback])
      }

      emit(type: string) {
        for (const listener of this.listeners.get(type) ?? []) listener(new dom.window.Event(type))
      }

      close() {
        this.closed = true
      }
    }
    Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeEventSource })
    const hook = mountHook<MissionControlRuntime>(() => useMissionControlRuntime())

    await act(async () => flush())
    assert.deepEqual(calls, ['/api/session', '/api/view'])
    assert.equal(hook.current().view?.identity, 'TARS-NG')
    assert.equal(hook.current().connected, false)
    assert.equal(FakeEventSource.current?.url, '/api/events')

    act(() => FakeEventSource.current?.emit('open'))
    assert.equal(hook.current().connected, true)

    context.mock.timers.enable({ apis: ['setTimeout'] })
    await act(async () => {
      await hook.current().perform(async () => envelope(fixtureView(), { text: 'Saved' }))
    })
    assert.equal(hook.current().acknowledgement?.text, 'Saved')
    act(() => context.mock.timers.tick(4000))
    assert.equal(hook.current().acknowledgement, undefined)

    await act(async () => {
      await hook.current().perform(async () => envelope(fixtureView(), {
        text: 'weekly-review@1.0.0 is live and ready to use.',
        action: { kind: 'open-capability', label: 'VIEW CAPABILITY', capabilityId: 'skill:skill-1' },
      }))
    })
    act(() => context.mock.timers.tick(4000))
    assert.equal(hook.current().acknowledgement?.action?.capabilityId, 'skill:skill-1')
    act(() => hook.current().dismissAcknowledgement())
    assert.equal(hook.current().acknowledgement, undefined)

    await act(async () => {
      await hook.current().perform(async () => { throw new Error('denied') })
    })
    assert.equal(hook.current().error, 'denied')

    const source = FakeEventSource.current
    const root = mounted.pop()
    assert.ok(root)
    await act(async () => root.unmount())
    assert.equal(source?.closed, true)
  })
})
