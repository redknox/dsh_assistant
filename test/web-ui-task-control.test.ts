import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MissionControlView } from '../src/domain/workspace/types.js'
import { handleWebUiTaskControlRequest } from '../src/product/web-ui-task-control.js'

const view = { identity: 'TARS-NG' } as MissionControlView

describe('Web UI Task Control', () => {
  it('binds pause and resume to an exact Goal revision', async () => {
    const calls: unknown[][] = []
    const response = await handleWebUiTaskControlRequest({
      method: 'POST',
      pathname: '/api/task-control',
      readJson: async () => ({ action: 'pause', id: 'goal-1', revision: 3 }),
    }, {
      control: (...args) => calls.push(args),
      project: (acknowledgement) => ({ view, webUi: 'http://127.0.0.1:8787', acknowledgement }),
    })
    assert.deepEqual(calls, [['pause', 'goal-1', 3]])
    assert.equal(response?.status, 200)
    assert.equal(response?.broadcast, true)
    assert.deepEqual((response?.body as { acknowledgement: unknown }).acknowledgement, { text: 'Goal paused.' })
  })

  it('rejects malformed and unrelated requests without invoking authority', async () => {
    let calls = 0
    const context = {
      control: () => { calls += 1 },
      project: (acknowledgement: { readonly text: string }) => ({ view, webUi: '', acknowledgement }),
    }
    assert.equal(await handleWebUiTaskControlRequest({ method: 'GET', pathname: '/api/task-control', readJson: async () => ({}) }, context), undefined)
    for (const body of [
      { action: 'clear', id: 'goal-1', revision: 1 },
      { action: 'resume', id: '', revision: 1 },
      { action: 'resume', id: 'goal-1', revision: 0 },
      { action: 'resume', id: 'goal-1', revision: 1.5 },
    ]) {
      const response = await handleWebUiTaskControlRequest({
        method: 'POST',
        pathname: '/api/task-control',
        readJson: async () => body,
      }, context)
      assert.deepEqual(response, { status: 400, body: { error: 'malformed' } })
    }
    assert.equal(calls, 0)
  })
})
