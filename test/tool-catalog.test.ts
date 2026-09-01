import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { projectToolCatalog } from '../src/domain/tool-catalog/index.js'

describe('Tool Catalog', () => {
  it('attributes the live DSH tool surface to governed Registry owners', () => {
    const catalog = projectToolCatalog([
      {
        name: 'governed_prefix',
        description: 'Prefix text through an approved generated tool.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' }, prefix: { type: 'string' } },
          required: ['text'],
        },
      },
      {
        name: 'recall_memory',
        description: 'Recall durable personal memory.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ], [{
      owner: 'generated/text-prefix',
      version: '0.1.0',
      provenance: { kind: 'generated', origin: 'assistant' },
      status: 'active',
      evidence: 'Verified',
      approval: 'approved-for-this-diff',
      capabilities: [{ id: 'text.prefix', permissions: ['host.text.echo'] }],
      permissions: ['host.text.echo'],
      runtimeSeams: [],
      tools: ['governed_prefix'],
      services: [],
      providers: [],
      pluginDependencies: [],
    }])

    assert.deepEqual(catalog.summary, {
      total: 2,
      hostManaged: 1,
      generatedGoverned: 1,
      thirdPartyGoverned: 0,
    })
    assert.deepEqual(catalog.tools[0], {
      name: 'governed_prefix',
      description: 'Prefix text through an approved generated tool.',
      owner: 'generated/text-prefix',
      version: '0.1.0',
      provenance: 'generated',
      governance: 'generated-governed',
      runtime: 'isolated',
      lifecycle: 'active',
      capabilities: ['text.prefix'],
      permissions: ['host.text.echo'],
      parameters: [{ name: 'prefix', required: false }, { name: 'text', required: true }],
    })
    assert.equal(catalog.tools[1]?.owner, 'dsh/runtime')
    assert.equal(catalog.tools[1]?.governance, 'host-managed')
  })

  it('does not let inactive records claim a live tool and bounds presentation text', () => {
    const catalog = projectToolCatalog([{
      name: 'external_lookup',
      description: 'x'.repeat(800),
      parameters: { type: 'object', properties: {} },
    }], [{
      owner: 'third-party/external',
      version: '1.0.0',
      provenance: { kind: 'third-party', origin: 'import' },
      status: 'candidate',
      evidence: 'Unknown',
      approval: 'unreviewed',
      capabilities: [{ id: 'external.lookup', permissions: [] }],
      permissions: [],
      runtimeSeams: [],
      tools: ['external_lookup'],
      services: [],
      providers: [],
      pluginDependencies: [],
    }])

    assert.equal(catalog.tools[0]?.owner, 'dsh/runtime')
    assert.equal(catalog.tools[0]?.description.length, 400)
    assert.equal(catalog.summary.thirdPartyGoverned, 0)
  })
})
