import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as memoryPlugin from '../src/plugins/memory-plugin.js'
import { bootAssistantRuntime, createAssistantAgent } from '../src/runtime/boot.js'

describe('runtime smoke', () => {
  it('loads and unloads the memory plugin without leaking the service', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const fiber = ctx.plugin(memoryPlugin)
    await fiber
    assert.ok(ctx.personalMemory)
    ctx.personalMemory.write({
      category: 'preference',
      topicKey: 'drink',
      statement: 'Prefers tea',
      polarity: 'true',
      confidence: { kind: 'unknown' },
      provenance: {
        actor: 'user',
        mechanism: 'explicit_write',
        evidenceIds: [],
        recordedAt: '2026-08-21T00:00:00.000Z',
      },
      visibility: 'model',
      conflictPolicy: 'keep_both',
    })
    const assembly = await ctx.systemPrompt.assemble()
    const injected = assembly.contexts.find((entry) => entry.name === 'personal-memory')
    assert.ok(injected?.text.includes('Prefers tea'))
    await fiber.dispose()
    assert.equal(ctx.get('personalMemory'), undefined)
  })

  it('boots public DSH composition and creates one assistant agent without a custom loop', async () => {
    const ctx = await bootAssistantRuntime()
    const handle = await createAssistantAgent(ctx, 'smoke-assistant')
    assert.equal(ctx.agents.get(handle.agent.id)?.id, handle.agent.id)
    assert.ok(ctx.personalMemory)
    await handle.dispose()
    assert.equal(ctx.agents.get(handle.agent.id), undefined)
    await ctx.fiber.dispose()
  })
})
