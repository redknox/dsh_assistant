import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'
import { CapabilitySpecificationsWorkspace } from '../web/src/CapabilitySpecificationsWorkspace.js'

describe('Capability Specifications workspace', () => {
  it('renders immutable authority, revision diff, and editable business fields', () => {
    const markup = renderToStaticMarkup(createElement(CapabilitySpecificationsWorkspace, {
      locked: false,
      control: {
        snapshot: {
          mutable: true,
          plans: [],
          candidates: [],
          specifications: [{ id: 'spec-2', revision: 2, supersedesId: 'spec-1', capability: 'text.echo', goal: 'Echo text exactly.', status: 'ready', digest: 'digest-2' }],
        },
        selected: {
          id: 'spec-2', version: 'capability-specification/v1', revision: 2, supersedesId: 'spec-1', source: 'explicit', digest: 'digest-2', status: 'ready', capability: 'text.echo', goal: 'Echo text exactly.', nonGoals: ['No storage.'], inputs: [{ name: 'text', description: 'Input text.', required: true }], businessRules: ['Preserve whitespace.'], permissions: ['host.text.echo'], effects: { filesystem: [], network: [], process: [], secrets: [], externalSystems: [], remoteSideEffect: 'none' }, acceptanceExamples: [{ name: 'plain text', given: ['hello'], when: 'called', then: ['hello'], fixture: { input: { text: 'hello' }, expected: 'hello' } }], unresolved: [],
        },
        evaluation: {
          specificationId: 'spec-2', specificationDigest: 'digest-2', candidateId: 'generated--text-echo@0.1.0',
          report: { status: 'passed', executed: 1, summary: 'Passed 1 business acceptance case.', cases: [{ name: 'plain text', status: 'passed', input: { text: 'hello' }, expected: 'hello', actual: 'hello' }] },
        },
        comparison: { from: { id: 'spec-1', revision: 1, digest: 'digest-1' }, to: { id: 'spec-2', revision: 2, digest: 'digest-2' }, changedFields: ['goal'], changes: {} },
        draft: { goal: 'Echo text exactly.', nonGoals: 'No storage.', businessRules: 'Preserve whitespace.', unresolved: '' },
        loading: false,
        saving: false,
        dirty: true,
        load() {}, select() {}, change() {}, saveRevision() {},
      },
    }))
    assert.match(markup, /CAPABILITY SPECIFICATIONS/)
    assert.match(markup, /DOMAIN CONSTRUCTION \/ HOST AUTHORITY/)
    assert.match(markup, /data-specification-diff="true"/)
    assert.match(markup, /host\.text\.echo/)
    assert.match(markup, /CREATE NEW REVISION/)
    assert.match(markup, /EVALUATION EVIDENCE/)
    assert.match(markup, /EXECUTABLE/)
    assert.match(markup, /PASSED/)
    assert.match(markup, /data-specification-action="revise"/)
    assert.doesNotMatch(markup, /data-specification-action="revise" disabled/)
  })

  it('makes a capability gap explicit without claiming a Tool was created', () => {
    const markup = renderToStaticMarkup(createElement(CapabilitySpecificationsWorkspace, {
      locked: false,
      control: {
        snapshot: { mutable: true, plans: [], candidates: [], specifications: [] },
        draft: { goal: '', nonGoals: '', businessRules: '', unresolved: '' },
        creating: true,
        createDraft: {
          capability: 'finance.exchange-rate.query', goal: 'Return a current exchange rate.', nonGoals: '',
          businessRules: 'Cite the rate source.', permissions: 'host.finance.rate.read', remoteSideEffect: 'read-only',
          filesystem: '', network: 'approved provider', process: '', secrets: 'FX_API_KEY', externalSystems: 'FX provider',
          acceptanceName: 'USD to CNY', acceptanceGiven: 'A supported currency pair', acceptanceWhen: 'The Agent requests USD/CNY',
          acceptanceThen: 'Return the rate and source timestamp', unresolved: '',
        },
        canCreate: true,
        loading: false, saving: false, dirty: false,
        load() {}, select() {}, change() {}, saveRevision() {}, beginCreate() {}, cancelCreate() {}, changeCreate() {}, createSpecification() {},
      },
    }))

    assert.match(markup, /CAPABILITY GAP \/ NO TOOL CREATED YET/)
    assert.match(markup, /finance\.exchange-rate\.query/)
    assert.match(markup, /RUNTIME AUTHORITY/)
    assert.match(markup, /INITIAL ACCEPTANCE EXAMPLE/)
    assert.match(markup, /data-specification-action="create"/)
    assert.match(markup, /grants no Tool, permission, installation, or activation authority/)
  })
})
