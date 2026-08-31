import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FakeReplyAdapter } from '../src/adapters/llm/fake-reply-adapter.js'
import { inspectContextEndurance } from '../src/product/context-endurance.js'
import { productHomeLayout } from '../src/product/home.js'
import { bootAssistantControl, bootSafeModeRuntime, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'

describe('Context Endurance', () => {
  it('mounts native token metering, projections, pruning, and automatic compaction together', async () => {
    const control = await bootAssistantControl()
    try {
      assert.ok(control.ctx.get('sessionProjections'))
      assert.ok(control.ctx.get('tokenMeter'))
      assert.ok(control.ctx.get('toolResultPruner'))
      assert.ok(control.ctx.get('compaction'))
      assert.ok(control.ctx.get('spillStore'))
    } finally {
      await control.ctx.fiber.dispose()
    }
  })

  it('keeps the optional context stack out of Safe Mode', async () => {
    const sessionRoot = mkdtempSync(path.join(tmpdir(), 'tars-safe-checkpoint-'))
    const control = await bootSafeModeRuntime({ sessionRoot })
    try {
      assert.ok(control.ctx.get('sessionPersistence'))
      assert.equal(control.ctx.get('sessionProjections'), undefined)
      assert.equal(control.ctx.get('tokenMeter'), undefined)
      assert.equal(control.ctx.get('toolResultPruner'), undefined)
      assert.equal(control.ctx.get('compaction'), undefined)
      assert.equal(control.ctx.get('spillStore'), undefined)
      assert.equal(inspectContextEndurance(control.ctx, undefined), undefined)
    } finally {
      await control.ctx.fiber.dispose()
    }
  })

  it('checkpoints persisted sessions before model and tool dispatch and fails closed on flush rejection', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'tars-checkpoint-'))
    const sessionRoot = path.join(home, 'sessions')
    const control = await bootAssistantControl({ home, sessionRoot })
    const adapter = new FakeReplyAdapter('checkpointed')
    control.ctx.llm.registerAdapter(['checkpoint-fake'], adapter)
    const handle = await createAssistantAgent(control.ctx, 'checkpoint-owner', { provider: 'checkpoint-fake', model: 'fake' })
    const sessions = control.ctx.sessions as unknown as { flush(session: Session): Promise<boolean> }
    const originalFlush = sessions.flush.bind(control.ctx.sessions)
    let flushes = 0
    let toolBodies = 0
    let durableCallSeen = false
    const unregister = control.ctx.tools.register(defineTool({
      name: 'checkpoint_probe',
      description: 'A tool body that must not run before its checkpoint.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute() {
        toolBodies += 1
        durableCallSeen = (await control.ctx.sessionPersistence.readRaw(handle.agent.session.header.id))?.content.includes('checkpoint-probe-success') === true
        return 'executed'
      },
    }))
    try {
      sessions.flush = async (session) => {
        flushes += 1
        return originalFlush(session)
      }
      for await (const _chunk of control.ctx.llm.stream({
        provider: 'checkpoint-fake',
        model: 'fake',
        messages: [],
        sessionId: handle.agent.session.header.id,
        signal: AbortSignal.timeout(5_000),
      })) {
        // Drain the stream so the lazy pre-request checkpoint executes.
      }
      assert.equal(adapter.invocations, 1)
      assert.ok(flushes >= 1)

      handle.agent.session.append('turn/start', { turn: 0 })
      handle.agent.session.append('step/start', { turn: 0, step: 0 })
      handle.agent.session.append('tool/call', {
        turn: 0,
        step: 0,
        callId: CallId('checkpoint-probe-success'),
        name: 'checkpoint_probe',
        arguments: '{}',
      })
      const executed = await control.ctx.tools.execute({
        callId: CallId('checkpoint-probe-success'),
        name: 'checkpoint_probe',
        arguments: {},
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(executed.isError, false)
      assert.equal(toolBodies, 1)
      assert.equal(durableCallSeen, true)

      sessions.flush = async () => { throw new Error('checkpoint storage unavailable') }
      await assert.rejects(async () => {
        for await (const _chunk of control.ctx.llm.stream({
          provider: 'checkpoint-fake',
          model: 'fake',
          messages: [],
          sessionId: handle.agent.session.header.id,
          signal: AbortSignal.timeout(5_000),
        })) {
          // A rejected checkpoint must prevent the adapter from yielding.
        }
      }, /checkpoint storage unavailable/)
      assert.equal(adapter.invocations, 1)

      const blocked = await control.ctx.tools.execute({
        callId: CallId('checkpoint-probe-call'),
        name: 'checkpoint_probe',
        arguments: {},
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(blocked.isError, true)
      assert.match(blocked.error?.message ?? '', /checkpoint storage unavailable/)
      assert.equal(toolBodies, 1)

      sessions.flush = originalFlush
      const view = inspectContextEndurance(control.ctx, handle.agent.session)
      assert.equal(view?.checkpoint, 'active')
    } finally {
      sessions.flush = originalFlush
      unregister()
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('measures a live session and replaces old surface history with a durable checkpoint', async () => {
    const control = await bootAssistantControl()
    const adapter = new FakeReplyAdapter('compact summary')
    control.ctx.llm.registerAdapter(['fake'], adapter)
    const handle = await createAssistantAgent(control.ctx, 'context-endurance', { provider: 'fake', model: 'fake' })
    try {
      for (let index = 0; index < 4; index += 1) {
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: `Turn ${index}: ${'context '.repeat(500)}` }],
          source: { kind: 'user' },
        }))
        await handle.agent.whenIdle()
      }
      const before = inspectContextEndurance(control.ctx, handle.agent.session)
      assert.equal(before?.status, 'ready')
      assert.equal(before?.compaction, 'automatic')
      assert.ok((before?.measuredTokens ?? 0) > 0)

      const result = await control.ctx.compaction.compactNow(handle.agent, new AbortController().signal)
      assert.ok(result)
      assert.equal(handle.agent.session.events.some((event) => event.type === 'compaction/summary'), true)
      const after = inspectContextEndurance(control.ctx, handle.agent.session)
      assert.equal(after?.status, 'ready')
      assert.ok((after?.measuredTokens ?? Infinity) < (before?.measuredTokens ?? 0))

      const view = new AssistantControlSurface(control.ctx, 'context-endurance').workspace()
      assert.equal(view.contextEndurance?.compaction, 'automatic')
      assert.equal(view.contextEndurance?.status, 'ready')
    } finally {
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('spills a large plain-text result while preserving its canonical value and full private artifact', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'tars-spill-'))
    const control = await bootAssistantControl({ home })
    const handle = await createAssistantAgent(control.ctx, 'spill-owner')
    const full = `BEGIN\n${'tool-output-'.repeat(7_000)}\nEND`
    let artifact = ''
    const unregister = control.ctx.tools.register(defineTool({
      name: 'spill_probe',
      description: 'Return an intentionally large plain-text result.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute() { return full },
    }))
    try {
      const result = await control.ctx.tools.execute({
        callId: CallId('spill-probe-call'),
        name: 'spill_probe',
        arguments: {},
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(result.isError, false)
      assert.equal(result.value, full)
      const rendered = result.content.map((item) => item.type === 'text' ? item.text : '').join('')
      assert.ok(Buffer.byteLength(rendered, 'utf8') <= 50_000)
      assert.match(rendered, /Omitted \d+ bytes/)
      assert.match(rendered, /Full formatted result stored at:/)

      const layout = productHomeLayout(home)
      const sessionDirs = readdirSync(layout.spill, { withFileTypes: true }).filter((item) => item.isDirectory())
      assert.equal(sessionDirs.length, 1)
      const artifacts = readdirSync(path.join(layout.spill, sessionDirs[0]!.name))
      assert.equal(artifacts.length, 1)
      artifact = path.join(layout.spill, sessionDirs[0]!.name, artifacts[0]!)
      assert.equal(readFileSync(artifact, 'utf8'), full)
      assert.equal(statSync(layout.spill).mode & 0o077, 0)
      assert.equal(statSync(artifact).mode & 0o077, 0)

      const view = inspectContextEndurance(control.ctx, handle.agent.session)
      assert.deepEqual(view?.outputRetention, { maxInlineBytes: 50_000, spill: 'ready' })
    } finally {
      unregister()
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
    const resumed = await bootAssistantControl({ home })
    try {
      assert.ok(resumed.ctx.get('spillStore'))
      assert.equal(readFileSync(artifact, 'utf8'), full)
    } finally {
      await resumed.ctx.fiber.dispose()
    }
  })
})
