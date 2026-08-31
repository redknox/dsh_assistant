import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  handleRuntimeControlRequest,
  type RuntimeControlRequest,
  type WebUiRuntimeControl,
} from '../src/product/web-ui-runtime-control.js'

const runId = 'ab'.repeat(32)

function control(onStop: () => void = () => {}): WebUiRuntimeControl {
  return {
    pid: 4321,
    startedAt: '2026-08-27T00:00:00.000Z',
    productVersion: '0.4.0',
    normalizedHome: '/private/tars-ng',
    runId,
    onStop,
    inspectLive: () => ({
      safeMode: false,
      recoveryRequired: false,
      persistence: 'durable',
      skills: {
        profile: 'assistant',
        candidates: 1,
        active: ['calendar'],
        disabled: [],
        failed: [],
        catalog: 'ok',
      },
    }),
  }
}

function request(method: string, pathname: string, body: unknown = {}): RuntimeControlRequest {
  return { method, pathname, readJson: async () => body }
}

describe('Web UI runtime control', () => {
  it('exposes only public identity through unauthenticated health', async () => {
    const result = await handleRuntimeControlRequest(request('GET', '/api/runtime-health'), control())
    assert.deepEqual(result, {
      status: 200,
      body: {
        pid: 4321,
        startedAt: '2026-08-27T00:00:00.000Z',
        productVersion: '0.4.0',
      },
    })
  })

  it('returns live private state only after the run-token challenge', async () => {
    const denied = await handleRuntimeControlRequest(
      request('POST', '/api/runtime-health', { runId: 'cd'.repeat(32) }),
      control(),
    )
    assert.deepEqual(denied, { status: 403, body: { error: 'identity-mismatch' } })

    const trusted = await handleRuntimeControlRequest(
      request('POST', '/api/runtime-health', { runId }),
      control(),
    )
    assert.deepEqual(trusted, {
      status: 200,
      body: {
        pid: 4321,
        startedAt: '2026-08-27T00:00:00.000Z',
        productVersion: '0.4.0',
        normalizedHome: '/private/tars-ng',
        safeMode: false,
        recoveryRequired: false,
        persistence: 'durable',
        skills: {
          profile: 'assistant',
          candidates: 1,
          active: ['calendar'],
          disabled: [],
          failed: [],
          catalog: 'ok',
        },
      },
    })
  })

  it('defers an authenticated stop until the response has been sent', async () => {
    let stopped = false
    const result = await handleRuntimeControlRequest(
      request('POST', '/api/runtime-stop', { runId }),
      control(() => { stopped = true }),
    )
    assert.equal(stopped, false)
    assert.equal(result?.status, 200)
    assert.deepEqual(result?.body, { ok: true, pid: 4321 })
    result?.afterSend?.()
    assert.equal(stopped, true)
  })

  it('declines unrelated routes and reports an unavailable control', async () => {
    assert.equal(await handleRuntimeControlRequest(request('GET', '/api/view'), control()), undefined)
    assert.deepEqual(
      await handleRuntimeControlRequest(request('GET', '/api/runtime-health')),
      { status: 404, body: { error: 'runtime-control-unavailable' } },
    )
  })
})
