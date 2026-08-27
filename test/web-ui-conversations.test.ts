import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MissionControlView } from '../src/domain/workspace/types.js'
import { SessionCatalogError } from '../src/product/session-catalog.js'
import {
  handleWebUiConversationRequest,
  type WebUiConversationContext,
} from '../src/product/web-ui-conversations.js'

const view = { identity: 'TARS-NG' } as MissionControlView

function request(pathname: string, body: unknown) {
  return { method: 'POST', pathname, readJson: async () => body }
}

function context(overrides: Partial<WebUiConversationContext> = {}): WebUiConversationContext {
  return {
    currentSessionId: () => 'current',
    sendMessage: () => {},
    project: (acknowledgement) => ({ view, webUi: 'http://127.0.0.1:8787', ...(acknowledgement ? { acknowledgement } : {}) }),
    ...overrides,
  }
}

describe('Web UI conversations', () => {
  it('trims and submits a message to the current session', async () => {
    const sent: string[] = []
    const previews: string[] = []
    const result = await handleWebUiConversationRequest(request('/api/message', {
      text: '  hello  ',
      sessionId: 'current',
    }), context({
      sendMessage: (text) => sent.push(text),
      sessionHost: sessionHost({ touchPreview: (text) => { previews.push(text) } }),
    }))
    assert.equal(result?.status, 202)
    assert.equal(result?.broadcast, true)
    assert.deepEqual(sent, ['hello'])
    assert.deepEqual(previews, ['hello'])
  })

  it('rejects malformed, stale, and routing-busy messages without sending', async () => {
    let sends = 0
    const base = context({ sendMessage: () => { sends += 1 } })
    assert.equal((await handleWebUiConversationRequest(request('/api/message', { text: 'hello' }), base))?.status, 400)
    const stale = await handleWebUiConversationRequest(request('/api/message', {
      text: 'hello',
      sessionId: 'old',
    }), base)
    assert.deepEqual(stale?.body, {
      error: 'stale-session',
      detail: 'request targeted a different current session',
      view,
      webUi: 'http://127.0.0.1:8787',
    })
    const busy = await handleWebUiConversationRequest(request('/api/message', {
      text: 'hello',
      sessionId: 'current',
    }), context({
      sendMessage: () => { sends += 1 },
      sessionHost: sessionHost({
        assertAcceptingMessages: () => { throw new SessionCatalogError('busy', 'route change') },
      }),
    }))
    assert.equal(busy?.status, 409)
    assert.deepEqual(busy?.body, { error: 'busy', detail: 'route change', view, webUi: 'http://127.0.0.1:8787' })
    assert.equal(sends, 0)
  })

  it('dispatches lifecycle commands and preserves their acknowledgement', async () => {
    const calls: unknown[][] = []
    const host = sessionHost({
      create: async (...args) => { calls.push(['create', ...args]) },
      delete: async (...args) => { calls.push(['delete', ...args]) },
    })
    const created = await handleWebUiConversationRequest(request('/api/conversations', {
      action: 'create',
      title: 'Personal',
      sessionId: 'current',
      revision: 4,
    }), context({ sessionHost: host }))
    assert.equal(created?.status, 200)
    assert.deepEqual(calls[0], ['create', 'Personal', { sessionId: 'current', revision: 4 }])
    assert.deepEqual((created?.body as { acknowledgement?: unknown }).acknowledgement, { text: 'Created a new conversation.' })

    await handleWebUiConversationRequest(request('/api/conversations', {
      action: 'delete',
      id: 'old',
      sessionId: 'current',
      revision: 5,
      confirm: true,
    }), context({ sessionHost: host }))
    assert.deepEqual(calls[1], ['delete', 'old', { sessionId: 'current', revision: 5, confirm: true }])
  })

  it('maps unavailable, unsupported, and catalog failures to stable responses', async () => {
    const unavailable = await handleWebUiConversationRequest(request('/api/conversations', {}), context())
    assert.deepEqual(unavailable, {
      status: 409,
      body: { error: 'unavailable', detail: 'session catalog is unavailable' },
    })
    const unsupported = await handleWebUiConversationRequest(request('/api/conversations', {
      action: 'teleport',
      sessionId: 'current',
      revision: 1,
    }), context({ sessionHost: sessionHost() }))
    assert.deepEqual(unsupported, { status: 409, body: { error: 'unsupported', action: 'teleport' } })
    const missing = await handleWebUiConversationRequest(request('/api/conversations', {
      action: 'switch',
      id: 'missing',
      sessionId: 'current',
      revision: 1,
    }), context({
      sessionHost: sessionHost({
        switchTo: async () => { throw new SessionCatalogError('not-found', 'conversation not found') },
      }),
    }))
    assert.equal(missing?.status, 404)
    assert.deepEqual(missing?.body, {
      error: 'not-found',
      detail: 'conversation not found',
      view,
      webUi: 'http://127.0.0.1:8787',
    })
  })
})

function sessionHost(overrides: Record<string, unknown> = {}): NonNullable<WebUiConversationContext['sessionHost']> {
  return {
    assertAcceptingMessages() {},
    touchPreview() {},
    async create() {},
    async switchTo() {},
    async rename() {},
    async archive() {},
    async restore() {},
    async delete() {},
    ...overrides,
  }
}
