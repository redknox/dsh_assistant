import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as knowledgePlugin from '../src/plugins/knowledge-plugin.js'
import * as memoryPlugin from '../src/plugins/memory-plugin.js'
import { bootAssistantRuntime, createAssistantAgent } from '../src/runtime/boot.js'

describe('runtime smoke', () => {
  it('loads and unloads the memory plugin without leaking the service or tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const fiber = ctx.plugin(memoryPlugin)
    await fiber
    assert.ok(ctx.personalMemory)
    assert.ok(ctx.tools.get('remember_memory'))
    assert.ok(ctx.tools.get('forget_memory'))
    assert.ok(ctx.tools.get('recall_memory'))
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
    assert.ok(injected?.text.includes('Selected'))
    await fiber.dispose()
    assert.equal(ctx.get('personalMemory'), undefined)
    assert.equal(ctx.tools.get('remember_memory'), undefined)
  })

  it('loads and unloads the knowledge plugin without leaking retrieval tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const fixture = join(import.meta.dirname, '..', 'fixtures', 'knowledge', 'office-hours.md')
    const fiber = ctx.plugin(knowledgePlugin, { fixturePaths: [fixture] })
    await fiber
    assert.ok(ctx.personalKnowledge)
    assert.ok(ctx.tools.get('retrieve_knowledge'))
    const result = ctx.personalKnowledge.retrieve({ text: 'print confirmation' })
    assert.ok(result.hits[0]?.citation.sourceUri.includes('office-hours.md'))
    await fiber.dispose()
    assert.equal(ctx.get('personalKnowledge'), undefined)
    assert.equal(ctx.tools.get('retrieve_knowledge'), undefined)
  })

  it('boots public DSH composition and creates one assistant agent without a custom loop', async () => {
    const ctx = await bootAssistantRuntime()
    const handle = await createAssistantAgent(ctx, 'smoke-assistant')
    assert.equal(ctx.agents.get(handle.agent.id)?.id, handle.agent.id)
    assert.ok(ctx.personalMemory)
    assert.ok(ctx.personalKnowledge)
    assert.ok(ctx.tools.get('remember_memory'))
    assert.ok(ctx.tools.get('retrieve_knowledge'))
    assert.ok(ctx.tools.get('calendar_list_events'))
    assert.ok(ctx.tools.get('confirm_action'))
    assert.ok(ctx.actionPolicy)
    assert.ok(ctx.assistantJobs)
    assert.ok(ctx.jobs)
    await handle.dispose()
    assert.equal(ctx.agents.get(handle.agent.id), undefined)
    await ctx.fiber.dispose()
  })

  it('keeps personal memory empty after retrieve_knowledge in the full runtime', async () => {
    const fixture = join(import.meta.dirname, '..', 'fixtures', 'knowledge', 'office-hours.md')
    const ctx = await bootAssistantRuntime({ knowledgeFixturePaths: [fixture] })
    const handle = await createAssistantAgent(ctx, 'knowledge-memory-boundary')
    assert.equal(ctx.personalMemory.query().records.length, 0)
    const result = await ctx.tools.execute({
      callId: CallId('test-retrieve-knowledge'),
      name: 'retrieve_knowledge',
      arguments: { query: 'print confirmation' },
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(result.isError, false)
    assert.match(String(result.value), /office-hours/)
    assert.equal(ctx.personalMemory.query().records.length, 0)
    await handle.dispose()
    await ctx.fiber.dispose()
  })
})
