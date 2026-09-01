import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'
import { ToolCatalogWorkspace } from '../web/src/ToolCatalogWorkspace.js'

describe('Tool Catalog workspace', () => {
  it('renders the live execution contract and the governed capability-gap entry', () => {
    const markup = renderToStaticMarkup(createElement(ToolCatalogWorkspace, {
      locked: false,
      defineCapability() {},
      catalog: {
        summary: { total: 1, hostManaged: 0, generatedGoverned: 1, thirdPartyGoverned: 0 },
        tools: [{
          name: 'governed_prefix',
          description: 'Prefix text.',
          owner: 'generated/text-prefix',
          version: '0.1.0',
          provenance: 'generated',
          governance: 'generated-governed',
          runtime: 'isolated',
          lifecycle: 'active',
          capabilities: ['text.prefix'],
          permissions: ['host.text.echo'],
          parameters: [{ name: 'text', required: true }],
        }],
      },
    }))

    assert.match(markup, /TOOL CATALOG/)
    assert.match(markup, /DEFINE MISSING CAPABILITY/)
    assert.match(markup, /generated\/text-prefix@0\.1\.0/)
    assert.match(markup, /GENERATED · GOVERNED/)
    assert.match(markup, /host\.text\.echo/)
    assert.match(markup, /NO DIRECT REGISTRATION/)
    assert.match(markup, /Resolution, Candidate validation, Independent Review, approval, and isolated activation/)
  })
})
