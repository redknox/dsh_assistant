import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { bootAssistantControl, bootSafeModeRuntime, createAssistantAgent } from '../src/runtime/boot.js'

describe('governed web search', () => {
  it('mounts bounded search only and denies credential-like or oversized outbound queries', async () => {
    const control = await bootAssistantControl({ allowFixtures: true })
    const handle = await createAssistantAgent(control.ctx, 'web-policy')
    try {
      assert.ok(control.ctx.tools.get('web_search'))
      assert.equal(control.ctx.tools.get('web_fetch'), undefined)

      const credential = await control.ctx.tools.execute({
        callId: CallId('web-secret-denial'),
        name: 'web_search',
        arguments: { queries: ['debug authorization: Bearer secret-value-123'] },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(credential.isError, true)
      assert.match(JSON.stringify(credential), /credential-like material/)

      const oversized = await control.ctx.tools.execute({
        callId: CallId('web-size-denial'),
        name: 'web_search',
        arguments: { queries: ['x'.repeat(4097)] },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(oversized.isError, true)
      assert.match(JSON.stringify(oversized), /at most 4096 bytes/)
    } finally {
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('withholds the complete Web seam in Safe Mode', async () => {
    const safe = await bootSafeModeRuntime({ allowFixtures: true })
    try {
      assert.equal(safe.ctx.tools.get('web_search'), undefined)
      assert.equal(safe.ctx.get('web'), undefined)
    } finally {
      await safe.ctx.fiber.dispose()
    }
  })
})
