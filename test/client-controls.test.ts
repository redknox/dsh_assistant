import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MissionControlView } from '../src/domain/workspace/types.js'
import type { UiEnvelope } from '../web/src/api.js'
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
  it('locks duplicate sends and preserves input typed while the request is pending', async () => {
    const calls: { readonly url: string; readonly init?: RequestInit }[] = []
    let resolveResponse: ((response: Response) => void) | undefined
    globalThis.fetch = (input, init) => {
      calls.push({ url: String(input), init })
      return new Promise<Response>((resolve) => { resolveResponse = resolve })
    }
    const runtime: Pick<MissionControlRuntime, 'view' | 'perform'> = {
      view: fixtureView(),
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
