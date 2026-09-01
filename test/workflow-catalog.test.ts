import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkflowEngine, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import { GovernedWorkflowCatalog } from '../src/domain/workflow-catalog/index.js'

describe('Governed Workflow Catalog', () => {
  it('projects registered native workflows without exposing script text', async () => {
    const starts: WorkflowStartRequest[] = []
    let disposed = false
    const engine = {
      start(request: WorkflowStartRequest) {
        starts.push(request)
        return {
          id: 'workflow-run-1',
          meta: request.meta,
          result: Promise.resolve({ value: { answer: 42 }, stopReason: 'completed' as const, agentsStarted: 2 }),
          cancel() {},
          async dispose() { disposed = true },
        }
      },
    } as unknown as WorkflowEngine
    const catalog = new GovernedWorkflowCatalog(engine, 'governed', 4)
    catalog.register({
      meta: {
        name: 'verified-analysis',
        description: 'Analyze trusted input.',
        whenToUse: 'Use for independent questions.',
        phases: [{ title: 'Analyze', detail: 'Bounded child analysis.' }],
      },
      title: 'Verified analysis',
      script: "return await agent(args.prompt)",
      owner: 'generated/verified-analysis',
      version: '1.0.0',
      provenance: 'generated',
      intent: 'read',
      inputFields: [{ name: 'prompt', required: true }],
      maxInputBytes: 1024,
      maxTotalAgents: 2,
      parseInput(value) { return value },
    })

    const view = catalog.list()
    assert.equal(view.summary.generatedGoverned, 1)
    assert.equal(view.workflows[0]?.name, 'verified-analysis')
    assert.equal(view.workflows[0]?.runtime, 'isolated-process')
    assert.doesNotMatch(JSON.stringify(view), /return await agent/)

    const result = await catalog.execute('verified-analysis', { prompt: 'Question' }, {
      parent: {} as Agent,
      signal: AbortSignal.timeout(1000),
    })
    assert.deepEqual(result, { runId: 'workflow-run-1', agentsStarted: 2, result: { answer: 42 } })
    assert.equal(starts[0]?.script, "return await agent(args.prompt)")
    assert.equal(starts[0]?.subagentProvider, 'governed')
    assert.equal(starts[0]?.maxTotalAgents, 2)
    assert.equal(disposed, true)
  })

  it('rejects duplicate names, invalid limits, unknown runs, and oversized input', async () => {
    const catalog = new GovernedWorkflowCatalog({} as WorkflowEngine, 'governed', 4)
    const definition = {
      meta: { name: 'bounded-work', description: 'Do bounded work.' },
      title: 'Bounded work',
      script: 'return args',
      owner: 'managed/workflows',
      version: '1.0.0',
      provenance: 'managed' as const,
      intent: 'read' as const,
      inputFields: [],
      maxInputBytes: 8,
      maxTotalAgents: 1,
      parseInput(value: unknown) { return value },
    }
    catalog.register(definition)
    assert.throws(() => catalog.register(definition), /already registered/)
    await assert.rejects(() => catalog.execute('missing', {}, { parent: {} as Agent }), /unknown registered workflow/)
    await assert.rejects(() => catalog.execute('bounded-work', { long: 'value' }, { parent: {} as Agent }), /input exceeds/)
  })
})
