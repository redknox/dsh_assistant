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
          id: 'spec-2', version: 'capability-specification/v1', revision: 2, supersedesId: 'spec-1', source: 'explicit', digest: 'digest-2', status: 'ready', capability: 'text.echo', goal: 'Echo text exactly.', nonGoals: ['No storage.'], inputs: [{ name: 'text', description: 'Input text.', required: true }], businessRules: ['Preserve whitespace.'], permissions: ['host.text.echo'], effects: { filesystem: [], network: [], process: [], secrets: [], externalSystems: [], remoteSideEffect: 'none' }, acceptanceExamples: [{ name: 'plain text', given: ['hello'], when: 'called', then: ['hello'] }], unresolved: [],
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
    assert.match(markup, /data-specification-action="revise"/)
    assert.doesNotMatch(markup, /data-specification-action="revise" disabled/)
  })
})
