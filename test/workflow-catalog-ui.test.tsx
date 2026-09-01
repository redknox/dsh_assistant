import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'
import { WorkflowCatalogWorkspace } from '../web/src/WorkflowCatalogWorkspace.js'

describe('Workflow Catalog workspace', () => {
  it('renders the native contract and the governed capability-gap entry', () => {
    const markup = renderToStaticMarkup(createElement(WorkflowCatalogWorkspace, {
      locked: false,
      defineCapability() {},
      catalog: {
        summary: { total: 1, hostManaged: 1, generatedGoverned: 0, thirdPartyGoverned: 0 },
        workflows: [{
          name: 'parallel-analysis',
          title: 'Parallel analysis',
          description: 'Analyze independent questions.',
          whenToUse: 'Use when questions can be investigated independently.',
          owner: 'managed/workflow-runtime',
          version: '0.1.0',
          provenance: 'managed',
          governance: 'host-managed',
          engine: 'dsh-workflow',
          runtime: 'isolated-process',
          lifecycle: 'active',
          intent: 'read',
          phases: [{ title: 'Analyze' }],
          inputFields: [{ name: 'tasks', required: true }],
          maxTotalAgents: 4,
        }],
      },
    }))

    assert.match(markup, /WORKFLOW CATALOG/)
    assert.match(markup, /DEFINE WORKFLOW CAPABILITY/)
    assert.match(markup, /managed\/workflow-runtime@0\.1\.0/)
    assert.match(markup, /DSH WORKFLOW/)
    assert.match(markup, /ISOLATED-PROCESS/)
    assert.match(markup, /REGISTERED SCRIPTS ONLY/)
    assert.doesNotMatch(markup, /return await agent/)
  })
})
