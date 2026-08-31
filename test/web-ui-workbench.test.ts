import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { handleWebUiWorkbenchRequest, type WebUiWorkbenchContext } from '../src/product/web-ui-workbench.js'

const SPECIFICATION = {
  id: 'spec-1',
  version: 'capability-specification/v1',
  revision: 1,
  source: 'explicit',
  digest: 'digest-1',
  status: 'ready',
  capability: 'text.echo',
  goal: 'Echo text.',
  nonGoals: [],
  inputs: [],
  businessRules: ['Preserve text.'],
  permissions: ['host.text.echo'],
  effects: { filesystem: [], network: [], process: [], secrets: [], externalSystems: [], remoteSideEffect: 'none' },
  acceptanceExamples: [{ name: 'echo', given: ['text'], when: 'called', then: ['same text'] }],
  unresolved: [],
} as const

describe('Web UI Capability Workbench adapter', () => {
  it('exposes bounded read projections and delegates comparisons to host authority', async () => {
    const context = fakeContext()
    const listed = await handleWebUiWorkbenchRequest(request('GET', '/api/workbench'), context)
    assert.equal(listed?.status, 200)
    assert.equal((listed?.body as { mutable: boolean }).mutable, true)

    const inspected = await handleWebUiWorkbenchRequest(request('GET', '/api/workbench/specification', { id: 'spec-1' }), context)
    assert.deepEqual(inspected?.body, SPECIFICATION)

    const evaluation = await handleWebUiWorkbenchRequest(request('GET', '/api/workbench/evaluation', { id: 'spec-1' }), context)
    assert.equal((evaluation?.body as { report: { status: string } }).report.status, 'passed')

    const compared = await handleWebUiWorkbenchRequest(request('GET', '/api/workbench/compare', { from: 'spec-1', to: 'spec-2' }), context)
    assert.deepEqual((compared?.body as { changedFields: string[] }).changedFields, ['goal'])
  })

  it('keeps Safe Mode read-only and creates revisions through the domain Workbench', async () => {
    let revised = false
    const context = fakeContext(() => { revised = true })
    const denied = await handleWebUiWorkbenchRequest(request('POST', '/api/workbench/specification/revise', {}, {
      specificationId: 'spec-1',
      patch: { goal: 'New goal.' },
    }), { ...context, mutable: false })
    assert.equal(denied?.status, 409)
    assert.equal(revised, false)

    const accepted = await handleWebUiWorkbenchRequest(request('POST', '/api/workbench/specification/revise', {}, {
      specificationId: 'spec-1',
      patch: { goal: 'New goal.' },
    }), context)
    assert.equal(accepted?.status, 200)
    assert.equal(accepted?.broadcast, true)
    assert.equal(revised, true)
  })
})

function fakeContext(onRevise: () => void = () => {}): WebUiWorkbenchContext {
  return {
    mutable: true,
    workbench: {
      list: () => ({ specifications: [SPECIFICATION], plans: [], candidates: [] }) as never,
      inspectSpecification: () => SPECIFICATION as never,
      inspectSpecificationEvaluation: () => ({
        specificationId: 'spec-1',
        specificationDigest: 'digest-1',
        candidateId: 'generated--text-echo@0.1.0',
        report: {
          version: 'capability-evaluation-report/v1',
          candidateId: 'generated--text-echo@0.1.0',
          specificationId: 'spec-1',
          specificationDigest: 'digest-1',
          capability: 'text.echo',
          status: 'passed',
          executed: 1,
          cases: [],
          summary: 'Passed 1 business acceptance case.',
        },
      }),
      defineSpecification: () => SPECIFICATION as never,
      reviseSpecification: () => {
        onRevise()
        return { ...SPECIFICATION, id: 'spec-2', revision: 2, supersedesId: 'spec-1', digest: 'digest-2' } as never
      },
      compareSpecifications: () => ({
        from: { id: 'spec-1', revision: 1, digest: 'digest-1' },
        to: { id: 'spec-2', revision: 2, digest: 'digest-2' },
        changedFields: ['goal'],
        changes: { goal: { before: 'Echo text.', after: 'New goal.' } },
      }),
    },
  }
}

function request(method: string, pathname: string, query: Record<string, string> = {}, body: unknown = {}) {
  return {
    method,
    pathname,
    query: (name: string) => query[name],
    readJson: async () => body,
  }
}
